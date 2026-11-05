import type { AnalysisIssue, AnalysisResult, AnalyzedAsset } from "@vr-upm/shared";
import { isUnityGuid } from "../guid.js";
import { normalizeAssetPathname, UnsafePathnameError } from "../pathname.js";
import { UnitypackageAnalysisError } from "./errors.js";
import { type AnalyzeLimits, DEFAULT_ANALYZE_LIMITS } from "./limits.js";
import { type RawUnitypackage, readUnitypackage, type UnitypackageInput } from "./read.js";

export interface AnalyzeOptions {
  /** 一部だけ指定すれば、残りは {@link DEFAULT_ANALYZE_LIMITS} を使う */
  limits?: Partial<AnalyzeLimits>;
}

/**
 * `.unitypackage`(tar.gz)を解析する(DESIGN.md 3.1)。
 *
 * 入力はファイルの中身をそのまま Buffer / Stream で渡す。中身はどこにも書き出さない。
 * 続行できない入力(上限超過・壊れた tar・パストラバーサル等)は {@link UnitypackageAnalysisError} を投げる。
 * それ以外の問題(.meta の guid 不一致、GUID 重複など)は結果の `issues` に入れる。
 */
export async function analyzeUnitypackage(input: UnitypackageInput, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const limits: AnalyzeLimits = { ...DEFAULT_ANALYZE_LIMITS, ...options.limits };
  const raw = await readUnitypackage(input, limits);
  return assembleAnalysis(raw);
}

const META_GUID_PATTERN = /^guid:\s*([0-9a-fA-F]{32})\s*$/m;

/** asset.meta から guid を取り出す。見つからなければ null */
export function parseMetaGuid(meta: string): string | null {
  const m = META_GUID_PATTERN.exec(meta);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** 文字列の大小比較(ロケールに依存させない) */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `a/b/c` → `["a", "a/b"]`(自分自身は含まない) */
function ancestors(pathname: string): string[] {
  const segments = pathname.split("/");
  const result: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    result.push(segments.slice(0, i).join("/"));
  }
  return result;
}

/**
 * Unity が .meta を持たないフォルダか。
 * `Assets` 自体と、`Packages` / `Packages/<パッケージ>` は .meta を持たない。
 */
function isMetalessRoot(folder: string): boolean {
  const segments = folder.split("/");
  if (segments.length === 1) return segments[0] === "Assets" || segments[0] === "Packages";
  return segments.length === 2 && segments[0] === "Packages";
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function assembleAnalysis(raw: RawUnitypackage): AnalysisResult {
  const issues: AnalysisIssue[] = [];
  const assets: AnalyzedAsset[] = [];

  for (const notice of raw.notices) {
    if (notice.code === "duplicate-entry") {
      issues.push({
        severity: "warning",
        code: "duplicate-entry",
        message: `${notice.dir}/${notice.name} が複数あります(最初のものを使います)`,
        guid: notice.dir,
      });
    } else {
      issues.push({
        severity: "warning",
        code: "unexpected-entry",
        message: `想定外のエントリ ${notice.path} を無視しました`,
      });
    }
  }

  const dirs = [...raw.entries.keys()].sort(compare);
  for (const dir of dirs) {
    const entry = raw.entries.get(dir)!;
    if (!isUnityGuid(dir)) {
      issues.push({
        severity: "warning",
        code: "invalid-guid",
        message: `ディレクトリ名 ${JSON.stringify(dir)} が GUID の形式ではありません`,
        guid: dir,
      });
    }
    if (entry.pathname === undefined) {
      issues.push({
        severity: "warning",
        code: "missing-pathname",
        message: `${dir} に pathname が無いため無視しました`,
        guid: dir,
      });
      continue;
    }

    let pathname: string;
    try {
      pathname = normalizeAssetPathname(entry.pathname);
    } catch (err) {
      if (err instanceof UnsafePathnameError) {
        throw new UnitypackageAnalysisError("unsafe-path", `${dir}/pathname: ${err.message}`, { cause: err });
      }
      throw err;
    }

    let metaGuid: string | null = null;
    if (entry.meta === undefined) {
      issues.push({ severity: "warning", code: "missing-meta", message: `${pathname} に .meta がありません`, guid: dir, pathname });
    } else {
      metaGuid = parseMetaGuid(entry.meta);
      if (metaGuid === null) {
        issues.push({
          severity: "warning",
          code: "missing-meta",
          message: `${pathname} の .meta から guid を読めません`,
          guid: dir,
          pathname,
        });
      } else if (metaGuid !== dir.toLowerCase()) {
        issues.push({
          severity: "warning",
          code: "meta-guid-mismatch",
          message: `${pathname} の .meta の guid (${metaGuid}) がディレクトリ名 (${dir}) と一致しません`,
          guid: dir,
          pathname,
        });
      }
    }

    assets.push({
      guid: dir,
      pathname,
      kind: entry.asset ? "file" : "folder",
      size: entry.asset?.size ?? null,
      sha256: entry.asset?.sha256 ?? null,
      metaGuid,
      hasPreview: entry.hasPreview,
    });
  }

  assets.sort((a, b) => compare(a.pathname, b.pathname) || compare(a.guid, b.guid));

  // GUID 重複(Unity が実際に使うのは .meta の guid なので、そちらを優先して判定する)
  const byGuid = new Map<string, AnalyzedAsset[]>();
  for (const a of assets) {
    const key = a.metaGuid ?? a.guid.toLowerCase();
    const group = byGuid.get(key);
    if (group) group.push(a);
    else byGuid.set(key, [a]);
  }
  for (const [guid, group] of byGuid) {
    if (group.length < 2) continue;
    issues.push({
      severity: "error",
      code: "duplicate-guid",
      message: `GUID ${guid} が複数のアセットで使われています: ${group.map((a) => a.pathname).join(", ")}`,
      guid,
    });
  }

  // パス重複(Windows で問題になるので大文字小文字は区別しない)
  const byPath = new Map<string, AnalyzedAsset[]>();
  for (const a of assets) {
    const key = a.pathname.toLowerCase();
    const group = byPath.get(key);
    if (group) group.push(a);
    else byPath.set(key, [a]);
  }
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    issues.push({
      severity: "error",
      code: "duplicate-pathname",
      message: `${group[0]!.pathname} に複数のアセットがあります: ${group.map((a) => a.guid).join(", ")}`,
      pathname: group[0]!.pathname,
    });
  }

  const files = new Set(assets.filter((a) => a.kind === "file").map((a) => a.pathname));
  const folders = new Set(assets.filter((a) => a.kind === "folder").map((a) => a.pathname));
  const missing = new Set<string>();
  const conflicts = new Set<string>();
  for (const a of assets) {
    for (const dir of ancestors(a.pathname)) {
      if (files.has(dir)) {
        conflicts.add(dir);
      } else if (!folders.has(dir) && !isMetalessRoot(dir)) {
        missing.add(dir);
      }
    }
  }
  for (const path of [...conflicts].sort(compare)) {
    issues.push({
      severity: "error",
      code: "file-folder-conflict",
      message: `${path} はファイルですが、その下にもアセットがあります`,
      pathname: path,
    });
  }

  issues.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compare(a.code, b.code) ||
      compare(a.pathname ?? "", b.pathname ?? "") ||
      compare(a.guid ?? "", b.guid ?? "") ||
      compare(a.message, b.message),
  );

  return {
    formatVersion: 1,
    assets,
    missingFolderMetas: [...missing].sort(compare),
    issues,
    stats: {
      compressedBytes: raw.compressedBytes,
      extractedBytes: raw.extractedBytes,
      entryCount: raw.entryCount,
      fileCount: assets.filter((a) => a.kind === "file").length,
      folderCount: assets.filter((a) => a.kind === "folder").length,
      totalAssetBytes: assets.reduce((sum, a) => sum + (a.size ?? 0), 0),
    },
  };
}
