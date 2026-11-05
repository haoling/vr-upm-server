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
  WEB_DIST_DIR: z.string().optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
