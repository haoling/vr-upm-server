# unitypackage → UPM 変換・Verdaccio公開 管理画面 ざっくり設計

## 1. 目的

- BOOTH等で入手した `.unitypackage` をアップロードし、UPMパッケージ(npm tarball)に変換して、自前のVerdaccioにpublishする
- Unityプロジェクト側は `Packages/manifest.json` の scopedRegistries と依存定義だけをgitで管理し、アセット本体はgitに入れない
- 元アセットは読み取り専用(Library/PackageCache)として扱い、改変はNDMF等による非破壊で行う前提
- 変換時の調整(同梱物の除外、.metaのインポート設定パッチ等)を設定として保存し、再ビルドで同じ結果を再現できるようにする

### 非ゴール

- 公開配布(あくまで自分専用の非公開レジストリ)
  - ネットワーク的には外部(インターネット)から到達可能にする(家の外からも使うため)
  - 権限的には自分専用にする。認証を通らない限り、管理画面・レジストリのどちらも中身を見られないようにする
- Unity Editor拡張の開発(必要になったら別途)
- アセットの中身の編集機能

## 2. 全体構成

```
            ┌───────────── インターネット ─────────────┐
[Browser] ──┼─> [認証プロキシ(OIDC)] ──> [管理画面 Web UI]
            │                              │ REST
            │                              ▼
            │                         [API Server] ──> [PVC: db (SQLite)]
            │                              │  ├──> [PVC: workspace (元unitypackage / ビルド作業領域)]
            │                              │  └──> [Job Queue]
            │                              ▼
            │                         [Converter Worker] ── npm publish(クラスタ内) ──> [Verdaccio]
            │                                                                            ▲
[Unity] ────┼─> [Ingress(TLS)] ── scopedRegistries + token ────────────────────────────┘
            └──────────────────────────────────────────┘
```

- 外部に公開するエンドポイントは「管理画面」と「Verdaccio」の2つだけ。どちらもTLS必須
- DB・Worker・Verdaccioのストレージはクラスタ内からのみ到達可能にする(Ingressを作らない)

- 想定デプロイ先: 自宅k8s(ArgoCDで管理)。Verdaccioも同じクラスタに置く
- API と Worker は同じコードベースで、起動モードだけ分ける構成でもよい(MVPは同一プロセスでもOK)
- DBはSQLite(シングルユーザー・小規模のため)。k8sではPVC上に置き、replicas=1で運用する
  - SQLiteを使う関係でAPIとWorkerは同一Podにまとめるのが無難(別Podにするならジョブ状態の受け渡しを要検討)

### 2.1 ストレージ

Object Storage(MinIO等)は使わず、用途ごとに2つのPVCに分ける。

| PVC | storageClass | バックアップ | 中身 |
|---|---|---|---|
| `db` | `serv12-d` | 世代バックアップあり | SQLite(設定・ビルド履歴・GUIDインデックス等、失うと困る小さなデータ) |
| `workspace` | `serv12-d` | なし(世代管理の対象外) | 元unitypackage、展開・tarball生成の作業領域(消えても復旧できるデータ) |

- `workspace` はunitypackageの展開とtarball生成でI/Oが多いため、容量より速度を優先して `serv12-d` に置く
  - 世代バックアップの対象にはしないので、`db` とは別のPVCにする
- `workspace` 内のディレクトリ構成
  - `uploads/<sha256>.unitypackage`: 元ファイル(アーカイブ・削除されるまで保持)
  - `builds/<build_id>/`: 展開物と生成tarball(ビルドごとの一時ディレクトリ。publish後・破棄時に削除。起動時に残骸を掃除する)

- **`workspace` は消えてもよい前提で作る**。元unitypackageはLTOテープ等へ手動でコールドアーカイブし、PVCから削除する運用もあり得る
  - DBには元ファイルのsha256・ファイル名・サイズ・解析結果を残すので、元ファイルが無くても一覧・設定編集・履歴閲覧はできる
  - 元ファイルが必要になる操作(再ビルド等)は、同じファイルを再アップロードすると sha256 で既存のUploadに再び紐付き、そのまま続行できる(3.4)
- **生成tarballは保存しない**。ビルドのたびに `workspace` の作業領域で作り、publish後(または破棄時)に消す
  - publish済みのtarballが必要なときは Verdaccio から取得する(前バージョンとの差分表示など)
  - Verdaccioのストレージが失われても、DBの設定スナップショット + 元ファイルから同じtarballを再ビルドして再publishできるようにする。そのためビルドは決定的にする(同じ入力・同じ設定なら同じ中身。tarのmtime・エントリ順を固定する)
- SQLiteのバックアップは `serv12-d` の世代バックアップに任せる(Litestream等は使わない)
  - 稼働中のDBファイルをそのままコピーすると壊れた状態を拾う可能性があるため、定期的に `VACUUM INTO` で整合性のとれたスナップショットファイルを同じPVCに書き出し、復旧時はそちらを使えるようにしておく

## 3. 主要フロー

### 3.1 アップロード → 解析

1. `.unitypackage` をアップロードする
2. sha256を計算し、重複していれば既存のUploadに紐付ける。元ファイルは `workspace` PVCに保存する(アーカイブ済みで元ファイルが無いUploadと一致した場合は、元ファイルを戻して状態を `stored` に戻す)
3. 解析する(tar.gzを展開。各エントリは `<guid>/asset`, `<guid>/asset.meta`, `<guid>/pathname`, `<guid>/preview.png` の構造)
   - pathname一覧からファイルツリーを作る
   - 既知パッケージの同梱を検出する(lilToon、Modular Avatar等を、GUIDやパスのパターンで判定)
   - 既にpublish済みのパッケージとのGUID衝突を検出する(GUIDインデックスを照合)
   - .metaが無いフォルダを洗い出す(unitypackageはフォルダ.metaを含まないことがある)

### 3.2 変換設定(UIで編集)

- パッケージ名(例: `com.haoling.booth.<shop>.<item>`)、displayName、version(semver。BOOTH側の表記は別フィールドで保持する)
- ルートパスの指定: `Assets/<作者フォルダ>/...` のどこをパッケージルートにするか。プレフィックスを剥がす
- 除外ルール: 同梱物の除外。検出結果からワンクリックで除外できるようにし、globでの追加指定もできるようにする
- 依存宣言: 除外した同梱物の代わりに依存を宣言する(4章の論点を参照)
- .metaパッチ: YAMLのパス指定で値を上書きする(例: TextureImporterの `maxTextureSize`、`textureCompression`)
- 設定は「パッケージ単位のテンプレート」として保存し、次のバージョンのアップロード時に引き継ぐ

### 3.3 ビルド → publish

1. 設定のスナップショットを取り、Buildレコードを作る(元ファイルが `workspace` に無ければ、再アップロードを促してビルドしない)
2. Workerがtarballを `workspace` の作業領域に生成する
   - `package.json` を生成する(name, version, displayName, unity, dependencies, 独自メタ情報として元ファイル名・sha256・BOOTH URL)
   - 欠けているフォルダ.metaを生成する。GUIDは `hash(パッケージ名 + 相対パス)` で決定的にし、バージョンをまたいで安定させる
   - .metaパッチを適用する
   - 既存のGUIDはそのまま維持する(パッケージをまたいだ参照、例えば衣装→素体の参照を壊さないため)
3. ビルドしたtarballのdry-runとして、ファイル一覧・サイズ・GUID衝突の最終チェックをUIに表示する
4. Verdaccioに `npm publish` する。同じバージョンへの再publishは禁止とし、パッチ変更時はバージョンを上げる運用にする
5. publish後、作業領域のtarballを削除する。tarballのsha256(integrity)はBuildに記録し、再ビルド時の一致確認に使う

### 3.4 元ファイルのアーカイブと復旧

- UIからUploadを「アーカイブ済み」にでき、`workspace` から元ファイルを削除する
  - 保管先のメモ(テープID等)を自由入力で残せるようにする
  - アーカイブ前に、元ファイルをダウンロードしてsha256を照合できるようにする
- 元ファイルが外部要因(PVC消失、手動削除)で無くなっていた場合も、起動時・参照時に検知して状態を `missing` にする(エラーで止めない)
- 復旧は再アップロードだけで済ませる。sha256が一致すれば既存のUpload・設定・ビルド履歴にそのまま紐付く
- Verdaccioのストレージを失った場合は、publish済みBuildの一覧から「再publish」を実行する
  - 元ファイルが無いものは一覧に「要再アップロード」と表示し、再アップロード後に再ビルド → integrityの一致を確認してからpublishする


## 4. 要検討の論点(Claude Codeで詰める)

1. VPM系依存の扱い(最重要)
   - lilToon / MA / NDMF などはVPM(VCC/ALCOM)で配布されていて、npmレジストリには無い
   - 案A: `dependencies` には書かず、`vpmDependencies` 相当の情報メタとして記録だけし、プロジェクト側はVCC/ALCOMで別途入れる
   - 案B: VPMのzipをnpm tarballに変換してVerdaccioにミラーする(VCC管理の埋め込みパッケージと名前が衝突する危険がある)
   - とりあえず案Aが無難そう。VCC管理プロジェクトとの共存は要検証
2. Packages配下で動かないアセットへの対処: `Assets/` パスを決め打ちしているスクリプトやシェーダーincludeの検出(警告を出す程度?)
3. 1つのunitypackageを複数のUPMパッケージに分割する機能(素体と衣装同梱品など)が要るか
4. バージョンアップ時の差分表示(前バージョンとのファイル・GUIDの差分)

## 5. 技術スタック

TypeScriptで統一する。publish先がnpmレジストリなので、tarball生成・publishをnpm公式ライブラリに任せられるのが最大の理由。

- **バックエンド**: Hono(Node.js)。大きなunitypackageのアップロードはストリームで受ける(body上限を設定)
- **フロントエンド**: React + Vite のSPA(SSR不要のためNext.jsは使わない)
- **DB**: SQLite + Drizzle ORM(`better-sqlite3` または `node:sqlite`)
- **unitypackage展開・tarball生成**: `tar`
- **publish**: `libnpmpublish`
- **.meta編集**: YAMLライブラリ(`yaml`)。コメント・キー順序をできるだけ保持する
- **バリデーション/API契約**: zod
- **テスト**: vitest
- **配置**: API・Worker・ビルド済みSPAを1コンテナイメージにまとめる

## 6. リポジトリ構成

pnpm workspacesのモノレポにする(Turborepo等は現時点では不要)。

```
unitypackage-registry/
├── apps/
│   ├── server/        # Hono API + Worker(起動モードで切り替え)、Drizzle/SQLite
│   ├── web/           # React + Vite の管理画面SPA
│   └── cli/           # (任意)ローカルで変換・dry-runするCLI
├── packages/
│   ├── core/          # unitypackage解析、UPM変換、.metaパッチ、GUID生成
│   └── shared/        # API契約の型・zodスキーマ(server/webで共有)
├── fixtures/          # テスト用の合成unitypackage生成スクリプト
├── Dockerfile         # server + webのビルド成果物を1イメージに
├── DESIGN.md
└── pnpm-workspace.yaml
```

- `packages/core` はI/Oを持たない純粋なライブラリにする
  - tar解析、パス変換、除外ルール適用、.metaパッチ、フォルダGUIDの決定的生成など
  - テストをここに厚く書き、server/cliのどちらから使っても同じ結果になるようにする
- 既知パッケージの検出ルール(lilToon等のGUID/パスパターン)は、当面 `packages/core` にJSONで同梱する。管理画面で編集したくなったらDB(KnownPackage)へ移す
- テスト用fixtureに実際のBOOTHアセットは入れない(容量・規約上の理由)
  - ダミーのFBX/テクスチャ、フォルダ.meta欠落、同梱lilToon風のディレクトリなどを含むunitypackageをスクリプトで生成する
- k8sマニフェストはこのリポジトリに置かない
  - 既存のGitOpsリポジトリ(ArgoCD管理)側に置き、こちらはDockerfileとイメージビルド(CI)までを担当する

## 7. データモデル(案)

- **Upload**: id, sha256, original_filename, size, uploaded_at, analysis_json, file_state(stored/archived/missing), archived_at, archive_note
- **Package**: id, name, display_name, source_url(BOOTH), config_template(JSON/YAML)
- **Build**: id, package_id, upload_id, version, source_version_label, config_snapshot, status(queued/building/ready/published/failed), tarball_integrity, log
- **GuidIndex**: guid, package_name, version, path(衝突検出用)
- **KnownPackage**: name, detect_rules(GUID/パスのパターン), replacement_dependency

## 8. セキュリティ・運用

### 8.1 公開範囲の方針

- **ネットワーク: 外部公開する**。家の外(出先のPC等)からも管理画面とレジストリを使うため、インターネットから到達可能にする
- **パーミッション: 外部公開しない**。自分専用。未認証のリクエストには、パッケージ名・一覧・メタ情報を含めて一切何も返さない
- 認証は外部からの入口(Ingress)で必ず強制する。クラスタ内(自宅k8s)からのアクセスは信頼し、アプリ側では認証しない(自分用サービスのため)
- 再配布にならないよう、匿名アクセスできるダウンロード経路(公開URL、署名なしの直リンク等)を作らない

### 8.2 入力ファイル

- 入力は外部ファイルとして扱う
  - pathnameのパストラバーサル(`..`、絶対パス)を拒否する
  - サイズ上限とgzip bomb対策を入れる
  - 解析時に中身を実行しない

### 8.3 管理画面

- **管理画面アプリ自体は認証・認可の機能を一切持たない**。ログイン画面、ユーザー管理、セッション管理、トークン検証などは実装しない
- 認証・認可はすべて OIDC(認証プロキシ + IdPの認可機能)に任せる
  - 外部向けIngressは必ず認証プロキシを経由させる(プロキシを通らない外部向けIngressを作らない)
  - OIDCを通過したリクエストはすべて受け付ける
- クラスタ内の他のPodや別Ingressからの直接アクセスも制限しない(自分用サービスのため、デバッグのしやすさを優先)
- 状態を変えるAPIは、最低限のCSRF対策としてOriginヘッダを確認する(認証ではなく、プロキシのCookieを悪用した外部サイトからのリクエストを防ぐため)

### 8.4 Verdaccio

- Unityが家の外からも取得できるよう外部公開するが、**読み取りも含めて認証必須**にする
  - すべてのパッケージパターンで `access: $authenticated`(`$all` / `$anonymous` を使わない)
  - 自分用のscope(`com.haoling.*` 等)は **npmjsへのuplink/proxyを無効化**する(名前の漏洩・依存かぶりを防止)
  - ユーザーの自己登録を無効化する(htpasswdの `max_users: -1`)
  - publish権限は管理画面のサービスアカウントだけにする。Unity用のアカウント/トークンは読み取り専用にする
  - Verdaccio付属のWeb UIは無効化するか、管理画面と同じ認証プロキシの後ろに置く
- 認証プロキシ(OIDC)はUnityのUPMクライアントが通れないため、Verdaccioのnpm APIパスはプロキシの対象外とし、Verdaccio自身のトークン認証で守る
  - UPMはカスタムヘッダを送れないので、Cloudflare Access のサービストークン等は使えない
  - その分、Ingressでレート制限をかけ、ログイン試行の総当たりを抑える
- 管理画面のWorkerからのpublishはクラスタ内のServiceに向け、外部経由にしない

### 8.5 Unityクライアント

- `manifest.json` の `scopedRegistries` にVerdaccioの外部URL(https)とscopeを書く
- 認証トークンは `~/.upmconfig.toml` の `npmAuth` に置く(リポジトリには入れない)
  - トークンは全端末で共通の1つにする(Verdaccioでは端末ごとの個別失効ができないため)
  - 端末の紛失・漏洩時はトークンを作り直し、全端末の `~/.upmconfig.toml` を更新する

### 8.6 その他

- PVCの中身(DB・元ファイル)を直接外に出す経路は作らない
- 大きなunitypackageのアップロードは、経路上のプロキシのbody上限に注意する(例: Cloudflare経由だとプランによって100MB程度の上限がある)。必要なら分割アップロードを検討する

## 9. フェーズ

- **MVP**: アップロード → 解析(ツリー表示) → 手動設定(名前/version/ルート/除外) → ビルド → publish
- **Phase 2**: 既知パッケージの同梱自動検出、GUIDインデックスと衝突検出、設定テンプレートの引き継ぎ
- **Phase 3**: .metaパッチ、バージョン間の差分表示、Assetsパス決め打ちの警告
- **Phase 4(必要なら)**: VPMミラー、パッケージ分割、Unity Editor側の補助拡張
