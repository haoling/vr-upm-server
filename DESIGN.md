# unitypackage → UPM 変換・Verdaccio公開 管理画面 ざっくり設計

## 1. 目的

- BOOTH等で入手した `.unitypackage` をアップロードし、UPMパッケージ(npm tarball)に変換して、自前のVerdaccioにpublishする
- Unityプロジェクト側は `Packages/manifest.json` の scopedRegistries と依存定義だけをgitで管理し、アセット本体はgitに入れない
- 元アセットは読み取り専用(Library/PackageCache)として扱い、改変はNDMF等による非破壊で行う前提
- 変換時の調整(同梱物の除外、.metaのインポート設定パッチ等)を設定として保存し、再ビルドで同じ結果を再現できるようにする

### 非ゴール

- 公開配布(あくまで自分専用の非公開レジストリ)
- Unity Editor拡張の開発(必要になったら別途)
- アセットの中身の編集機能

## 2. 全体構成

```
[Browser] ──> [管理画面 Web UI]
                   │ REST
                   ▼
              [API Server] ──> [DB (SQLite)]
                   │  ├──> [Object Storage (MinIO等): 元unitypackage / 生成tarball]
                   │  └──> [Job Queue]
                   ▼
              [Converter Worker] ── npm publish ──> [Verdaccio]
                                                       ▲
[Unity Editor] ── scopedRegistries + token ───────────┘
```

- 想定デプロイ先: 自宅k8s(ArgoCDで管理)。Verdaccioも同じクラスタに置く
- API と Worker は同じコードベースで、起動モードだけ分ける構成でもよい(MVPは同一プロセスでもOK)
- DBはSQLite(シングルユーザー・小規模のため)。k8sではPVC上に置き、replicas=1で運用する
  - バックアップはLitestream等でObject Storageへ複製するか、定期dumpにする
  - SQLiteを使う関係でAPIとWorkerは同一Podにまとめるのが無難(別Podにするならジョブ状態の受け渡しを要検討)

## 3. 主要フロー

### 3.1 アップロード → 解析

1. `.unitypackage` をアップロードする
2. sha256を計算し、重複していれば既存のUploadに紐付ける。元ファイルはObject Storageに保存する(再ビルド用に必ず残す)
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

1. 設定のスナップショットを取り、Buildレコードを作る
2. Workerがtarballを生成する
   - `package.json` を生成する(name, version, displayName, unity, dependencies, 独自メタ情報として元ファイル名・sha256・BOOTH URL)
   - 欠けているフォルダ.metaを生成する。GUIDは `hash(パッケージ名 + 相対パス)` で決定的にし、バージョンをまたいで安定させる
   - .metaパッチを適用する
   - 既存のGUIDはそのまま維持する(パッケージをまたいだ参照、例えば衣装→素体の参照を壊さないため)
3. ビルドしたtarballのdry-runとして、ファイル一覧・サイズ・GUID衝突の最終チェックをUIに表示する
4. Verdaccioに `npm publish` する。同じバージョンへの再publishは禁止とし、パッチ変更時はバージョンを上げる運用にする

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

- **Upload**: id, sha256, original_filename, size, storage_key, uploaded_at, analysis_json
- **Package**: id, name, display_name, source_url(BOOTH), config_template(JSON/YAML)
- **Build**: id, package_id, upload_id, version, source_version_label, config_snapshot, status(queued/building/ready/published/failed), tarball_key, log
- **GuidIndex**: guid, package_name, version, path(衝突検出用)
- **KnownPackage**: name, detect_rules(GUID/パスのパターン), replacement_dependency

## 8. セキュリティ・運用

- 入力は外部ファイルとして扱う
  - pathnameのパストラバーサル(`..`、絶対パス)を拒否する
  - サイズ上限とgzip bomb対策を入れる
  - 解析時に中身を実行しない
- Verdaccio
  - 自分用のscope(`com.haoling.*` 等)は `access: $authenticated` にして、**npmjsへのuplink/proxyを無効化**する(名前の漏洩・依存かぶりを防止)
  - publish権限は管理画面のサービスアカウントだけにする
- 管理画面は認証プロキシ(OIDC等)の後ろに置く。シングルユーザー想定
- Unityクライアント
  - `manifest.json` の `scopedRegistries` にVerdaccioのURLとscopeを書く
  - 認証トークンは `~/.upmconfig.toml` の `npmAuth` に置く(リポジトリには入れない)
- 再配布にならないよう、レジストリもストレージも外部公開しない

## 9. フェーズ

- **MVP**: アップロード → 解析(ツリー表示) → 手動設定(名前/version/ルート/除外) → ビルド → publish
- **Phase 2**: 既知パッケージの同梱自動検出、GUIDインデックスと衝突検出、設定テンプレートの引き継ぎ
- **Phase 3**: .metaパッチ、バージョン間の差分表示、Assetsパス決め打ちの警告
- **Phase 4(必要なら)**: VPMミラー、パッケージ分割、Unity Editor側の補助拡張
