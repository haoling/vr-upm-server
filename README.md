# vr-upm-server

BOOTH 等で入手した `.unitypackage` を UPM パッケージに変換し、自前の Verdaccio に publish する管理画面です。
設計は [DESIGN.md](./DESIGN.md) を参照してください。

## 構成

pnpm workspaces のモノレポです。

| パス | 内容 |
|---|---|
| `apps/server` | Hono API + Converter Worker(`MODE=all/api/worker` で切り替え)、Drizzle + SQLite |
| `apps/web` | React + Vite の管理画面 SPA |
| `packages/core` | unitypackage 解析・UPM 変換の純粋ライブラリ(I/O を持たない) |
| `packages/shared` | server / web で共有する API 契約(zod スキーマ) |
| `fixtures` | テスト用の合成 unitypackage 生成スクリプト |

ワークスペース内パッケージ(`@vr-upm/*`)はビルドせず TS ソースのまま参照します。
開発時は tsx / Vite がそのまま読み、本番では `apps/server/build.mjs` が esbuild で 1 ファイルにバンドルします。

## 開発

Node.js 22.12 以上と pnpm(`corepack enable` で `packageManager` のバージョンが入ります)が必要です。

```sh
pnpm install
cp apps/server/.env.example apps/server/.env
pnpm dev          # server(:3000)と web(:5173)を同時に起動。web の /api は server に転送される
```

| コマンド | 内容 |
|---|---|
| `pnpm typecheck` | 全パッケージの型チェック |
| `pnpm test` | vitest(`packages/*` と `apps/server`) |
| `pnpm build` | server のバンドルと web のビルド |
| `pnpm fixtures` | `fixtures/out/` に合成 unitypackage を生成 |
| `pnpm --filter @vr-upm/server db:generate` | `src/db/schema.ts` の変更から Drizzle のマイグレーションを生成 |

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
