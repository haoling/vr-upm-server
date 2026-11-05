# vr-upm-server

BOOTH 等で入手した `.unitypackage` を UPM パッケージに変換し、自前の Verdaccio に publish する管理画面です。
設計は [DESIGN.md](./DESIGN.md) を参照してください。

## 構成

Yarn(v4、`nodeLinker: node-modules`)workspaces のモノレポです。

| パス | 内容 |
|---|---|
| `apps/server` | Hono API + Converter Worker(`MODE=all/api/worker` で切り替え)、Drizzle + SQLite |
| `apps/web` | React + Vite の管理画面 SPA |
| `apps/cli` | ローカルで解析・変換を試す CLI(`vr-upm`) |
| `packages/core` | unitypackage 解析・UPM 変換の純粋ライブラリ(I/O を持たない) |
| `packages/shared` | server / web で共有する API 契約(zod スキーマ) |
| `fixtures` | テスト用の合成 unitypackage の生成(異常系を含む。一覧は `fixtures/src/catalog.ts`) |

ワークスペース内パッケージ(`@vr-upm/*`)はビルドせず TS ソースのまま参照します。
開発時は tsx / Vite がそのまま読み、本番では `apps/server/build.mjs` が esbuild で 1 ファイルにバンドルします。

## 開発

Node.js 22.12 以上と Yarn 4 が必要です(`corepack enable` で `packageManager` のバージョンが入ります)。
公開から 1 日未満のバージョンは Yarn の既定(`npmMinimalAgeGate`)で入らないので、依存を上げるときは注意してください。

```sh
yarn install
cp apps/server/.env.example apps/server/.env
yarn dev          # server(:3000)と web(:5173)を同時に起動。web の /api は server に転送される
```

| コマンド | 内容 |
|---|---|
| `yarn typecheck` | 全パッケージの型チェック |
| `yarn test` | vitest(`packages/*`、`apps/server`、`apps/cli`、`apps/web`) |
| `yarn build` | server のバンドルと web のビルド |
| `yarn fixtures` | `fixtures/out/` に合成 unitypackage を生成 |
| `yarn workspace @vr-upm/cli start analyze <file> [--json]` | unitypackage を解析してツリー・.meta が無いフォルダ・問題点を表示 |
| `yarn workspace @vr-upm/cli start build <file> --config <json> [--out <tgz>] [--dry-run] [--json]` | 変換設定に従って UPM の tarball(.tgz)を作る。`--dry-run` ならファイル一覧とサイズだけ表示。同じ入力・設定なら integrity は常に同じ |
| `yarn workspace @vr-upm/server db:generate` | `src/db/schema.ts` の変更から Drizzle のマイグレーションを生成 |

マイグレーションは server の起動時に自動で適用されます。

## コンテナイメージ

`Dockerfile` で server・worker・SPA を 1 イメージにまとめます。
`main` への push で GitHub Actions が `ghcr.io/haoling/vr-upm-server` に push します(PR ではビルドのみ)。
k8s マニフェストはこのリポジトリには置かず、GitOps リポジトリ側で管理します。

| 環境変数 | 既定値(イメージ内) | 内容 |
|---|---|---|
| `MODE` | `all` | `all` / `api` / `worker` |
| `PORT` | `3000` | API の待ち受けポート |
| `DB_PATH` | `/data/db/app.sqlite` | SQLite(`db` PVC) |
| `WORKSPACE_DIR` | `/data/workspace` | 元 unitypackage・作業領域(`workspace` PVC) |
| `MAX_UPLOAD_BYTES` | `4294967296`(4 GiB) | アップロードボディの上限(バイト) |
| `ALLOWED_ORIGINS` | (空) | 状態を変える API で許可する Origin(カンマ区切り)。管理画面の外部 URL を入れる |

## UPM 変換(`vr-upm build`)

変換設定は JSON で渡します(スキーマは `packages/shared/src/convert.ts`)。

```json
{
  "packageName": "com.haoling.booth.shop.item",
  "displayName": "Item",
  "version": "1.0.0",
  "sourceVersionLabel": "Ver.1.0",
  "rootPath": "Assets/Shop/Item",
  "exclude": ["Textures/Unused/**"],
  "boothUrl": "https://shop.booth.pm/items/123"
}
```

- `rootPath` のプレフィックスを剥がし、その外のアセットは取り込みません。`exclude` は剥がした後のパスへの glob(picomatch)で、フォルダに一致すればその下も除外します
- 元の `.meta` は(GUID も含めて)そのまま維持します。`.meta` が無いフォルダには `hash(パッケージ名 + 相対パス)` の GUID で `.meta` を作ります
- tarball は npm と同じく全ファイルが `package/` 配下に入ります。`package.json` には元ファイル名・sha256・BOOTH URL などを `vrUpm.source` として入れます
- tar のエントリ順・mtime・uid/gid・mode と gzip ヘッダを固定しているので、同じ入力・同じ設定なら(同じ zlib であれば)毎回同じ integrity になります
- 終了コード: 0 = 完了 / 1 = 止めた(壊れた入力、GUID 重複などで変換できない設定)/ 2 = 引数・設定ファイルの誤り

```sh
yarn fixtures
# fixtures/configs/simple.json は上の例と同じ形の設定ファイル(自分の設定を使うときはそのパスに置き換える)
yarn workspace @vr-upm/cli start build fixtures/out/simple.unitypackage --config fixtures/configs/simple.json --dry-run
yarn workspace @vr-upm/cli start build fixtures/out/simple.unitypackage --config fixtures/configs/simple.json --out /tmp/item.tgz
tar tzf /tmp/item.tgz
```

## アップロードと解析結果の表示(管理画面)

`yarn dev` で server(:3000)と web(:5173)を起動し、http://localhost:5173 を開きます(`apps/server/.env` が必要。`cp apps/server/.env.example apps/server/.env`)。
`yarn fixtures` で作った `fixtures/out/*.unitypackage` を画面のフォームから上げると、Upload 詳細にファイルツリー(`.meta` が無いフォルダに印)と警告が出ます。
同じファイルをもう一度上げても Upload は 1 件のままです。`traversal.unitypackage` のような異常ファイルは 422 で拒否され、`workspace` に何も残りません。

API(`/api` 配下。状態を変える API は Origin チェックあり):

| エンドポイント | 内容 |
|---|---|
| `POST /api/uploads?filename=<名前>` | ボディに unitypackage をそのまま入れる(multipart ではない)。ストリームで `workspace/uploads/<sha256>.unitypackage` に保存して解析する。新規は 201、既存と同じ内容は 200(`created: false`。archived / missing なら元ファイルを戻して `stored` にする)。上限超過は 413、解析できない入力は 422、`filename` 不正・空ボディは 400 |
| `GET /api/uploads` | Upload 一覧(新しい順) |
| `GET /api/uploads/:id` | Upload 詳細(解析結果の統計・警告・ファイルツリー込み) |

```sh
yarn fixtures
# 別のターミナルで yarn dev を起動しておく(Origin ヘッダを付けない curl は Origin チェックを通る)
curl -X POST --data-binary @fixtures/out/simple.unitypackage \
  "http://localhost:3000/api/uploads?filename=simple.unitypackage"          # 201
curl -X POST --data-binary @fixtures/out/simple.unitypackage \
  "http://localhost:3000/api/uploads?filename=simple.unitypackage"          # 200(created: false)
curl -X POST --data-binary @fixtures/out/traversal.unitypackage \
  "http://localhost:3000/api/uploads?filename=traversal.unitypackage"       # 422
curl http://localhost:3000/api/uploads/1
ls apps/server/data/workspace/uploads                                        # <sha256>.unitypackage だけ(残骸なし)
```

受信中のファイルは `workspace/uploads/.incoming-*` に書き、解析が通ってから `<sha256>.unitypackage` に rename します。異常終了で残ったものは起動時に消します。

## パッケージ設定とビルド(管理画面)

Upload 詳細の「このファイルからパッケージ設定を作る」から設定画面に入ります。
名前・version などを入力し、ファイルツリー上で「ルートにする」と、ルート配下の「除外」チェックを選べます(除外はルートからの相対パスの glob として保存され、テキスト欄でも編集できます)。
「保存してビルド」で Build が queued になり、Worker が `workspace/builds/<id>/` で変換して ready / failed にします。Build 詳細に dry-run(tarball に入るファイル・サイズ・警告)とログが出ます。
ready の Build の tarball は `workspace/builds/<id>/package.tgz` に残ります(publish は M5)。「この Build を破棄」でレコードと tarball を消します。

- Build は作成時点の設定のスナップショットを持ち、Package を後から編集しても変わりません
- 元ファイルが `workspace` に無い Upload ではビルドを作れません(409)。同じファイルを再アップロードすると元の Upload に戻ります
- 起動時に `workspace/builds/` の残骸を消し、`building` のまま残った Build は queued に戻してやり直します
- UPM パッケージ名は作成後に変えられません(publish 済みの識別子のため)

API(`/api` 配下。状態を変える API は Origin チェックあり。ボディは JSON):

| エンドポイント | 内容 |
|---|---|
| `GET /api/packages`、`GET /api/packages/:id` | Package 一覧・詳細(`config` は `ConvertConfig`) |
| `POST /api/packages` | `{"config": ConvertConfig}` で作成。同名は 409 |
| `PUT /api/packages/:id` | `{"config": ConvertConfig}` で更新。`packageName` の変更は 400 |
| `POST /api/builds` | `{"packageId", "uploadId"}`。設定をスナップショットして queued の Build を作る(201)。元ファイルが無ければ 409 `source-file-missing`、publish 済みの version なら 409 |
| `GET /api/builds`、`GET /api/builds/:id` | 一覧・詳細(詳細に `config` スナップショット・`dryRun`・`log`) |
| `DELETE /api/builds/:id` | 破棄(204)。ビルド中・publish 済みは 409 |

```sh
yarn fixtures
# yarn dev を起動しておく(別のターミナル。Origin ヘッダを付けない curl は Origin チェックを通る)
curl -X POST --data-binary @fixtures/out/simple.unitypackage \
  "http://localhost:3000/api/uploads?filename=simple.unitypackage"                      # Upload #1
curl -X POST -H 'content-type: application/json' \
  --data "{\"config\": $(cat fixtures/configs/simple.json)}" http://localhost:3000/api/packages   # Package #1
curl -X POST -H 'content-type: application/json' \
  -d '{"packageId":1,"uploadId":1}' http://localhost:3000/api/builds                    # Build #1 (queued)
sleep 3
curl http://localhost:3000/api/builds/1        # status: ready、dryRun.files、log
ls apps/server/data/workspace/builds/1         # package.tgz だけ
tar tzf apps/server/data/workspace/builds/1/package.tgz
curl -X DELETE http://localhost:3000/api/builds/1                                       # 204、ディレクトリも消える
```

CLI(`vr-upm build`)と同じ入力・設定なら、Worker が作る tarball の integrity は CLI と一致します。
