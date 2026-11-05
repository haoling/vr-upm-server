import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db/client.js";
import { createOriginMatcher } from "./middleware/origin-check.js";

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

describe("createOriginMatcher", () => {
  const matcher = createOriginMatcher(["https://upm.example.com", "https://*.coder.example.com", "http://*.dev.example.com:5173"]);

  it("完全一致とサブドメインのワイルドカードを許可する", () => {
    expect(matcher("https://upm.example.com")).toBe(true);
    expect(matcher("https://abc.coder.example.com")).toBe(true);
    expect(matcher("https://a.b.coder.example.com")).toBe(true);
    expect(matcher("http://x.dev.example.com:5173")).toBe(true);
  });

  it("ワイルドカードは scheme・ポート・ラベル境界が違えば許可しない", () => {
    expect(matcher("http://abc.coder.example.com")).toBe(false);
    expect(matcher("https://abc.coder.example.com:8443")).toBe(false);
    expect(matcher("https://coder.example.com")).toBe(false);
    expect(matcher("https://evilcoder.example.com")).toBe(false);
    expect(matcher("https://abc.coder.example.com.evil.example")).toBe(false);
    expect(matcher("http://x.dev.example.com")).toBe(false);
    expect(matcher("null")).toBe(false);
    expect(matcher("https://other.example")).toBe(false);
  });

  it("壊れたワイルドカード設定は何も許可しない", () => {
    const bad = createOriginMatcher(["*", "https://*", "https://*.*.example.com", "*.example.com"]);
    expect(bad("https://a.example.com")).toBe(false);
  });
});
