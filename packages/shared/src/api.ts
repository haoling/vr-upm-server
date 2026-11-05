import { z } from "zod";
import { AnalysisIssue, AnalysisStats } from "./analysis.js";

/**
 * server と web で共有する API 契約。
 * リクエスト/レスポンスの形はここに zod スキーマで定義し、両側から import する。
 */

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  mode: z.enum(["all", "api", "worker"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const UploadFileState = z.enum(["stored", "archived", "missing"]);
export type UploadFileState = z.infer<typeof UploadFileState>;

export const BuildStatus = z.enum(["queued", "building", "ready", "published", "failed"]);
export type BuildStatus = z.infer<typeof BuildStatus>;

export const UploadSummary = z.object({
  id: z.number().int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  originalFilename: z.string(),
  size: z.number().int().nonnegative(),
  uploadedAt: z.string(),
  fileState: UploadFileState,
  /** 解析結果から。解析結果が無い(または読めない)場合は null */
  fileCount: z.number().int().nonnegative().nullable(),
  issueCount: z.number().int().nonnegative().nullable(),
});
export type UploadSummary = z.infer<typeof UploadSummary>;

export const UploadListResponse = z.object({
  uploads: z.array(UploadSummary),
});
export type UploadListResponse = z.infer<typeof UploadListResponse>;

/** 解析結果のファイルツリー(`packages/core` の `FileTreeNode` と同じ形) */
export interface FileTreeNode {
  name: string;
  path: string;
  kind: "file" | "folder";
  guid: string | null;
  /** フォルダ .meta が入っておらず、変換時に生成が必要か */
  missingMeta: boolean;
  size: number | null;
  children: FileTreeNode[];
}
export const FileTreeNode: z.ZodType<FileTreeNode> = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "folder"]),
  guid: z.string().nullable(),
  missingMeta: z.boolean(),
  size: z.number().int().nonnegative().nullable(),
  children: z.lazy(() => z.array(FileTreeNode)),
});

export const UploadAnalysis = z.object({
  stats: AnalysisStats,
  issues: z.array(AnalysisIssue),
  /** .meta が入っていないフォルダ(変換時に生成する) */
  missingFolderMetas: z.array(z.string()),
  tree: FileTreeNode,
});
export type UploadAnalysis = z.infer<typeof UploadAnalysis>;

export const UploadDetail = UploadSummary.extend({
  archivedAt: z.string().nullable(),
  archiveNote: z.string().nullable(),
  /** 解析結果が無い(または読めない)場合は null */
  analysis: UploadAnalysis.nullable(),
});
export type UploadDetail = z.infer<typeof UploadDetail>;

/** `POST /api/uploads` の結果 */
export const UploadCreateResponse = z.object({
  /** 新しく作った Upload なら true。既存の Upload に紐付いたなら false */
  created: z.boolean(),
  /** 既存の Upload の元ファイルを戻した(archived / missing → stored)なら true */
  restored: z.boolean(),
  upload: UploadDetail,
});
export type UploadCreateResponse = z.infer<typeof UploadCreateResponse>;

export const ApiErrorCode = z.enum([
  "bad-request",
  "empty-body",
  "invalid-filename",
  "payload-too-large",
  /** unitypackage として解析できなかった */
  "invalid-unitypackage",
  "not-found",
  "origin-not-allowed",
  "internal-error",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.string(),
  code: ApiErrorCode,
  /** `invalid-unitypackage` のとき、core の `UnitypackageAnalysisError.code` */
  reason: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
