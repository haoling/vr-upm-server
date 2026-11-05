import { z } from "zod";

/**
 * unitypackage の解析結果(DESIGN.md 3.1)。
 *
 * `packages/core` の `analyzeUnitypackage` が返し、DB の `Upload.analysis_json` にそのまま保存する。
 * 形を変えるときは `formatVersion` を上げ、古い JSON を読めるようにすること。
 */

const Guid = z.string().regex(/^[0-9a-f]{32}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const AnalysisIssueSeverity = z.enum(["error", "warning", "info"]);
export type AnalysisIssueSeverity = z.infer<typeof AnalysisIssueSeverity>;

export const AnalysisIssueCode = z.enum([
  /** asset.meta 内の guid がディレクトリ名の GUID と一致しない */
  "meta-guid-mismatch",
  /** asset.meta が無い、または guid 行が読めない */
  "missing-meta",
  /** pathname が無いエントリ(無視する) */
  "missing-pathname",
  /** 同じ GUID を持つアセットが複数ある(asset.meta の guid で判定) */
  "duplicate-guid",
  /** 同じパス(大文字小文字は区別しない)に複数のアセットがある */
  "duplicate-pathname",
  /** 同じ tar エントリが複数回出てきた(後のものを無視する) */
  "duplicate-entry",
  /** ディレクトリ名が Unity の GUID 形式(32 桁の 16 進数)ではない */
  "invalid-guid",
  /** `<guid>/asset` などの既知の形に当てはまらないエントリ(無視する) */
  "unexpected-entry",
  /** ファイルとして入っているパスの下に、さらにアセットがある */
  "file-folder-conflict",
]);
export type AnalysisIssueCode = z.infer<typeof AnalysisIssueCode>;

export const AnalysisIssue = z.object({
  severity: AnalysisIssueSeverity,
  code: AnalysisIssueCode,
  message: z.string(),
  guid: z.string().optional(),
  pathname: z.string().optional(),
});
export type AnalysisIssue = z.infer<typeof AnalysisIssue>;

export const AnalyzedAsset = z.object({
  /** ディレクトリ名の GUID */
  guid: z.string(),
  /** 正規化済みのパス(例: `Assets/Shop/Item/a.fbx`) */
  pathname: z.string(),
  /** `asset` を持たないエントリはフォルダ(フォルダ .meta だけが入っている) */
  kind: z.enum(["file", "folder"]),
  /** `asset` のバイト数(フォルダは null) */
  size: z.number().int().nonnegative().nullable(),
  /** `asset` の sha256(フォルダは null) */
  sha256: Sha256.nullable(),
  /** asset.meta に書かれた guid(asset.meta が無い・読めない場合は null) */
  metaGuid: Guid.nullable(),
  hasPreview: z.boolean(),
});
export type AnalyzedAsset = z.infer<typeof AnalyzedAsset>;

export const AnalysisStats = z.object({
  /** 入力(gzip 圧縮済み)のバイト数 */
  compressedBytes: z.number().int().nonnegative(),
  /** 展開後の tar のバイト数 */
  extractedBytes: z.number().int().nonnegative(),
  /** tar のエントリ数(ディレクトリを含む) */
  entryCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  folderCount: z.number().int().nonnegative(),
  /** `asset` の合計バイト数 */
  totalAssetBytes: z.number().int().nonnegative(),
});
export type AnalysisStats = z.infer<typeof AnalysisStats>;

export const AnalysisResult = z.object({
  formatVersion: z.literal(1),
  /** pathname 順に並べたアセット(フォルダエントリを含む) */
  assets: z.array(AnalyzedAsset),
  /** .meta が入っていないフォルダのパス(`Assets` と `Packages/<name>` 自体は除く)。ソート済み */
  missingFolderMetas: z.array(z.string()),
  issues: z.array(AnalysisIssue),
  stats: AnalysisStats,
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;
