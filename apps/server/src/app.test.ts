import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";

function setup() {
  const db = openDb(":memory:");
  const app = createApp({
    config: {
      MODE: "all",
      ALLOWED_ORIGINS: ["https://upm.example.com"],
      WEB_DIST_DIR: undefined,
      WORKSPACE_DIR: mkdtempSync(join(tmpdir(), "vr-upm-app-")),
      MAX_UPLOAD_BYTES: 1024,
    },
    db,
  });
  return { app, db };
}

// アップロード API は uploads/uploads.test.ts

describe("API", () => {
  it("GET /api/health", async () => {
    const { app } = setup();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", mode: "all" });
  });

  it("許可されていない Origin からの状態変更を拒否する", async () => {
    const { app } = setup();
    const res = await app.request("/api/health", { method: "POST", headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(403);
  });

  it("許可された Origin からは Origin チェックを通過する", async () => {
    const { app } = setup();
    const res = await app.request("/api/health", { method: "POST", headers: { origin: "https://upm.example.com" } });
    // POST できるルートではないので 404(Origin チェックは通過している)
    expect(res.status).toBe(404);
  });
});
