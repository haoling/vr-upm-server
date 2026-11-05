import {
  ConvertConfig,
  PackageSaveRequest,
  type PackageDetail,
  type PackageListResponse,
  type PackageSummary,
} from "@vr-upm/shared";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { packages } from "../db/schema.js";
import { fail, parseId, parseJsonBody } from "../http.js";

type PackageRow = typeof packages.$inferSelect;

/** 保存済みの設定を読む。読めない(形式が古いなど)場合は null */
function parseConfig(row: PackageRow): ConvertConfig | null {
  const parsed = ConvertConfig.safeParse(row.configTemplate);
  return parsed.success ? parsed.data : null;
}

function toSummary(row: PackageRow, config: ConvertConfig | null): PackageSummary {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    version: config?.version ?? "",
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt,
  };
}

/** 保存済みの設定が読めない Package の設定を、画面で直せるよう最低限の形で返す */
export function toDetail(row: PackageRow): PackageDetail {
  const config = parseConfig(row);
  return {
    ...toSummary(row, config),
    config: config ?? ConvertConfig.parse({ packageName: row.name, displayName: row.displayName, version: "0.0.0", rootPath: "Assets" }),
  };
}

/**
 * Package(変換設定のテンプレート)の作成・編集(DESIGN.md 3.2)。
 * 設定は M2 の {@link ConvertConfig} をそのまま `config_template` に保存する。
 * UPM パッケージ名は publish 済みの識別子なので、作成後は変更できない。
 */
export function packageRoutes({ db }: { db: Db }) {
  const byId = (id: number) => db.select().from(packages).where(eq(packages.id, id)).get();
  const notFound = () => fail(404, { error: "package not found", code: "not-found" });

  return new Hono()
    .get("/", (c) => {
      const rows = db.select().from(packages).orderBy(desc(packages.id)).all();
      const body: PackageListResponse = { packages: rows.map((r) => toSummary(r, parseConfig(r))) };
      return c.json(body);
    })
    .get("/:id", (c) => {
      const id = parseId(c.req.param("id"));
      const row = id === null ? undefined : byId(id);
      return row ? c.json(toDetail(row)) : notFound();
    })
    .post("/", async (c) => {
      const body = await parseJsonBody(c, PackageSaveRequest);
      if (body instanceof Response) return body;
      const { config } = body;
      const row = db
        .insert(packages)
        .values({ name: config.packageName, displayName: config.displayName, sourceUrl: config.boothUrl ?? null, configTemplate: config })
        .onConflictDoNothing()
        .returning()
        .get();
      if (!row) {
        return fail(409, { error: `package ${config.packageName} already exists`, code: "duplicate-package-name" });
      }
      return c.json(toDetail(row), 201);
    })
    .put("/:id", async (c) => {
      const id = parseId(c.req.param("id"));
      const existing = id === null ? undefined : byId(id);
      if (id === null || !existing) return notFound();
      const body = await parseJsonBody(c, PackageSaveRequest);
      if (body instanceof Response) return body;
      const { config } = body;
      if (config.packageName !== existing.name) {
        return fail(400, { error: `packageName cannot be changed (${existing.name})`, code: "invalid-request" });
      }
      const row = db
        .update(packages)
        .set({ displayName: config.displayName, sourceUrl: config.boothUrl ?? null, configTemplate: config })
        .where(eq(packages.id, id))
        .returning()
        .get();
      return c.json(toDetail(row));
    });
}
