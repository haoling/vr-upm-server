import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures } from "@vr-upm/fixtures";
import { ApiError, UploadCreateResponse, UploadDetail, UploadListResponse } from "@vr-upm/shared";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { openDb } from "../db/client.js";
import { uploads } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { cleanupIncoming, uploadFilePath, uploadsDir } from "./storage.js";
import { sanitizeFilename } from "./routes.js";

const ORIGIN = "https://upm.example.com";

let fixtureDir: string;
const fixtureBytes = new Map<string, Buffer>();

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "vr-upm-fixtures-"));
  for (const f of fixtures) {
    const file = join(fixtureDir, `${f.name}.unitypackage`);
    await f.write(file);
    fixtureBytes.set(f.name, await readFile(file));
  }
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "vr-upm-ws-"));
  return async () => {
    await rm(workspace, { recursive: true, force: true });
  };
});

function setup(maxUploadBytes = 64 * 1024 * 1024) {
  const db = openDb(":memory:");
  const app = createApp({
    config: {
      MODE: "all",
      ALLOWED_ORIGINS: [ORIGIN],
      WEB_DIST_DIR: undefined,
      WORKSPACE_DIR: workspace,
      MAX_UPLOAD_BYTES: maxUploadBytes,
    },
    db,
  });
  const post = (name: string, body: Uint8Array | null, filename = `${name}.unitypackage`, headers: Record<string, string> = {}) =>
    app.request(`/api/uploads?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/octet-stream", ...headers },
      body,
    });
  const upload = (name: string, filename?: string) => post(name, fixtureBytes.get(name) as Buffer, filename);
  return { app, db, post, upload };
}

async function workspaceFiles(): Promise<string[]> {
  return readdir(uploadsDir(workspace));
}

describe("POST /api/uploads", () => {
  it("保存・解析して Upload を作る", async () => {
    const { upload } = setup();
    const bytes = fixtureBytes.get("simple") as Buffer;
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const res = await upload("simple", "シンプル item.unitypackage");
    expect(res.status).toBe(201);
    const body = UploadCreateResponse.parse(await res.json());
    expect(body).toMatchObject({ created: true, restored: false });
    expect(body.upload).toMatchObject({
      sha256,
      originalFilename: "シンプル item.unitypackage",
      size: bytes.length,
      fileState: "stored",
      fileCount: 3,
    });
    expect(body.upload.analysis?.missingFolderMetas.length).toBeGreaterThan(0);
    expect(body.upload.analysis?.tree.children[0]?.name).toBe("Assets");

    // workspace/uploads/<sha256>.unitypackage に同じ中身が置かれ、残骸は無い
    expect(await workspaceFiles()).toEqual([`${sha256}.unitypackage`]);
    expect(await readFile(uploadFilePath(workspace, sha256))).toEqual(bytes);
  });

  it("同じファイルを 2 回上げても Upload は 1 件のまま", async () => {
    const { upload, app } = setup();
    const first = UploadCreateResponse.parse(await (await upload("simple", "a.unitypackage")).json());
    const secondRes = await upload("simple", "b.unitypackage");
    expect(secondRes.status).toBe(200);
    const second = UploadCreateResponse.parse(await secondRes.json());

    expect(second).toMatchObject({ created: false, restored: false });
    expect(second.upload.id).toBe(first.upload.id);
    // 最初のファイル名のまま
    expect(second.upload.originalFilename).toBe("a.unitypackage");

    const list = UploadListResponse.parse(await (await app.request("/api/uploads")).json());
    expect(list.uploads).toHaveLength(1);
    expect(await workspaceFiles()).toHaveLength(1);
  });

  it("archived / missing の Upload は、再アップロードで元ファイルが戻り stored になる", async () => {
    for (const state of ["archived", "missing"] as const) {
      const { upload, db } = setup();
      const first = UploadCreateResponse.parse(await (await upload("simple")).json());
      await rm(uploadFilePath(workspace, first.upload.sha256));
      db.update(uploads)
        .set({ fileState: state, archivedAt: new Date().toISOString(), archiveNote: "tape-01" })
        .where(eq(uploads.id, first.upload.id))
        .run();

      const res = await upload("simple");
      expect(res.status).toBe(200);
      const again = UploadCreateResponse.parse(await res.json());
      expect(again).toMatchObject({ created: false, restored: true });
      expect(again.upload).toMatchObject({ id: first.upload.id, fileState: "stored", archivedAt: null, archiveNote: "tape-01" });
      expect(await readFile(uploadFilePath(workspace, first.upload.sha256))).toEqual(fixtureBytes.get("simple"));
      expect(await workspaceFiles()).toEqual([`${first.upload.sha256}.unitypackage`]);
      await rm(uploadsDir(workspace), { recursive: true });
      await mkdir(uploadsDir(workspace), { recursive: true });
    }
  });

  it("stored なのに元ファイルが無い場合も、再アップロードで戻す", async () => {
    const { upload } = setup();
    const first = UploadCreateResponse.parse(await (await upload("simple")).json());
    await rm(uploadFilePath(workspace, first.upload.sha256));
    const again = UploadCreateResponse.parse(await (await upload("simple")).json());
    expect(again).toMatchObject({ created: false, restored: false });
    expect(await workspaceFiles()).toEqual([`${first.upload.sha256}.unitypackage`]);
  });

  it("解析結果の問題(issues)を返す", async () => {
    const { upload } = setup();
    const body = UploadCreateResponse.parse(await (await upload("with-issues")).json());
    const codes = body.upload.analysis?.issues.map((i) => i.code) ?? [];
    expect(codes).toContain("missing-meta");
    expect(body.upload.issueCount).toBe(body.upload.analysis?.issues.length);
  });

  it.each(fixtures.filter((f) => f.expectedError))("異常ファイル $name は 422 で拒否し、workspace に何も残さない", async (f) => {
    const { upload, app } = setup();
    const res = await upload(f.name);
    expect(res.status).toBe(422);
    const body = ApiError.parse(await res.json());
    expect(body).toMatchObject({ code: "invalid-unitypackage", reason: f.expectedError });
    expect(await workspaceFiles()).toEqual([]);
    const list = UploadListResponse.parse(await (await app.request("/api/uploads")).json());
    expect(list.uploads).toEqual([]);
  });

  it("unitypackage ではないファイルは 422", async () => {
    const { post, app } = setup();
    const res = await post("x", new TextEncoder().encode("this is not a unitypackage"), "readme.txt");
    expect(res.status).toBe(422);
    expect(ApiError.parse(await res.json()).code).toBe("invalid-unitypackage");
    expect(await workspaceFiles()).toEqual([]);
    expect(UploadListResponse.parse(await (await app.request("/api/uploads")).json()).uploads).toEqual([]);
  });

  it("上限を超えたボディは 413(Content-Length あり)で、何も残さない", async () => {
    const bytes = fixtureBytes.get("simple") as Buffer;
    const { upload, app } = setup(bytes.length - 1);
    const res = await upload("simple");
    expect(res.status).toBe(413);
    expect(ApiError.parse(await res.json()).code).toBe("payload-too-large");
    expect(await workspaceFiles()).toEqual([]);
    expect(UploadListResponse.parse(await (await app.request("/api/uploads")).json()).uploads).toEqual([]);
  });

  it("Content-Length が無い(チャンク転送の)ボディも、受信中に上限で打ち切る", async () => {
    const bytes = fixtureBytes.get("simple") as Buffer;
    const { app } = setup(bytes.length - 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 100));
        controller.enqueue(bytes.subarray(100));
        controller.close();
      },
    });
    const res = await app.request("/api/uploads?filename=a.unitypackage", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: stream,
      duplex: "half",
    });
    expect(res.status).toBe(413);
    expect(await workspaceFiles()).toEqual([]);
  });

  it("空のボディは 400", async () => {
    const { post } = setup();
    const res = await post("x", new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(ApiError.parse(await res.json()).code).toBe("empty-body");
    expect(await workspaceFiles()).toEqual([]);
  });

  it("filename が無い・不正なら 400", async () => {
    const { app } = setup();
    for (const query of ["", "?filename=", "?filename=..", "?filename=%2F"]) {
      const res = await app.request(`/api/uploads${query}`, {
        method: "POST",
        headers: { origin: ORIGIN },
        body: fixtureBytes.get("simple") as Buffer,
      });
      expect(res.status, query).toBe(400);
      expect(ApiError.parse(await res.json()).code).toBe("invalid-filename");
    }
    expect(await workspaceFiles()).toEqual([]);
  });

  it("filename のパス部分は使わない", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\item.unitypackage")).toBe("item.unitypackage");
    expect(sanitizeFilename("a\u0000b.unitypackage")).toBe("ab.unitypackage");
    expect(sanitizeFilename(undefined)).toBeNull();
    expect(sanitizeFilename("x".repeat(256))).toBeNull();
  });

  it("許可されていない Origin からは 403 で、何も保存しない", async () => {
    const { post, app } = setup();
    const res = await post("simple", fixtureBytes.get("simple") as Buffer, "a.unitypackage", { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(ApiError.parse(await res.json()).code).toBe("origin-not-allowed");
    expect(await workspaceFiles()).toEqual([]);
    expect(UploadListResponse.parse(await (await app.request("/api/uploads")).json()).uploads).toEqual([]);
  });

  it("Origin ヘッダが無い(curl 等)リクエストは通す", async () => {
    const { app } = setup();
    const res = await app.request("/api/uploads?filename=a.unitypackage", {
      method: "POST",
      body: fixtureBytes.get("simple") as Buffer,
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/uploads", () => {
  it("新しい順に並べ、件数を含める", async () => {
    const { upload, app } = setup();
    await upload("simple");
    await upload("bundled-liltoon");
    const list = UploadListResponse.parse(await (await app.request("/api/uploads")).json());
    expect(list.uploads.map((u) => u.originalFilename)).toEqual(["bundled-liltoon.unitypackage", "simple.unitypackage"]);
    expect(list.uploads[0]).toMatchObject({ fileCount: 2 });
  });
});

describe("GET /api/uploads/:id", () => {
  it("解析結果(ツリー・問題・統計)込みで返す", async () => {
    const { upload, app } = setup();
    const created = UploadCreateResponse.parse(await (await upload("simple")).json());
    const res = await app.request(`/api/uploads/${created.upload.id}`);
    expect(res.status).toBe(200);
    const detail = UploadDetail.parse(await res.json());
    expect(detail).toEqual(created.upload);
    expect(detail.analysis?.stats.fileCount).toBe(3);
  });

  it("存在しない id は 404、数値でない id も 404", async () => {
    const { app } = setup();
    for (const id of ["999", "abc", "-1"]) {
      const res = await app.request(`/api/uploads/${id}`);
      expect(res.status, id).toBe(404);
      expect(ApiError.parse(await res.json()).code).toBe("not-found");
    }
  });

  it("analysis_json が読めない行でも落ちず、analysis は null", async () => {
    const { app, db } = setup();
    const row = db
      .insert(uploads)
      .values({ sha256: "b".repeat(64), originalFilename: "old.unitypackage", size: 1, analysisJson: { formatVersion: 0 } })
      .returning()
      .get();
    const detail = UploadDetail.parse(await (await app.request(`/api/uploads/${row.id}`)).json());
    expect(detail.analysis).toBeNull();
    expect(detail.fileCount).toBeNull();
  });
});

describe("cleanupIncoming", () => {
  it("受信途中の残骸だけを消す", async () => {
    setup();
    const dir = uploadsDir(workspace);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, ".incoming-abc"), "partial");
    await writeFile(join(dir, `${"c".repeat(64)}.unitypackage`), "keep");
    expect(await cleanupIncoming(workspace)).toBe(1);
    expect(await readdir(dir)).toEqual([`${"c".repeat(64)}.unitypackage`]);
  });
});
