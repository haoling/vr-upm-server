import { z } from "zod";
import { AnalysisIssue, AnalysisStats } from "./analysis.js";
import { ConvertConfig } from "./convert.js";

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
  /** リクエストの JSON・値が正しくない */
  "invalid-request",
  /** 同じ UPM パッケージ名の Package が既にある */
  "duplicate-package-name",
  /** 元ファイルが workspace に無い(再アップロードが必要) */
  "source-file-missing",
  /** 同じパッケージ・version の publish 済み Build がある */
  "version-already-published",
  /** 状態のせいでその操作はできない(ビルド中の破棄など) */
  "invalid-state",
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

// ---- Package(変換設定。DESIGN.md 3.2) ----

export const PackageSummary = z.object({
  id: z.number().int(),
  /** UPM パッケージ名。作成後は変えられない */
  name: z.string(),
  displayName: z.string(),
  /** 設定の version */
  version: z.string(),
  sourceUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type PackageSummary = z.infer<typeof PackageSummary>;

export const PackageListResponse = z.object({ packages: z.array(PackageSummary) });
export type PackageListResponse = z.infer<typeof PackageListResponse>;

export const PackageDetail = PackageSummary.extend({ config: ConvertConfig });
export type PackageDetail = z.infer<typeof PackageDetail>;

/** `POST /api/packages`、`PUT /api/packages/:id` のボディ */
export const PackageSaveRequest = z.object({ config: ConvertConfig });
export type PackageSaveRequest = z.input<typeof PackageSaveRequest>;

// ---- Build(DESIGN.md 3.3) ----

/** `POST /api/builds` のボディ。変換設定は Package の保存済みの設定をその時点でスナップショットする */
export const BuildCreateRequest = z.object({
  packageId: z.number().int().positive(),
  uploadId: z.number().int().positive(),
});
export type BuildCreateRequest = z.infer<typeof BuildCreateRequest>;

export const DryRunFile = z.object({
  /** tarball 内の `package/` を除いたパス */
  path: z.string(),
  size: z.number().int().nonnegative(),
  origin: z.enum(["asset", "meta", "generated-meta", "package"]),
});
export type DryRunFile = z.infer<typeof DryRunFile>;

export const DryRunMessage = z.object({ code: z.string(), message: z.string(), path: z.string().optional() });
export type DryRunMessage = z.infer<typeof DryRunMessage>;

/** tarball に入るものの一覧(`packages/core` の `UpmPlan` を保存用にしたもの) */
export const DryRunReport = z.object({
  files: z.array(DryRunFile),
  /** files のサイズ合計(展開後) */
  totalSize: z.number().int().nonnegative(),
  errors: z.array(DryRunMessage),
  warnings: z.array(DryRunMessage),
  /** ルートの外にあって取り込まなかったアセットの数 */
  outsideRootCount: z.number().int().nonnegative(),
  /** 除外 glob に一致して取り込まなかったパス(ルートを剥がした後) */
  excluded: z.array(z.string()),
});
export type DryRunReport = z.infer<typeof DryRunReport>;

export const BuildSummary = z.object({
  id: z.number().int(),
  packageId: z.number().int(),
  packageName: z.string(),
  uploadId: z.number().int(),
  uploadFilename: z.string(),
  version: z.string(),
  sourceVersionLabel: z.string().nullable(),
  status: BuildStatus,
  tarballIntegrity: z.string().nullable(),
  tarballSize: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});
export type BuildSummary = z.infer<typeof BuildSummary>;

export const BuildListResponse = z.object({ builds: z.array(BuildSummary) });
export type BuildListResponse = z.infer<typeof BuildListResponse>;

export const BuildDetail = BuildSummary.extend({
  /** ビルド時点の設定のスナップショット(Package を後から編集しても変わらない) */
  config: ConvertConfig,
  log: z.string(),
  /** まだ処理されていない Build は null */
  dryRun: DryRunReport.nullable(),
});
export type BuildDetail = z.infer<typeof BuildDetail>;
