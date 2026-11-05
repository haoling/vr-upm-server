import type { Db } from "./db/client.js";
import { runPendingBuilds } from "./builds/runner.js";

/**
 * Converter Worker。queued の Build を 1 件ずつ取り出して処理する(DESIGN.md 3.3)。
 * MVP では API と同一プロセスで動かす前提(SQLite のため replicas=1)。
 */
export function startWorker(db: Db, { pollIntervalMs, workspaceDir }: { pollIntervalMs: number; workspaceDir: string }) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const count = await runPendingBuilds(db, workspaceDir);
      if (count > 0) console.log(`[worker] ${count} 件のビルドを処理しました`);
    } catch (err) {
      console.error("[worker] tick failed", err);
    } finally {
      if (!stopped) timer = setTimeout(tick, pollIntervalMs);
    }
  };

  timer = setTimeout(tick, 0);
  console.log("[worker] started");

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
