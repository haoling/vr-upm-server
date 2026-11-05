import { z } from "zod";

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
});
export type UploadSummary = z.infer<typeof UploadSummary>;

export const UploadListResponse = z.object({
  uploads: z.array(UploadSummary),
});
export type UploadListResponse = z.infer<typeof UploadListResponse>;
