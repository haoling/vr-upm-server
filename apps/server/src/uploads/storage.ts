import { mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** 元ファイルの置き場所(DESIGN.md 2.1: `workspace/uploads/<sha256>.unitypackage`) */
export function uploadsDir(workspaceDir: string): string {
  return join(workspaceDir, "uploads");
}

export function uploadFilePath(workspaceDir: string, sha256: string): string {
  return join(uploadsDir(workspaceDir), `${sha256}.unitypackage`);
}

/** 受信中のファイル。sha256 が分かるまで正式な名前にできないので、別名で書いてから rename する */
const INCOMING_PREFIX = ".incoming-";

export function incomingFilePath(workspaceDir: string, id: string): string {
  return join(uploadsDir(workspaceDir), `${INCOMING_PREFIX}${id}`);
}

export function ensureUploadsDir(workspaceDir: string): void {
  mkdirSync(uploadsDir(workspaceDir), { recursive: true });
}

/** 起動時に、前回の異常終了などで残った受信途中のファイルを消す */
export async function cleanupIncoming(workspaceDir: string): Promise<number> {
  const dir = uploadsDir(workspaceDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const stale = names.filter((n) => n.startsWith(INCOMING_PREFIX));
  await Promise.all(stale.map((n) => rm(join(dir, n), { force: true })));
  return stale.length;
}
