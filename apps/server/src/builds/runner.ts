import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssetSink,
  inspectUnitypackage,
  packTarball,
  planUpm,
  UnitypackageAnalysisError,
  type UpmPlan,
} from "@vr-upm/core";
import { ConvertConfig, type DryRunReport } from "@vr-upm/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { builds, uploads } from "../db/schema.js";
import { uploadFilePath } from "../uploads/storage.js";
import { buildDir, cleanupBuildsDir, ensureBuildsDir, removeBuildDir, tarballPath } from "./storage.js";

export type BuildRow = typeof builds.$inferSelect;

/** UpmPlan を保存・表示用の形にする(asset の中身の参照は落とす) */
export function toDryRunReport(plan: UpmPlan): DryRunReport {
  return {
    files: plan.files.map((f) => ({ path: f.path, size: f.size, origin: f.origin })),
    totalSize: plan.files.reduce((sum, f) => sum + f.size, 0),
    errors: plan.errors,
    warnings: plan.warnings,
    outsideRootCount: plan.outsideRootCount,
    excluded: plan.excluded,
  };
}

async function* tapHash(stream: AsyncIterable<Uint8Array>, hash: ReturnType<typeof createHash>) {
  for await (const chunk of stream) {
    hash.update(chunk);
    yield chunk;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

interface Outcome {
  status: "ready" | "failed";
  log: string[];
  dryRun?: DryRunReport;
  tarballIntegrity?: string;
  tarballSize?: number;
}

/** 元ファイルから tarball を作る。成功しても plan にエラーがあれば failed */
async function convert(db: Db, workspaceDir: string, build: BuildRow, log: string[]): Promise<Outcome> {
  const parsed = ConvertConfig.safeParse(build.configSnapshot);
  if (!parsed.success) {
    log.push(`設定のスナップショットを読めません: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { status: "failed", log };
  }
  const config = parsed.data;

  const upload = db.select().from(uploads).where(eq(uploads.id, build.uploadId)).get();
  if (!upload) {
    log.push(`Upload #${build.uploadId} がありません`);
    return { status: "failed", log };
  }
  const source = uploadFilePath(workspaceDir, upload.sha256);
  if (!(await exists(source))) {
    if (upload.fileState === "stored") db.update(uploads).set({ fileState: "missing" }).where(eq(uploads.id, upload.id)).run();
    log.push(`元ファイル ${upload.originalFilename} が workspace にありません。同じファイルを再アップロードしてからビルドし直してください`);
    return { status: "failed", log };
  }

  const dir = buildDir(workspaceDir, build.id);
  const assetsDir = join(dir, "assets");
  await mkdir(assetsDir, { recursive: true });

  // asset は展開しながら作業領域へ書く(ディレクトリ名は外部入力なので、ファイル名には使わない)
  const files = new Map<string, string>();
  const assetSink: AssetSink = (guid) => {
    const file = join(assetsDir, `${files.size}.bin`);
    files.set(guid, file);
    return createWriteStream(file);
  };

  log.push(`元ファイル: ${upload.originalFilename} (sha256 ${upload.sha256})`);
  log.push(`設定: ${config.packageName} ${config.version} / ルート ${config.rootPath} / 除外 ${config.exclude.length} 件`);

  const hash = createHash("sha256");
  let inspected;
  try {
    inspected = await inspectUnitypackage(tapHash(createReadStream(source), hash), { assetSink });
  } catch (err) {
    if (err instanceof UnitypackageAnalysisError) {
      log.push(`unitypackage を解析できません [${err.code}] ${err.message}`);
      return { status: "failed", log };
    }
    throw err;
  }
  const actual = hash.digest("hex");
  if (actual !== upload.sha256) {
    log.push(`元ファイルの sha256 が登録時と違います(${actual})。壊れているので、再アップロードしてください`);
    return { status: "failed", log };
  }
  log.push(`解析: ファイル ${inspected.analysis.stats.fileCount} 件・フォルダ ${inspected.analysis.stats.folderCount} 件`);

  const plan = planUpm(inspected.analysis, inspected.metas, config, { fileName: upload.originalFilename, sha256: upload.sha256 });
  const dryRun = toDryRunReport(plan);
  log.push(`変換計画: ${plan.files.length} ファイル(${dryRun.totalSize} バイト)、除外 ${plan.excluded.length} 件、ルート外 ${plan.outsideRootCount} 件`);
  for (const w of plan.warnings) log.push(`警告 [${w.code}] ${w.message}`);
  if (plan.errors.length > 0) {
    for (const e of plan.errors) log.push(`エラー [${e.code}] ${e.message}`);
    log.push("エラーがあるため tarball は作りませんでした");
    return { status: "failed", log, dryRun };
  }

  const out = tarballPath(workspaceDir, build.id);
  const tmp = `${out}.tmp`;
  const digest = await packTarball(plan, { open: (guid) => createReadStream(files.get(guid) as string) }, createWriteStream(tmp));
  await rename(tmp, out);
  await rm(assetsDir, { recursive: true, force: true });
  log.push(`tarball を作りました: ${digest.size} バイト / ${digest.integrity}`);
  return { status: "ready", log, dryRun, tarballIntegrity: digest.integrity, tarballSize: digest.size };
}

/**
 * claim 済み(status = building)の Build を処理して、ready / failed にする。
 * 失敗しても例外は投げない(ログに残して failed にする)。
 */
export async function processBuild(db: Db, workspaceDir: string, build: BuildRow): Promise<BuildRow["status"]> {
  const log: string[] = [];
  let outcome: Outcome;
  try {
    outcome = await convert(db, workspaceDir, build, log);
  } catch (err) {
    log.push(`予期しないエラー: ${err instanceof Error ? err.message : String(err)}`);
    outcome = { status: "failed", log };
  }
  if (outcome.status === "failed") await removeBuildDir(workspaceDir, build.id);

  const updated = db
    .update(builds)
    .set({
      status: outcome.status,
      log: outcome.log.join("\n"),
      dryRun: outcome.dryRun ?? null,
      tarballIntegrity: outcome.tarballIntegrity ?? null,
      tarballSize: outcome.tarballSize ?? null,
    })
    .where(and(eq(builds.id, build.id), eq(builds.status, "building")))
    .returning({ id: builds.id })
    .get();
  // 処理中に破棄された Build の作業領域は残さない
  if (!updated) await removeBuildDir(workspaceDir, build.id);
  return outcome.status;
}

/** queued の最も古い Build を building にして取り出す。無ければ undefined */
export function claimNextBuild(db: Db): BuildRow | undefined {
  const next = db.select({ id: builds.id }).from(builds).where(eq(builds.status, "queued")).orderBy(asc(builds.id)).limit(1).get();
  if (!next) return undefined;
  return db
    .update(builds)
    .set({ status: "building" })
    .where(and(eq(builds.id, next.id), eq(builds.status, "queued")))
    .returning()
    .get();
}

/** queued の Build を空になるまで処理する。処理した件数を返す */
export async function runPendingBuilds(db: Db, workspaceDir: string): Promise<number> {
  ensureBuildsDir(workspaceDir);
  let count = 0;
  for (let build = claimNextBuild(db); build; build = claimNextBuild(db)) {
    await processBuild(db, workspaceDir, build);
    count++;
  }
  return count;
}

/**
 * 起動時の後始末(DESIGN.md 2.1)。
 * 前回の異常終了で building のまま残った Build は queued に戻してやり直し、
 * `workspace/builds/` には ready の Build の tarball 以外を残さない。
 */
export async function recoverBuilds(db: Db, workspaceDir: string): Promise<{ requeued: number; removedDirs: number }> {
  ensureBuildsDir(workspaceDir);
  const requeued = db.update(builds).set({ status: "queued" }).where(eq(builds.status, "building")).returning({ id: builds.id }).all().length;
  const ready = db.select({ id: builds.id }).from(builds).where(inArray(builds.status, ["ready"])).all();
  const removedDirs = await cleanupBuildsDir(workspaceDir, new Set(ready.map((b) => b.id)));
  return { requeued, removedDirs };
}
