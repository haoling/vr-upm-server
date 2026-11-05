import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export interface ReceivedFile {
  sha256: string;
  size: number;
}

/**
 * リクエストボディをストリームのまま `dest` に書き出し、sha256 とサイズを返す。
 * 上限を超えた時点で打ち切って {@link BodyTooLargeError} を投げる(書きかけのファイルは呼び出し側で消す)。
 */
export async function receiveToFile(body: ReadableStream<Uint8Array>, dest: string, maxBytes: number): Promise<ReceivedFile> {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new BodyTooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), meter, createWriteStream(dest, { flags: "wx" }));
  return { sha256: hash.digest("hex"), size };
}
