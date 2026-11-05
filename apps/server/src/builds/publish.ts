import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readTarballManifest } from "@vr-upm/core";
import { ConvertConfig, type ApiErrorCode } from "@vr-upm/shared";
import { and, eq, ne } from "drizzle-orm";
import { publish } from "libnpmpublish";
import type { Db } from "../db/client.js";
import { builds, packages } from "../db/schema.js";
import { VERSION } from "../version.js";
import { removeBuildDir, tarballPath } from "./storage.js";

export interface RegistryTarget {
  url: string;
  token: string;
}

export class PublishError extends Error {
  constructor(
    readonly status: 409 | 500 | 502 | 503,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export const integrityOf = (data: Uint8Array) => `sha512-${createHash("sha512").update(data).digest("base64")}`;

/** publish 中の Build。同じ Build を二重に送らない(SQLite は 1 プロセスなのでメモリで足りる) */
const inFlight = new Set<number>();

function appendLog(db: Db, buildId: number, current: string | null, line: string): void {
  db.update(builds)
    .set({ log: [current ?? "", `[publish ${new Date().toISOString()}] ${line}`].filter(Boolean).join("\n") })
    .where(eq(builds.id, buildId))
    .run();
}

/** libnpmpublish(npm-registry-fetch)のエラーを、ユーザーに見せる文にする */
function describeRegistryError(err: unknown, registry: string): { conflict: boolean; message: string } {
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (e.statusCode === 409 || e.code === "E409") return { conflict: true, message: "レジストリに同じ version が既にあります" };
  if (e.statusCode === 401 || e.code === "E401") return { conflict: false, message: "レジストリの認証に失敗しました(REGISTRY_TOKEN を確認してください)" };
  if (e.statusCode === 403 || e.code === "E403") return { conflict: false, message: "レジストリがこのトークンでの publish を許可していません" };
  const detail = e.message ?? String(err);
  return { conflict: false, message: `レジストリ ${registry} への publish に失敗しました: ${detail}` };
}

/**
 * ready の Build を Verdaccio に publish する(DESIGN.md 3.3 の 4〜5)。
 * - 同じパッケージ・version の publish 済み Build があれば拒否する(レジストリ側が 409 を返した場合も同じ)
 * - tarball の integrity が Build に記録したものと違えば送らない
 * - 成功したら status を published にして、作業領域(tarball)を消す。integrity は Build に残す
 * - 失敗したら ready のまま、ログに理由を残す(再試行できる)
 */
export async function publishBuild(db: Db, workspaceDir: string, registry: RegistryTarget | null, buildId: number): Promise<void> {
  if (!registry) {
    throw new PublishError(503, "registry-not-configured", "publish 先のレジストリが設定されていません(REGISTRY_URL と REGISTRY_TOKEN)");
  }
  const build = db.select().from(builds).where(eq(builds.id, buildId)).get();
  if (!build) throw new PublishError(409, "not-found", "build not found");
  if (build.status === "published") {
    throw new PublishError(409, "version-already-published", `${build.version} は publish 済みです`);
  }
  if (build.status !== "ready") {
    throw new PublishError(409, "invalid-state", `ready の Build だけ publish できます(現在: ${build.status})`);
  }

  const pkg = db.select().from(packages).where(eq(packages.id, build.packageId)).get();
  const duplicate = db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.packageId, build.packageId), eq(builds.version, build.version), eq(builds.status, "published"), ne(builds.id, build.id)))
    .get();
  if (duplicate) {
    throw new PublishError(
      409,
      "version-already-published",
      `${pkg?.name ?? "パッケージ"} ${build.version} は Build #${duplicate.id} で publish 済みです。version を上げてビルドし直してください`,
    );
  }
  if (inFlight.has(build.id)) throw new PublishError(409, "invalid-state", "この Build は publish 中です");
  inFlight.add(build.id);
  try {
    let tarball: Buffer;
    try {
      tarball = await readFile(tarballPath(workspaceDir, build.id));
    } catch {
      appendLog(db, build.id, build.log, "tarball が作業領域にありません。Build を破棄してビルドし直してください");
      throw new PublishError(409, "invalid-state", "tarball が作業領域にありません。Build を破棄してビルドし直してください");
    }
    const integrity = integrityOf(tarball);
    if (integrity !== build.tarballIntegrity) {
      appendLog(db, build.id, build.log, `tarball の integrity が記録と違います(${integrity})。publish しません`);
      throw new PublishError(409, "integrity-mismatch", "tarball の integrity が Build の記録と違います。Build を破棄してビルドし直してください");
    }

    // レジストリに送る manifest は tarball の package.json をそのまま使う
    const manifest = await readTarballManifest(tarball);
    const config = ConvertConfig.parse(build.configSnapshot);
    if (manifest.name !== config.packageName || manifest.version !== config.version) {
      appendLog(db, build.id, build.log, `tarball の name/version(${String(manifest.name)}@${String(manifest.version)})が設定と違います`);
      throw new PublishError(409, "integrity-mismatch", "tarball の name/version が Build の設定と違います");
    }

    try {
      await publish(manifest, tarball, {
        registry: registry.url,
        // npm-registry-fetch は forceAuth で渡した認証だけを、このリクエストに使う(~/.npmrc は読まない)
        forceAuth: { token: registry.token },
        npmVersion: `vr-upm-server/${VERSION}`,
        // UPM は scope なしの名前(com.example.x)なので access は指定しない。読み取りはレジストリ側の `access: $authenticated` で制御する
      });
    } catch (err) {
      const { conflict, message } = describeRegistryError(err, registry.url);
      appendLog(db, build.id, build.log, message);
      if (conflict) {
        throw new PublishError(409, "version-already-published", `${config.packageName} ${config.version} はレジストリに既にあります。version を上げてビルドし直してください`);
      }
      throw new PublishError(502, "publish-failed", message);
    }

    // 公開できた。published にして作業領域を消す(integrity は Build に残っている)
    const updated = db
      .update(builds)
      .set({
        status: "published",
        publishedAt: new Date().toISOString(),
        log: [build.log ?? "", `[publish ${new Date().toISOString()}] ${registry.url} へ ${config.packageName}@${config.version} を publish しました(${integrity})`]
          .filter(Boolean)
          .join("\n"),
      })
      .where(and(eq(builds.id, build.id), eq(builds.status, "ready")))
      .returning({ id: builds.id })
      .get();
    if (!updated) {
      throw new PublishError(500, "internal-error", "publish 後に Build の状態を更新できませんでした(publish 中に破棄された可能性があります)");
    }
    await removeBuildDir(workspaceDir, build.id);
  } finally {
    inFlight.delete(build.id);
  }
}
