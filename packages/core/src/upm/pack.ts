import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { UpmPlan } from "./plan.js";
import { type TarBodyChunks, type TarFileEntry, tarChunks } from "./tar-writer.js";

/** 展開済みの asset を読み出す口。core は保存場所を知らない(CLI は一時ディレクトリ、テストはメモリ) */
export interface AssetStore {
  open(guid: string): TarBodyChunks;
}

export interface TarballDigest {
  /** `sha512-<base64>`(npm の integrity) */
  integrity: string;
  /** sha1(16 進。`npm publish` が dist.shasum に入れる) */
  shasum: string;
  /** tgz のバイト数 */
  size: number;
}

export class UpmPlanError extends Error {
  constructor(readonly plan: UpmPlan) {
    super(`cannot pack: ${plan.errors.map((e) => `[${e.code}] ${e.message}`).join("; ")}`);
    this.name = "UpmPlanError";
  }
}

/** gzip ヘッダの OS バイト(offset 9)。zlib はビルドしたプラットフォームで値が変わるので Unix に固定する */
const GZIP_OS_OFFSET = 9;
const GZIP_OS_UNIX = 3;

function digestAndPatch() {
  const sha512 = createHash("sha512");
  const sha1 = createHash("sha1");
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (size <= GZIP_OS_OFFSET && GZIP_OS_OFFSET < size + chunk.length) chunk[GZIP_OS_OFFSET - size] = GZIP_OS_UNIX;
      size += chunk.length;
      sha512.update(chunk);
      sha1.update(chunk);
      cb(null, chunk);
    },
  });
  const digest = (): TarballDigest => ({
    integrity: `sha512-${sha512.digest("base64")}`,
    shasum: sha1.digest("hex"),
    size,
  });
  return { transform, digest };
}

/**
 * 計画どおりに決定的な tgz を `out` へ書き出し、integrity を返す。
 *
 * エントリの順序・mtime・uid/gid・mode・gzip ヘッダはすべて固定なので、
 * 同じ計画・同じ中身なら(同じ zlib であれば)毎回同じバイト列になる。
 * 構造は npm の tarball と同じく、すべてのパスが `package/` の下に入る(Unity が読める形)。
 */
export async function packTarball(plan: UpmPlan, store: AssetStore, out: Writable): Promise<TarballDigest> {
  if (plan.errors.length > 0) throw new UpmPlanError(plan);

  const entries = function* (): Generator<TarFileEntry> {
    for (const file of plan.files) {
      yield {
        path: `package/${file.path}`,
        size: file.size,
        body: file.content.kind === "text" ? Buffer.from(file.content.text, "utf8") : store.open(file.content.guid),
      };
    }
  };

  const { transform, digest } = digestAndPatch();
  await pipeline(Readable.from(tarChunks(entries())), createGzip({ level: 9 }), transform, out);
  return digest();
}
