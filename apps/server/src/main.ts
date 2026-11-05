import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/client.js";
import { cleanupIncoming, ensureUploadsDir } from "./uploads/storage.js";
import { recoverBuilds } from "./builds/runner.js";
import { startWorker } from "./worker.js";

const config = loadConfig();
mkdirSync(config.WORKSPACE_DIR, { recursive: true });
ensureUploadsDir(config.WORKSPACE_DIR);
await cleanupIncoming(config.WORKSPACE_DIR);
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
  // 前回の異常終了で残ったビルドの作業領域を掃除する(building のまま残った Build はやり直す)
  const recovered = await recoverBuilds(db, config.WORKSPACE_DIR);
  if (recovered.requeued > 0 || recovered.removedDirs > 0) {
    console.log(`[worker] recovered: requeued=${recovered.requeued} removedDirs=${recovered.removedDirs}`);
  }
  const worker = startWorker(db, { pollIntervalMs: config.WORKER_POLL_INTERVAL_MS, workspaceDir: config.WORKSPACE_DIR });
  stoppers.push(() => worker.stop());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`received ${signal}, shutting down`);
    for (const stop of stoppers) stop();
    process.exit(0);
  });
}
