import {
  BuildCreateRequest,
  ConvertConfig,
  DryRunReport,
  type BuildDetail,
  type BuildListResponse,
  type BuildSummary,
  type PublishedListResponse,
  type RegistryInfo,
} from "@vr-upm/shared";
import { desc, eq, and } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { builds, packages, uploads } from "../db/schema.js";
import { fail, parseId, parseJsonBody } from "../http.js";
import { uploadFilePath } from "../uploads/storage.js";
import { PublishError, publishBuild, type RegistryTarget } from "./publish.js";
import { removeBuildDir } from "./storage.js";
import { stat } from "node:fs/promises";

type BuildRow = typeof builds.$inferSelect;
type Joined = { build: BuildRow; packageName: string; uploadFilename: string };

function toSummary({ build, packageName, uploadFilename }: Joined): BuildSummary {
  return {
    id: build.id,
    packageId: build.packageId,
    packageName,
    uploadId: build.uploadId,
    uploadFilename,
    version: build.version,
    sourceVersionLabel: build.sourceVersionLabel,
    status: build.status,
    tarballIntegrity: build.tarballIntegrity,
    tarballSize: build.tarballSize,
    createdAt: build.createdAt,
    publishedAt: build.publishedAt,
  };
}

function toDetail(joined: Joined): BuildDetail {
  const { build } = joined;
  const dryRun = DryRunReport.safeParse(build.dryRun);
  return {
    ...toSummary(joined),
    config: ConvertConfig.parse(build.configSnapshot),
    log: build.log ?? "",
    dryRun: dryRun.success ? dryRun.data : null,
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Build の作成・参照・破棄(DESIGN.md 3.3 の 1〜3)。
 * ビルド自体は Worker が `queued` を取り出して実行する。
 */
export function buildRoutes({ db, workspaceDir, registry }: { db: Db; workspaceDir: string; registry: RegistryTarget | null }) {
  const joinedQuery = () =>
    db
      .select({ build: builds, packageName: packages.name, uploadFilename: uploads.originalFilename })
      .from(builds)
      .innerJoin(packages, eq(builds.packageId, packages.id))
      .innerJoin(uploads, eq(builds.uploadId, uploads.id));
  const notFound = () => fail(404, { error: "build not found", code: "not-found" });

  return new Hono()
    .get("/", (c) => {
      const rows = joinedQuery().orderBy(desc(builds.id)).all();
      const body: BuildListResponse = { builds: rows.map(toSummary) };
      return c.json(body);
    })
    .get("/:id", (c) => {
      const id = parseId(c.req.param("id"));
      const row = id === null ? undefined : joinedQuery().where(eq(builds.id, id)).get();
      return row ? c.json(toDetail(row)) : notFound();
    })
    .post("/", async (c) => {
      const body = await parseJsonBody(c, BuildCreateRequest);
      if (body instanceof Response) return body;

      const pkg = db.select().from(packages).where(eq(packages.id, body.packageId)).get();
      if (!pkg) return fail(404, { error: "package not found", code: "not-found" });
      const upload = db.select().from(uploads).where(eq(uploads.id, body.uploadId)).get();
      if (!upload) return fail(404, { error: "upload not found", code: "not-found" });

      // 元ファイルが無ければビルドしない。再アップロードで同じ Upload に戻せる(DESIGN.md 3.3 の 1)
      const present = upload.fileState === "stored" && (await isFile(uploadFilePath(workspaceDir, upload.sha256)));
      if (!present) {
        if (upload.fileState === "stored") db.update(uploads).set({ fileState: "missing" }).where(eq(uploads.id, upload.id)).run();
        return fail(409, {
          error: `${upload.originalFilename} の元ファイルがありません。同じファイルを再アップロードしてください`,
          code: "source-file-missing",
        });
      }

      const config = ConvertConfig.safeParse(pkg.configTemplate);
      if (!config.success) {
        return fail(409, { error: "package の設定が読めません。設定を保存し直してください", code: "invalid-state" });
      }

      const published = db
        .select({ id: builds.id })
        .from(builds)
        .where(and(eq(builds.packageId, pkg.id), eq(builds.version, config.data.version), eq(builds.status, "published")))
        .get();
      if (published) {
        return fail(409, {
          error: `${pkg.name} ${config.data.version} は publish 済みです。version を上げてください`,
          code: "version-already-published",
        });
      }

      // 設定のスナップショット。Package を後から編集しても、この Build の設定は変わらない
      const row = db
        .insert(builds)
        .values({
          packageId: pkg.id,
          uploadId: upload.id,
          version: config.data.version,
          sourceVersionLabel: config.data.sourceVersionLabel ?? null,
          configSnapshot: config.data,
        })
        .returning({ id: builds.id })
        .get();
      const created = joinedQuery().where(eq(builds.id, row.id)).get() as Joined;
      return c.json(toDetail(created), 201);
    })
    .post("/:id/publish", async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null || !joinedQuery().where(eq(builds.id, id)).get()) return notFound();
      try {
        await publishBuild(db, workspaceDir, registry, id);
      } catch (err) {
        if (err instanceof PublishError) return fail(err.status, { error: err.message, code: err.code });
        throw err;
      }
      return c.json(toDetail(joinedQuery().where(eq(builds.id, id)).get() as Joined));
    })
    .delete("/:id", async (c) => {
      const id = parseId(c.req.param("id"));
      const row = id === null ? undefined : joinedQuery().where(eq(builds.id, id)).get();
      if (id === null || !row) return notFound();
      if (row.build.status === "building" || row.build.status === "published") {
        return fail(409, {
          error: row.build.status === "building" ? "ビルド中の Build は破棄できません" : "publish 済みの Build は破棄できません",
          code: "invalid-state",
        });
      }
      db.delete(builds).where(eq(builds.id, id)).run();
      await removeBuildDir(workspaceDir, id);
      return c.body(null, 204);
    });
}

/** publish 先の情報と publish 済みバージョンの一覧(DESIGN.md 3.3 の 4〜5)。トークンは返さない */
export function publishedRoutes({ db, registry, registryUrl }: { db: Db; registry: RegistryTarget | null; registryUrl: string | null }) {
  return new Hono()
    .get("/registry", (c) => c.json({ url: registryUrl, publishEnabled: registry !== null } satisfies RegistryInfo))
    .get("/published", (c) => {
      const rows = db
        .select({ build: builds, packageName: packages.name, uploadFilename: uploads.originalFilename })
        .from(builds)
        .innerJoin(packages, eq(builds.packageId, packages.id))
        .innerJoin(uploads, eq(builds.uploadId, uploads.id))
        .where(eq(builds.status, "published"))
        .orderBy(desc(builds.publishedAt), desc(builds.id))
        .all();
      return c.json({ published: rows.map(toSummary) } satisfies PublishedListResponse);
    });
}
