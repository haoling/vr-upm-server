import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// DESIGN.md 7章のデータモデル。JSON 列は text(mode: "json") で持つ。

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const uploads = sqliteTable("uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sha256: text("sha256").notNull().unique(),
  originalFilename: text("original_filename").notNull(),
  size: integer("size").notNull(),
  uploadedAt: createdAt(),
  analysisJson: text("analysis_json", { mode: "json" }),
  fileState: text("file_state", { enum: ["stored", "archived", "missing"] })
    .notNull()
    .default("stored"),
  archivedAt: text("archived_at"),
  archiveNote: text("archive_note"),
});

export const packages = sqliteTable("packages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  sourceUrl: text("source_url"),
  configTemplate: text("config_template", { mode: "json" }),
  createdAt: createdAt(),
});

export const builds = sqliteTable(
  "builds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    packageId: integer("package_id")
      .notNull()
      .references(() => packages.id),
    uploadId: integer("upload_id")
      .notNull()
      .references(() => uploads.id),
    version: text("version").notNull(),
    sourceVersionLabel: text("source_version_label"),
    configSnapshot: text("config_snapshot", { mode: "json" }).notNull(),
    status: text("status", { enum: ["queued", "building", "ready", "published", "failed"] })
      .notNull()
      .default("queued"),
    tarballIntegrity: text("tarball_integrity"),
    log: text("log"),
    createdAt: createdAt(),
  },
  (t) => [index("builds_status_idx").on(t.status)],
);

export const guidIndex = sqliteTable(
  "guid_index",
  {
    guid: text("guid").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    path: text("path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guid, t.packageName, t.version] })],
);

export const knownPackages = sqliteTable("known_packages", {
  name: text("name").primaryKey(),
  detectRules: text("detect_rules", { mode: "json" }).notNull(),
  replacementDependency: text("replacement_dependency"),
});
