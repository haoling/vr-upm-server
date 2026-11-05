import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures } from "@vr-upm/fixtures";
import { ApiError, BuildDetail, type ConvertConfigInput, PackageDetail, PublishedListResponse, RegistryInfo } from "@vr-upm/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { openDb } from "../db/client.js";
import { builds } from "../db/schema.js";
import { loginForToken, startVerdaccio, type TestVerdaccio } from "../test-support/verdaccio.js";
import { integrityOf } from "./publish.js";
import { runPendingBuilds } from "./runner.js";
import { buildDir, tarballPath } from "./storage.js";

const ORIGIN = "https://upm.example.com";
const PUBLISHER = { name: "publisher", password: "publisher-pass" };
const UNITY = { name: "unity", password: "unity-pass" };

let verdaccio: TestVerdaccio;
let verdaccioDir: string;
let publisherToken: string;
let unityToken: string;
let fixtureDir: string;

beforeAll(async () => {
  verdaccioDir = await mkdtemp(join(tmpdir(), "vr-upm-m5-verdaccio-"));
  verdaccio = await startVerdaccio(verdaccioDir, [PUBLISHER, UNITY]);
  publisherToken = await loginForToken(verdaccio.url, PUBLISHER);
  unityToken = await loginForToken(verdaccio.url, UNITY);

  fixtureDir = await mkdtemp(join(tmpdir(), "vr-upm-m5-fixtures-"));
  for (const f of fixtures) await f.write(join(fixtureDir, `${f.name}.unitypackage`));
});
afterAll(async () => {
  await verdaccio?.close();
  await rm(verdaccioDir, { recursive: true, force: true });
  await rm(fixtureDir, { recursive: true, force: true });
});

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "vr-upm-m5-ws-"));
  return async () => {
    await rm(workspace, { recursive: true, force: true });
  };
});

let nameSeq = 0;
/** テストごとに別の UPM パッケージ名にする(Verdaccio は全テストで共有) */
const uniqueConfig = (overrides: Partial<ConvertConfigInput> = {}): ConvertConfigInput => ({
  packageName: `com.haoling.test.item${++nameSeq}`,
  displayName: "Dummy Item",
  version: "1.0.0",
  rootPath: "Assets/DummyShop/DummyItem",
  exclude: ["Textures/**"],
  ...overrides,
});

function setup(registry: { url?: string; token?: string } = { url: verdaccio.url, token: publisherToken }) {
  const db = openDb(":memory:");
  const app = createApp({
    config: {
      MODE: "all",
      ALLOWED_ORIGINS: [ORIGIN],
      WEB_DIST_DIR: undefined,
      WORKSPACE_DIR: workspace,
      MAX_UPLOAD_BYTES: 64 * 1024 * 1024,
      REGISTRY_URL: registry.url,
      REGISTRY_TOKEN: registry.token,
    },
    db,
  });
  const json = (method: string, path: string, body?: unknown, origin = ORIGIN) =>
    app.request(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const uploadFixture = async (name: string) => {
    const res = await app.request(`/api/uploads?filename=${name}.unitypackage`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: await readFile(join(fixtureDir, `${name}.unitypackage`)),
    });
    expect([200, 201]).toContain(res.status);
    return ((await res.json()) as { upload: { id: number } }).upload.id;
  };
  const getBuild = async (id: number) => BuildDetail.parse(await (await json("GET", `/api/builds/${id}`)).json());
  /** Package を作り、Build を ready にする */
  const readyBuild = async (config: ConvertConfigInput = uniqueConfig(), uploadId?: number) => {
    const pkgRes = await json("POST", "/api/packages", { config });
    expect(pkgRes.status).toBe(201);
    const pkg = PackageDetail.parse(await pkgRes.json());
    const upload = uploadId ?? (await uploadFixture("simple"));
    const res = await json("POST", "/api/builds", { packageId: pkg.id, uploadId: upload });
    expect(res.status).toBe(201);
    const created = BuildDetail.parse(await res.json());
    await runPendingBuilds(db, workspace);
    const build = await getBuild(created.id);
    expect(build.status).toBe("ready");
    return { build, pkg, uploadId: upload };
  };
  const publish = (id: number) => json("POST", `/api/builds/${id}/publish`);
  return { app, db, json, uploadFixture, getBuild, readyBuild, publish };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const registryGet = (path: string, token?: string) => fetch(`${verdaccio.url}/${path}`, { headers: token ? bearer(token) : {} });

describe("publish: Verdaccio をプロセス内で起動して publish → 取得", () => {
  it("publish した tarball を取得でき、integrity が Build の記録と一致する。作業領域は消える", async () => {
    const { readyBuild, publish, getBuild, json } = setup();
    const { build } = await readyBuild();
    const integrity = build.tarballIntegrity;
    expect(integrity).toMatch(/^sha512-/);
    expect(await readdir(buildDir(workspace, build.id))).toEqual(["package.tgz"]);

    const res = await publish(build.id);
    expect(res.status).toBe(200);
    const published = BuildDetail.parse(await res.json());
    expect(published).toMatchObject({ id: build.id, status: "published", tarballIntegrity: integrity });
    expect(published.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(published.log).toContain("publish しました");

    // publish 後に作業領域(tarball)が消える。integrity は Build に残る
    await expect(readdir(buildDir(workspace, build.id))).rejects.toThrow();
    expect((await getBuild(build.id)).tarballIntegrity).toBe(integrity);

    // Unity 用(読み取り専用)のトークンで取得できる
    const name = build.config.packageName;
    const packumentRes = await registryGet(name, unityToken);
    expect(packumentRes.status).toBe(200);
    const packument = (await packumentRes.json()) as {
      versions: Record<string, { name: string; version: string; displayName: string; dist: { integrity: string; tarball: string } }>;
    };
    const version = packument.versions["1.0.0"];
    expect(version).toMatchObject({ name, version: "1.0.0", displayName: "Dummy Item" });
    expect(version?.dist.integrity).toBe(integrity);

    // tarball 本体も、そのままのバイト列(integrity 一致)
    const tgzRes = await fetch(version?.dist.tarball as string, { headers: bearer(unityToken) });
    expect(tgzRes.status).toBe(200);
    const tgz = Buffer.from(await tgzRes.arrayBuffer());
    expect(integrityOf(tgz)).toBe(integrity);
    const file = join(workspace, "fetched.tgz");
    await writeFile(file, tgz);
    const listed = execFileSync("tar", ["tzf", file], { encoding: "utf8" }).split("\n");
    expect(listed).toContain("package/package.json");
    expect(listed).toContain("package/Models/body.fbx");

    // 一覧
    const list = PublishedListResponse.parse(await (await json("GET", "/api/published")).json());
    expect(list.published.map((b) => b.id)).toContain(build.id);
    expect(list.published.find((b) => b.id === build.id)).toMatchObject({ packageName: name, version: "1.0.0", status: "published" });
  });

  it("publish 済みの Build の再 publish、同じ version の別 Build の publish は拒否する(ready のまま残る)", async () => {
    const { readyBuild, publish, getBuild, db, json } = setup();
    const config = uniqueConfig();
    const first = await readyBuild(config);
    // 同じ設定の Build をもう 1 つ(まだどちらも publish されていないので作れる)
    const res = await json("POST", "/api/builds", { packageId: first.pkg.id, uploadId: first.uploadId });
    expect(res.status).toBe(201);
    const secondId = BuildDetail.parse(await res.json()).id;
    await runPendingBuilds(db, workspace);

    expect((await publish(first.build.id)).status).toBe(200);

    const again = await publish(first.build.id);
    expect(again.status).toBe(409);
    expect(ApiError.parse(await again.json()).code).toBe("version-already-published");

    const dup = await publish(secondId);
    expect(dup.status).toBe(409);
    const body = ApiError.parse(await dup.json());
    expect(body.code).toBe("version-already-published");
    expect(body.error).toContain(`Build #${first.build.id}`);
    expect((await getBuild(secondId)).status).toBe("ready");

    // publish 済みの version では新しい Build も作れない
    const rebuild = await json("POST", "/api/builds", { packageId: first.pkg.id, uploadId: first.uploadId });
    expect(rebuild.status).toBe(409);
    expect(ApiError.parse(await rebuild.json()).code).toBe("version-already-published");
  });

  it("DB に記録が無くても、レジストリに同じ version があれば拒否する(レジストリ側の 409)", async () => {
    const { readyBuild, publish, getBuild, db, json } = setup();
    const first = await readyBuild();
    expect((await publish(first.build.id)).status).toBe(200);
    // DB だけ「publish 済み」の記録を失った状態にして、同じ version をもう一度送る
    db.delete(builds).where(eq(builds.id, first.build.id)).run();
    const res0 = await json("POST", "/api/builds", { packageId: first.pkg.id, uploadId: first.uploadId });
    expect(res0.status).toBe(201);
    const second = BuildDetail.parse(await res0.json()).id;
    await runPendingBuilds(db, workspace);

    const res = await publish(second);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe("version-already-published");
    const build = await getBuild(second);
    expect(build.status).toBe("ready");
    expect(build.log).toContain("レジストリに同じ version が既にあります");
    // 後で version を上げて publish できるよう、tarball は残る
    expect(await readdir(buildDir(workspace, second))).toEqual(["package.tgz"]);
  });

  it("version を上げれば同じパッケージの次の version を publish できる", async () => {
    const { readyBuild, publish, json, db } = setup();
    const config = uniqueConfig();
    const first = await readyBuild(config);
    expect((await publish(first.build.id)).status).toBe(200);

    const put = await json("PUT", `/api/packages/${first.pkg.id}`, { config: { ...config, version: "1.0.1" } });
    expect(put.status).toBe(200);
    const res = await json("POST", "/api/builds", { packageId: first.pkg.id, uploadId: first.uploadId });
    expect(res.status).toBe(201);
    const id = BuildDetail.parse(await res.json()).id;
    await runPendingBuilds(db, workspace);
    expect((await publish(id)).status).toBe(200);

    const packument = (await (await registryGet(config.packageName, unityToken)).json()) as { versions: Record<string, unknown> };
    expect(Object.keys(packument.versions).sort()).toEqual(["1.0.0", "1.0.1"]);
  });
});

describe("Verdaccio の設定例(verdaccio/conf/config.yaml)", () => {
  it("未認証では、パッケージも tarball も読めない", async () => {
    const { readyBuild, publish } = setup();
    const { build } = await readyBuild();
    expect((await publish(build.id)).status).toBe(200);
    const name = build.config.packageName;

    expect((await registryGet(name)).status).toBe(401);
    expect((await registryGet(`${name}/-/${name}-1.0.0.tgz`)).status).toBe(401);
    expect((await registryGet("-/all")).status).toBeGreaterThanOrEqual(401);
    // 存在しない名前でも、未認証には「無い」と答えず 401(名前の有無を漏らさない)
    expect((await registryGet("com.haoling.test.nothing-here")).status).toBe(401);
    // 認証があれば読める / 無い名前は 404
    expect((await registryGet(name, unityToken)).status).toBe(200);
    expect((await registryGet("com.haoling.test.nothing-here", unityToken)).status).toBe(404);
  });

  it("自己登録はできない(max_users: -1)", async () => {
    const res = await fetch(`${verdaccio.url}/-/user/org.couchdb.user:newcomer`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "newcomer", password: "newcomer-pass" }),
    });
    expect(res.status).toBe(409);
    expect(await registryGet("com.haoling.test.x", undefined).then((r) => r.status)).toBe(401);
  });

  it("publish できるのは publisher だけ。Unity 用(読み取り専用)のトークンでは publish できない", async () => {
    const { readyBuild, publish, getBuild } = setup({ url: verdaccio.url, token: unityToken });
    const { build } = await readyBuild();
    const res = await publish(build.id);
    expect(res.status).toBe(502);
    const body = ApiError.parse(await res.json());
    expect(body.code).toBe("publish-failed");
    expect(body.error).toContain("許可していません");
    const after = await getBuild(build.id);
    expect(after.status).toBe("ready");
    expect(after.log).toContain("許可していません");
    // レジストリには何も入っていない
    expect((await registryGet(build.config.packageName, publisherToken)).status).toBe(404);
  });
});

describe("publish の失敗時の扱い", () => {
  it("トークンが違えば 502 で、Build は ready のまま(直して再試行できる)", async () => {
    const { readyBuild, publish, getBuild } = setup({ url: verdaccio.url, token: "not-a-valid-token" });
    const { build } = await readyBuild();
    const res = await publish(build.id);
    expect(res.status).toBe(502);
    expect(ApiError.parse(await res.json()).code).toBe("publish-failed");
    const after = await getBuild(build.id);
    expect(after.status).toBe("ready");
    expect(await readdir(buildDir(workspace, build.id))).toEqual(["package.tgz"]);
  });

  it("レジストリに繋がらなければ 502", async () => {
    // 使われていないポートを借りる
    const dead = await startVerdaccio(await mkdtemp(join(tmpdir(), "vr-upm-m5-dead-")), [PUBLISHER]);
    const deadUrl = dead.url;
    await dead.close();
    const { readyBuild, publish } = setup({ url: deadUrl, token: publisherToken });
    const { build } = await readyBuild();
    const res = await publish(build.id);
    expect(res.status).toBe(502);
    expect(ApiError.parse(await res.json()).code).toBe("publish-failed");
  });

  it("REGISTRY_URL / REGISTRY_TOKEN が揃っていなければ 503 で、publish は無効と表示される", async () => {
    for (const registry of [{}, { url: verdaccio.url }, { token: publisherToken }]) {
      const { readyBuild, publish, json } = setup(registry);
      const { build } = await readyBuild();
      const res = await publish(build.id);
      expect(res.status).toBe(503);
      expect(ApiError.parse(await res.json()).code).toBe("registry-not-configured");
      const info = RegistryInfo.parse(await (await json("GET", "/api/registry")).json());
      expect(info).toEqual({ url: registry.url ?? null, publishEnabled: false });
    }
  });

  it("GET /api/registry は URL と有効かどうかだけを返す(トークンは返さない)", async () => {
    const { json } = setup();
    const res = await json("GET", "/api/registry");
    const text = await res.text();
    expect(RegistryInfo.parse(JSON.parse(text))).toEqual({ url: verdaccio.url, publishEnabled: true });
    expect(text).not.toContain(publisherToken);
  });

  it("tarball が壊れていたら(integrity が記録と違えば)送らない", async () => {
    const { readyBuild, publish, getBuild } = setup();
    const { build } = await readyBuild();
    const file = tarballPath(workspace, build.id);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("tampered")]));
    const res = await publish(build.id);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe("integrity-mismatch");
    expect((await getBuild(build.id)).status).toBe("ready");
    expect((await registryGet(build.config.packageName, publisherToken)).status).toBe(404);
  });

  it("tarball が作業領域に無ければ 409", async () => {
    const { readyBuild, publish } = setup();
    const { build } = await readyBuild();
    await rm(tarballPath(workspace, build.id));
    const res = await publish(build.id);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe("invalid-state");
  });

  it("ready 以外(待機中・failed など)は publish できない。無い ID は 404、Origin が違えば 403", async () => {
    const { json, publish, uploadFixture, readyBuild } = setup();
    const uploadId = await uploadFixture("simple");
    const pkgRes = await json("POST", "/api/packages", { config: uniqueConfig() });
    const pkg = PackageDetail.parse(await pkgRes.json());
    const queued = BuildDetail.parse(await (await json("POST", "/api/builds", { packageId: pkg.id, uploadId })).json());
    expect(queued.status).toBe("queued");
    const res = await publish(queued.id);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe("invalid-state");

    expect((await publish(9999)).status).toBe(404);
    expect((await json("POST", "/api/builds/abc/publish")).status).toBe(404);

    const { build } = await readyBuild();
    expect((await json("POST", `/api/builds/${build.id}/publish`, undefined, "https://evil.example")).status).toBe(403);
    expect((await registryGet(build.config.packageName, publisherToken)).status).toBe(404);
  });

  it("publish 済みの Build は破棄できない(M4 から)", async () => {
    const { readyBuild, publish, json } = setup();
    const { build } = await readyBuild();
    expect((await publish(build.id)).status).toBe(200);
    expect((await json("DELETE", `/api/builds/${build.id}`)).status).toBe(409);
  });
});
