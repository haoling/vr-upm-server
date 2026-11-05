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
| `yarn test` | vitest(`packages/*`、`apps/server`、`apps/cli`) |
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
yarn workspace @vr-upm/cli start build fixtures/out/simple.unitypackage --config my-config.json --out /tmp/item.tgz
tar tzf /tmp/item.tgz
```
