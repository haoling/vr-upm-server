import { asc, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { builds } from "./db/schema.js";

/**
 * Converter Worker。queued の Build を 1 件ずつ取り出して処理する。
 * MVP では API と同一プロセスで動かす前提(SQLite のため replicas=1)。
 */
export function startWorker(db: Db, { pollIntervalMs }: { pollIntervalMs: number }) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const next = db
        .select()
        .from(builds)
        .where(eq(builds.status, "queued"))
        .orderBy(asc(builds.id))
        .limit(1)
        .get();
      if (next) {
        // TODO: tarball 生成・publish を実装する(DESIGN.md 3.3)
        console.log(`[worker] build #${next.id} は未実装のためスキップ`);
      }
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
