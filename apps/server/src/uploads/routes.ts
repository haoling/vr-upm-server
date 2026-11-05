import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { analyzeUnitypackage, buildFileTree, UnitypackageAnalysisError } from "@vr-upm/core";
import {
  AnalysisResult,
  type ApiError,
  type UploadAnalysis,
  type UploadCreateResponse,
  type UploadDetail,
  type UploadListResponse,
  type UploadSummary,
} from "@vr-upm/shared";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { uploads } from "../db/schema.js";
import { BodyTooLargeError, receiveToFile } from "./receive.js";
import { ensureUploadsDir, incomingFilePath, uploadFilePath } from "./storage.js";

export interface UploadRoutesDeps {
  db: Db;
  workspaceDir: string;
  /** アップロードボディの上限(バイト) */
  maxUploadBytes: number;
}

type UploadRow = typeof uploads.$inferSelect;

/** 保存済みの analysis_json を読む。無い・読めない(古い形式など)場合は null */
function parseAnalysis(row: UploadRow): AnalysisResult | null {
  if (row.analysisJson == null) return null;
  const parsed = AnalysisResult.safeParse(row.analysisJson);
  return parsed.success ? parsed.data : null;
}

function toSummary(row: UploadRow, analysis: AnalysisResult | null): UploadSummary {
  return {
    id: row.id,
    sha256: row.sha256,
    originalFilename: row.originalFilename,
    size: row.size,
    uploadedAt: row.uploadedAt,
    fileState: row.fileState,
    fileCount: analysis?.stats.fileCount ?? null,
    issueCount: analysis?.issues.length ?? null,
  };
}

function toDetail(row: UploadRow): UploadDetail {
  const analysis = parseAnalysis(row);
  const detail: UploadAnalysis | null = analysis && {
    stats: analysis.stats,
    issues: analysis.issues,
    missingFolderMetas: analysis.missingFolderMetas,
    tree: buildFileTree(analysis),
  };
  return {
    ...toSummary(row, analysis),
    archivedAt: row.archivedAt,
    archiveNote: row.archiveNote,
    analysis: detail,
  };
}

/** クライアントが付けた名前から、表示用のファイル名だけを取り出す(パスは使わない) */
export function sanitizeFilename(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  // 制御文字を除く
  const name = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name === "" || name === "." || name === ".." || name.length > 255) return null;
  return name;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * アップロードと Upload の参照(DESIGN.md 3.1)。
 *
 * `POST /uploads?filename=<名前>`: ボディに unitypackage をそのまま入れる(multipart ではない)。
 */
export function uploadRoutes({ db, workspaceDir, maxUploadBytes }: UploadRoutesDeps) {
  ensureUploadsDir(workspaceDir);
  const fail = (status: 400 | 404 | 413 | 422 | 500, body: ApiError) => Response.json(body, { status });

  return new Hono()
    .get("/", (c) => {
      const rows = db.select().from(uploads).orderBy(desc(uploads.id)).all();
      const body: UploadListResponse = { uploads: rows.map((r) => toSummary(r, parseAnalysis(r))) };
      return c.json(body);
    })
    .get("/:id", (c) => {
      const id = Number(c.req.param("id"));
      const row = Number.isSafeInteger(id) ? db.select().from(uploads).where(eq(uploads.id, id)).get() : undefined;
      if (!row) return fail(404, { error: "upload not found", code: "not-found" });
      return c.json(toDetail(row));
    })
    .post("/", async (c) => {
      const filename = sanitizeFilename(c.req.query("filename"));
      if (filename === null) return fail(400, { error: "filename query parameter is required", code: "invalid-filename" });

      const declared = c.req.header("content-length");
      if (declared !== undefined && Number(declared) > maxUploadBytes) {
        return fail(413, { error: `upload exceeds ${maxUploadBytes} bytes`, code: "payload-too-large" });
      }
      const body = c.req.raw.body;
      if (!body) return fail(400, { error: "request body is empty", code: "empty-body" });

      const incoming = incomingFilePath(workspaceDir, randomUUID());
      try {
        let received;
        try {
          received = await receiveToFile(body, incoming, maxUploadBytes);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            return fail(413, { error: `upload exceeds ${maxUploadBytes} bytes`, code: "payload-too-large" });
          }
          throw err;
        }
        if (received.size === 0) return fail(400, { error: "request body is empty", code: "empty-body" });

        const { sha256, size } = received;
        const dest = uploadFilePath(workspaceDir, sha256);
        const existing = db.select().from(uploads).where(eq(uploads.sha256, sha256)).get();

        if (existing) {
          // 同じ内容は既存の Upload に紐付ける。元ファイルが無ければ戻して stored にする
          const needsFile = existing.fileState !== "stored" || !(await exists(dest));
          let analysisJson = existing.analysisJson;
          if (needsFile && analysisJson == null) {
            analysisJson = await analyze(incoming, maxUploadBytes);
          }
          if (needsFile) await rename(incoming, dest);
          const restored = existing.fileState !== "stored";
          if (needsFile || analysisJson !== existing.analysisJson) {
            db.update(uploads)
              .set({ fileState: "stored", archivedAt: null, analysisJson })
              .where(eq(uploads.id, existing.id))
              .run();
          }
          const row = db.select().from(uploads).where(eq(uploads.id, existing.id)).get() as UploadRow;
          return c.json({ created: false, restored, upload: toDetail(row) } satisfies UploadCreateResponse);
        }

        const analysis = await analyze(incoming, maxUploadBytes);
        await rename(incoming, dest);
        let row: UploadRow | undefined;
        try {
          row = db
            .insert(uploads)
            .values({ sha256, originalFilename: filename, size, analysisJson: analysis })
            .onConflictDoNothing()
            .returning()
            .get();
        } catch (err) {
          await rm(dest, { force: true });
          throw err;
        }
        if (!row) {
          // 同じファイルの同時アップロードで、先に別のリクエストが登録した
          const winner = db.select().from(uploads).where(eq(uploads.sha256, sha256)).get() as UploadRow;
          return c.json({ created: false, restored: false, upload: toDetail(winner) } satisfies UploadCreateResponse);
        }
        return c.json({ created: true, restored: false, upload: toDetail(row) } satisfies UploadCreateResponse, 201);
      } catch (err) {
        if (err instanceof UnitypackageAnalysisError) {
          const status = err.code === "input-too-large" ? 413 : 422;
          return fail(status, {
            error: `not a valid unitypackage: ${err.message}`,
            code: status === 413 ? "payload-too-large" : "invalid-unitypackage",
            reason: err.code,
          });
        }
        console.error("[api] upload failed", err);
        return fail(500, { error: "upload failed", code: "internal-error" });
      } finally {
        // 正式な名前に移した後は no-op。失敗・拒否・重複のときは受信ファイルを残さない
        await rm(incoming, { force: true });
      }
    });
}

async function analyze(file: string, maxInputBytes: number): Promise<AnalysisResult> {
  return analyzeUnitypackage(createReadStream(file), { limits: { maxInputBytes } });
}
