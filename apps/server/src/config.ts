import { z } from "zod";

const Env = z.object({
  MODE: z.enum(["all", "api", "worker"]).default("all"),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default("./data/db/app.sqlite"),
  WORKSPACE_DIR: z.string().default("./data/workspace"),
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  // アップロードボディの上限(バイト)。既定は解析側の入力上限と同じ 4 GiB
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4 * 1024 ** 3),
  // publish 先の Verdaccio(クラスタ内の Service を指す。DESIGN.md 8.4)。どちらか欠けると publish は無効
  REGISTRY_URL: z.string().url().optional(),
  // publish 権限を持つサービスアカウントのトークン。管理画面にも API にも返さない
  REGISTRY_TOKEN: z.string().min(1).optional(),
  WEB_DIST_DIR: z.string().optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
