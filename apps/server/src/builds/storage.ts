import { mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** ビルドの作業領域(DESIGN.md 2.1: `workspace/builds/<build_id>/`) */
export function buildsDir(workspaceDir: string): string {
  return join(workspaceDir, "builds");
}

export function buildDir(workspaceDir: string, buildId: number): string {
  return join(buildsDir(workspaceDir), String(buildId));
}

/** 生成した tarball。ready の間だけ残る(M5 の publish 後・破棄時に消す) */
export function tarballPath(workspaceDir: string, buildId: number): string {
  return join(buildDir(workspaceDir, buildId), "package.tgz");
}

export function ensureBuildsDir(workspaceDir: string): void {
  mkdirSync(buildsDir(workspaceDir), { recursive: true });
}

export async function removeBuildDir(workspaceDir: string, buildId: number): Promise<void> {
  await rm(buildDir(workspaceDir, buildId), { recursive: true, force: true });
}

/**
 * 起動時に `workspace/builds/` の残骸を消す(DESIGN.md 2.1)。
 * 残すのは、tarball を持つ ready の Build のディレクトリだけ。
 * 返すのは消したディレクトリの数。
 */
export async function cleanupBuildsDir(workspaceDir: string, keepBuildIds: ReadonlySet<number>): Promise<number> {
  const dir = buildsDir(workspaceDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const stale = names.filter((n) => !(/^[1-9]\d*$/.test(n) && keepBuildIds.has(Number(n))));
  await Promise.all(stale.map((n) => rm(join(dir, n), { recursive: true, force: true })));
  return stale.length;
}
