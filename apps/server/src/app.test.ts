import { describe, expect, it } from "vitest";
import { UploadListResponse } from "@vr-upm/shared";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";
import { uploads } from "./db/schema.js";

function setup() {
  const db = openDb(":memory:");
  const app = createApp({
    config: { MODE: "all", ALLOWED_ORIGINS: ["https://upm.example.com"], WEB_DIST_DIR: undefined },
    db,
  });
  return { app, db };
}

describe("API", () => {
  it("GET /api/health", async () => {
    const { app } = setup();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", mode: "all" });
  });

  it("GET /api/uploads は DB の内容を返す", async () => {
    const { app, db } = setup();
    db.insert(uploads)
      .values({ sha256: "a".repeat(64), originalFilename: "item.unitypackage", size: 123 })
      .run();
    const res = await app.request("/api/uploads");
    const body = UploadListResponse.parse(await res.json());
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0]).toMatchObject({ originalFilename: "item.unitypackage", fileState: "stored" });
  });

  it("許可されていない Origin からの POST を拒否する", async () => {
    const { app } = setup();
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("許可された Origin からの POST は通す", async () => {
    const { app } = setup();
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { origin: "https://upm.example.com" },
    });
    // ルートは未実装なので 404(Origin チェックは通過している)
    expect(res.status).toBe(404);
  });
});
