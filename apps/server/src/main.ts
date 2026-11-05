import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { startWorker } from "./worker.js";

const config = loadConfig();
mkdirSync(config.WORKSPACE_DIR, { recursive: true });
const db = openDb(config.DB_PATH);

const stoppers: Array<() => void> = [];

if (config.MODE === "all" || config.MODE === "api") {
  const app = createApp({ config, db });
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`[api] listening on http://localhost:${info.port} (mode=${config.MODE})`);
  });
  stoppers.push(() => server.close());
}

if (config.MODE === "all" || config.MODE === "worker") {
  const worker = startWorker(db, { pollIntervalMs: config.WORKER_POLL_INTERVAL_MS });
  stoppers.push(() => worker.stop());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`received ${signal}, shutting down`);
    for (const stop of stoppers) stop();
    process.exit(0);
  });
}
