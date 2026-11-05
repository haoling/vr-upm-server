import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser } from "tar";

/**
 * npm tarball(`package/package.json` を持つ tgz)から package.json を読む。
 * publish 時に、レジストリへ送る manifest を tarball 自身から得るために使う(別に持った値とずれない)。
 * 読めなければ Error を投げる。
 */
export async function readTarballManifest(tgz: Uint8Array): Promise<Record<string, unknown>> {
  let found: Buffer | undefined;
  const parser = new Parser({
    filter: (path) => path === "package/package.json",
    onReadEntry: (entry) => {
      const chunks: Buffer[] = [];
      entry.on("data", (c: Buffer) => chunks.push(c));
      entry.on("end", () => {
        found = Buffer.concat(chunks);
      });
    },
  });
  await pipeline(Readable.from([tgz]), createGunzip(), parser);
  if (!found) throw new Error("tarball に package/package.json がありません");
  const manifest: unknown = JSON.parse(found.toString("utf8"));
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("package/package.json がオブジェクトではありません");
  }
  return manifest as Record<string, unknown>;
}
