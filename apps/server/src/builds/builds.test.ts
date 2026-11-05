import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures } from "@vr-upm/fixtures";
import {
  ApiError,
  type BuildDetail as BuildDetailT,
  BuildDetail,
  BuildListResponse,
  type ConvertConfigInput,
  PackageDetail,
  PackageListResponse,
} from "@vr-upm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { openDb } from "../db/client.js";
import { builds, uploads } from "../db/schema.js";
import { uploadFilePath } from "../uploads/storage.js";
import { claimNextBuild, processBuild, recoverBuilds, runPendingBuilds } from "./runner.js";
import { buildDir, buildsDir, tarballPath } from "./storage.js";

const ORIGIN = "https://upm.example.com";

const CONFIG: ConvertConfigInput = {
  packageName: "com.example.dummyshop.dummyitem",
  displayName: "Dummy Item",
  version: "1.0.0",
  sourceVersionLabel: "Ver.1.0",
  rootPath: "Assets/DummyShop/DummyItem",
  exclude: ["Textures/**"],
  boothUrl: "https://dummyshop.booth.pm/items/1",
};

let fixtureDir: string;
beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "vr-upm-m4-fixtures-"));
  for (const f of fixtures) await f.write(join(fixtureDir, `${f.name}.unitypackage`));
});
afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "vr-upm-m4-ws-"));
  return async () => {
    await rm(workspace, { recursive: true, force: true });
  };
});

function setup() {
  const db = openDb(":memory:");
  const app = createApp({
    config: { MODE: "all", ALLOWED_ORIGINS: [ORIGIN], WEB_DIST_DIR: undefined, WORKSPACE_DIR: workspace, MAX_UPLOAD_BYTES: 64 * 1024 * 1024 },
    db,
  });
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const uploadFixture = async (name: string) => {
    const res = await app.request(`/api/uploads?filename=${name}.unitypackage`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: await readFile(join(fixtureDir, `${name}.unitypackage`)),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { upload: { id: number } }).upload.id;
  };
  const createPackage = async (config: ConvertConfigInput = CONFIG) => {
    const res = await json("POST", "/api/packages", { config });
    expect(res.status).toBe(201);
    return PackageDetail.parse(await res.json());
  };
  const createBuild = (packageId: number, uploadId: number) => json("POST", "/api/builds", { packageId, uploadId });
  const getBuild = async (id: number) => BuildDetail.parse(await (await json("GET", `/api/builds/${id}`)).json());
  /** Build を作って Worker に処理させる */
  const buildAndRun = async (packageId: number, uploadId: number): Promise<BuildDetailT> => {
    const res = await createBuild(packageId, uploadId);
    expect(res.status).toBe(201);
    const created = BuildDetail.parse(await res.json());
    await runPendingBuilds(db, workspace);
    return getBuild(created.id);
  };
  return { app, db, json, uploadFixture, createPackage, createBuild, getBuild, buildAndRun };
}

describe("Package API", () => {
  it("作成・取得・一覧・編集ができる", async () => {
    const { json, createPackage } = setup();
    const created = await createPackage();
    expect(created).toMatchObject({
      name: "com.example.dummyshop.dummyitem",
      displayName: "Dummy Item",
      version: "1.0.0",
      sourceUrl: "https://dummyshop.booth.pm/items/1",
      config: { rootPath: "Assets/DummyShop/DummyItem", exclude: ["Textures/**"] },
    });

    const list = PackageListResponse.parse(await (await json("GET", "/api/packages")).json());
    expect(list.packages.map((p) => p.id)).toEqual([created.id]);

    const res = await json("PUT", `/api/packages/${created.id}`, {
      config: { ...CONFIG, displayName: "Renamed", version: "1.1.0", exclude: [] },
    });
    expect(res.status).toBe(200);
    expect(PackageDetail.parse(await res.json())).toMatchObject({ displayName: "Renamed", version: "1.1.0", config: { exclude: [] } });
    const got = PackageDetail.parse(await (await json("GET", `/api/packages/${created.id}`)).json());
    expect(got.config.version).toBe("1.1.0");
  });

  it("rootPath の正規化など、ConvertConfig の検証を通す", async () => {
    const { json } = setup();
    const ok = await json("POST", "/api/packages", { config: { ...CONFIG, rootPath: "/Assets/DummyShop/DummyItem/" } });
    expect(PackageDetail.parse(await ok.json()).config.rootPath).toBe("Assets/DummyShop/DummyItem");

    for (const bad of [
      { ...CONFIG, packageName: "Bad Name", rootPath: "Assets/a" },
      { ...CONFIG, packageName: "com.example.other", version: "1.0" },
      { ...CONFIG, packageName: "com.example.other", rootPath: "Assets/../x" },
    ]) {
      const res = await json("POST", "/api/packages", { config: bad });
      expect(res.status).toBe(400);
      expect(ApiError.parse(await res.json()).code).toBe("invalid-request");
    }
    expect((await json("POST", "/api/packages", {})).status).toBe(400);
  });

  it("同じパッケージ名は 409、パッケージ名の変更は 400、無い ID は 404", async () => {
    const { json, createPackage } = setup();
    const pkg = await createPackage();
    const dup = await json("POST", "/api/packages", { config: CONFIG });
    expect(dup.status).toBe(409);
    expect(ApiError.parse(await dup.json()).code).toBe("duplicate-package-name");

    const rename = await json("PUT", `/api/packages/${pkg.id}`, { config: { ...CONFIG, packageName: "com.example.renamed" } });
    expect(rename.status).toBe(400);
    expect((await json("GET", "/api/packages/999")).status).toBe(404);
    expect((await json("GET", "/api/packages/abc")).status).toBe(404);
    expect((await json("PUT", "/api/packages/999", { config: CONFIG })).status).toBe(404);
  });

  it("Origin が許可されていない書き込みは拒否する", async () => {
    const { app } = setup();
    const res = await app.request("/api/packages", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ config: CONFIG }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/builds と Worker", () => {
  it("queued の Build を作り、Worker が ready にして tarball と dry-run を残す", async () => {
    const { uploadFixture, createPackage, createBuild, getBuild, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();

    const res = await createBuild(pkg.id, uploadId);
    expect(res.status).toBe(201);
    const created = BuildDetail.parse(await res.json());
    expect(created).toMatchObject({ status: "queued", version: "1.0.0", sourceVersionLabel: "Ver.1.0", dryRun: null, tarballIntegrity: null });

    expect(await runPendingBuilds(db, workspace)).toBe(1);
    const build = await getBuild(created.id);
    expect(build.status).toBe("ready");
    expect(build.tarballIntegrity).toMatch(/^sha512-/);
    expect(build.tarballSize).toBeGreaterThan(0);
    expect(build.log).toContain("tarball を作りました");

    // dry-run: package.json が先頭、除外した Textures は入らない
    const paths = build.dryRun?.files.map((f) => f.path) ?? [];
    expect(paths.slice(0, 2)).toEqual(["package.json", "package.json.meta"]);
    expect(paths).toContain("Models/body.fbx");
    expect(paths.some((p) => p.startsWith("Textures"))).toBe(false);
    expect(build.dryRun?.excluded).toContain("Textures/body.png");
    expect(build.dryRun?.totalSize).toBe(build.dryRun?.files.reduce((s, f) => s + f.size, 0));
    expect(build.dryRun?.errors).toEqual([]);

    // 作業領域には tarball だけが残る(展開した asset は消える)
    expect(await readdir(buildDir(workspace, build.id))).toEqual(["package.tgz"]);
    const listed = execFileSync("tar", ["tzf", tarballPath(workspace, build.id)], { encoding: "utf8" }).split("\n");
    expect(listed).toContain("package/package.json");
    expect(listed).toContain("package/Models/body.fbx");
    expect(listed.some((p) => p.startsWith("package/Textures"))).toBe(false);
  });

  it("同じ入力・設定なら integrity が同じ(決定的)", async () => {
    const { uploadFixture, createPackage, buildAndRun } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const a = await buildAndRun(pkg.id, uploadId);
    const b = await buildAndRun(pkg.id, uploadId);
    expect(a.id).not.toBe(b.id);
    expect(a.tarballIntegrity).toBe(b.tarballIntegrity);
  });

  it("設定スナップショットは、後から Package を編集しても変わらない", async () => {
    const { uploadFixture, createPackage, createBuild, getBuild, json, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const first = BuildDetail.parse(await (await createBuild(pkg.id, uploadId)).json());

    // queued のうちに Package を編集する。Worker は編集前のスナップショットでビルドする
    await json("PUT", `/api/packages/${pkg.id}`, { config: { ...CONFIG, version: "2.0.0", exclude: [], displayName: "Edited" } });
    await runPendingBuilds(db, workspace);
    const built = await getBuild(first.id);
    expect(built).toMatchObject({ status: "ready", version: "1.0.0", config: { version: "1.0.0", exclude: ["Textures/**"], displayName: "Dummy Item" } });
    expect(built.dryRun?.files.some((f) => f.path.startsWith("Textures"))).toBe(false);
    const tgzJson = execFileSync("tar", ["xzOf", tarballPath(workspace, first.id), "package/package.json"], { encoding: "utf8" });
    expect(JSON.parse(tgzJson)).toMatchObject({ version: "1.0.0", displayName: "Dummy Item" });

    // 編集後に作った Build は新しい設定になる
    const second = BuildDetail.parse(await (await createBuild(pkg.id, uploadId)).json());
    expect(second).toMatchObject({ version: "2.0.0", config: { version: "2.0.0", exclude: [] } });
    // 古い Build は変わらない
    expect((await getBuild(first.id)).config.version).toBe("1.0.0");
  });

  it("変換計画にエラーがあれば failed。dry-run とログは残り、tarball と作業領域は残らない", async () => {
    const { uploadFixture, createPackage, buildAndRun } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage({ ...CONFIG, packageName: "com.example.noroot", rootPath: "Assets/Nowhere" });
    const build = await buildAndRun(pkg.id, uploadId);
    expect(build.status).toBe("failed");
    expect(build.tarballIntegrity).toBeNull();
    expect(build.dryRun?.errors.map((e) => e.code)).toContain("root-not-found");
    expect(build.log).toContain("root-not-found");
    expect(await readdir(buildsDir(workspace))).toEqual([]);
  });

  it("元ファイルが無い Upload は、ビルド作成を 409 で拒否する(再アップロードで続行できる)", async () => {
    const { uploadFixture, createPackage, createBuild, app, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const upload = db.select().from(uploads).where(eq(uploads.id, uploadId)).get()!;
    await rm(uploadFilePath(workspace, upload.sha256));

    const res = await createBuild(pkg.id, uploadId);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe("source-file-missing");
    expect(db.select().from(builds).all()).toHaveLength(0);
    expect(db.select().from(uploads).where(eq(uploads.id, uploadId)).get()?.fileState).toBe("missing");

    // 同じファイルを再アップロードすると既存の Upload に戻り、ビルドできる
    const again = await app.request("/api/uploads?filename=simple.unitypackage", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: await readFile(join(fixtureDir, "simple.unitypackage")),
    });
    expect(again.status).toBe(200);
    expect((await createBuild(pkg.id, uploadId)).status).toBe(201);
  });

  it("キューに入った後で元ファイルが消えたら、Worker は failed にする", async () => {
    const { uploadFixture, createPackage, createBuild, getBuild, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const created = BuildDetail.parse(await (await createBuild(pkg.id, uploadId)).json());
    const upload = db.select().from(uploads).where(eq(uploads.id, uploadId)).get()!;
    await rm(uploadFilePath(workspace, upload.sha256));

    await runPendingBuilds(db, workspace);
    const build = await getBuild(created.id);
    expect(build.status).toBe("failed");
    expect(build.log).toContain("再アップロード");
    expect(build.dryRun).toBeNull();
    expect(db.select().from(uploads).where(eq(uploads.id, uploadId)).get()?.fileState).toBe("missing");
  });

  it("元ファイルの中身が登録時と違えば failed", async () => {
    const { uploadFixture, createPackage, createBuild, getBuild, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const created = BuildDetail.parse(await (await createBuild(pkg.id, uploadId)).json());
    const upload = db.select().from(uploads).where(eq(uploads.id, uploadId)).get()!;
    await writeFile(uploadFilePath(workspace, upload.sha256), await readFile(join(fixtureDir, "bundled-liltoon.unitypackage")));

    await runPendingBuilds(db, workspace);
    const build = await getBuild(created.id);
    expect(build.status).toBe("failed");
    expect(build.log).toContain("sha256");
  });

  it("壊れた unitypackage は failed(例外にしない)", async () => {
    const { db, createPackage, getBuild, createBuild } = setup();
    const pkg = await createPackage();
    const bytes = Buffer.from("not a gzip");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(workspace, "uploads"), { recursive: true });
    await writeFile(uploadFilePath(workspace, sha256), bytes);
    const upload = db.insert(uploads).values({ sha256, originalFilename: "broken.unitypackage", size: bytes.length }).returning().get();

    const created = BuildDetail.parse(await (await createBuild(pkg.id, upload.id)).json());
    await runPendingBuilds(db, workspace);
    const build = await getBuild(created.id);
    expect(build.status).toBe("failed");
    expect(build.log).toContain("解析できません");
  });

  it("存在しない package / upload は 404、不正なボディは 400", async () => {
    const { uploadFixture, createPackage, createBuild, json } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    expect((await createBuild(999, uploadId)).status).toBe(404);
    expect((await createBuild(pkg.id, 999)).status).toBe(404);
    expect((await json("POST", "/api/builds", { packageId: "x" })).status).toBe(400);
  });

  it("publish 済みの version には新しい Build を作れない", async () => {
    const { uploadFixture, createPackage, createBuild, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    db.insert(builds).values({ packageId: pkg.id, uploadId, version: "1.0.0", configSnapshot: CONFIG, status: "published" }).run();
    const res = await createBuild(pkg.id, uploadId);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe("version-already-published");
  });
});

describe("Build の一覧・破棄", () => {
  it("一覧は新しい順で、dry-run は含まない", async () => {
    const { uploadFixture, createPackage, buildAndRun, json } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const a = await buildAndRun(pkg.id, uploadId);
    const b = await buildAndRun(pkg.id, uploadId);
    const list = BuildListResponse.parse(await (await json("GET", "/api/builds")).json());
    expect(list.builds.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list.builds[0]).toMatchObject({ packageName: CONFIG.packageName, uploadFilename: "simple.unitypackage", status: "ready" });
    expect(list.builds[0]).not.toHaveProperty("dryRun");
    expect((await json("GET", "/api/builds/999")).status).toBe(404);
  });

  it("ready の Build を破棄すると、レコードと tarball が消える", async () => {
    const { uploadFixture, createPackage, buildAndRun, json } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const build = await buildAndRun(pkg.id, uploadId);
    expect(await readdir(buildDir(workspace, build.id))).toEqual(["package.tgz"]);

    const res = await json("DELETE", `/api/builds/${build.id}`);
    expect(res.status).toBe(204);
    expect((await json("GET", `/api/builds/${build.id}`)).status).toBe(404);
    expect(await readdir(buildsDir(workspace))).toEqual([]);
    expect((await json("DELETE", `/api/builds/${build.id}`)).status).toBe(404);
  });

  it("building と published の Build は破棄できない", async () => {
    const { uploadFixture, createPackage, createBuild, json, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const created = BuildDetail.parse(await (await createBuild(pkg.id, uploadId)).json());
    claimNextBuild(db);
    const building = await json("DELETE", `/api/builds/${created.id}`);
    expect(building.status).toBe(409);
    expect(ApiError.parse(await building.json()).code).toBe("invalid-state");

    db.update(builds).set({ status: "published" }).where(eq(builds.id, created.id)).run();
    expect((await json("DELETE", `/api/builds/${created.id}`)).status).toBe(409);
  });

  it("ビルド中に破棄された Build の作業領域は残さない", async () => {
    const { uploadFixture, createPackage, createBuild, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    await createBuild(pkg.id, uploadId);
    const claimed = claimNextBuild(db)!;
    db.delete(builds).where(eq(builds.id, claimed.id)).run(); // 処理の途中でレコードが消えた
    await processBuild(db, workspace, claimed);
    expect(await readdir(buildsDir(workspace))).toEqual([]);
  });
});

describe("recoverBuilds(起動時の掃除)", () => {
  it("building の Build を queued に戻し、ready 以外の作業領域を消す", async () => {
    const { uploadFixture, createPackage, buildAndRun, createBuild, db } = setup();
    const uploadId = await uploadFixture("simple");
    const pkg = await createPackage();
    const ready = await buildAndRun(pkg.id, uploadId);
    const stuck = BuildDetail.parse(await (await createBuild(pkg.id, uploadId)).json());
    claimNextBuild(db); // building のまま落ちた想定
    await mkdir(join(buildDir(workspace, stuck.id), "assets"), { recursive: true });
    await writeFile(join(buildDir(workspace, stuck.id), "assets", "0.bin"), "partial");
    await mkdir(join(buildsDir(workspace), "9999"), { recursive: true }); // DB にない Build の残骸
    await mkdir(join(buildsDir(workspace), "not-a-build"), { recursive: true });

    const result = await recoverBuilds(db, workspace);
    expect(result).toEqual({ requeued: 1, removedDirs: 3 });
    expect((await readdir(buildsDir(workspace))).sort()).toEqual([String(ready.id)]);
    expect(db.select().from(builds).where(eq(builds.id, stuck.id)).get()?.status).toBe("queued");

    // 戻された Build は次の Worker で最後まで処理される
    expect(await runPendingBuilds(db, workspace)).toBe(1);
    expect(db.select().from(builds).where(eq(builds.id, stuck.id)).get()?.status).toBe("ready");
  });

  it("builds ディレクトリが無くても動く", async () => {
    const { db } = setup();
    expect(await recoverBuilds(db, join(workspace, "fresh"))).toEqual({ requeued: 0, removedDirs: 0 });
  });
});
