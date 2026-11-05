/**
 * テスト用の最小限の ustar 書き出し。
 *
 * 異常系(`..` を含むエントリ、シンボリックリンク、巨大なエントリ)も作れるように、
 * ライブラリを使わずヘッダを直接組み立てる。出力は決定的(mtime・uid 等は 0 固定)。
 */

export type TarEntryType = "file" | "directory" | "symlink";

/** 中身。巨大なファイルをメモリに載せずに作れるよう、ゼロ埋めのサイズ指定もできる */
export type TarBody = string | Uint8Array | { zeroBytes: number };

export interface TarEntry {
  path: string;
  type?: TarEntryType;
  body?: TarBody;
  linkpath?: string;
}

const BLOCK = 512;
const ZERO_CHUNK = new Uint8Array(1024 * 1024);

function bodySize(body: TarBody | undefined): number {
  if (body === undefined) return 0;
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.length;
  return body.zeroBytes;
}

function writeString(buf: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(buf, offset);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
  writeString(buf, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

export function tarHeader(entry: TarEntry): Buffer {
  const type = entry.type ?? "file";
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, type === "directory" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, type === "file" ? bodySize(entry.body) : 0);
  writeOctal(header, 136, 12, 0); // mtime
  header.fill(0x20, 148, 156); // checksum 計算中は空白
  header[156] = (type === "file" ? "0" : type === "directory" ? "5" : "2").charCodeAt(0);
  if (entry.linkpath) writeString(header, 157, 100, entry.linkpath);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  let sum = 0;
  for (const b of header) sum += b;
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** tar のバイト列をチャンクごとに返す(ストリームで gzip に流せる) */
export function* tarChunks(entries: Iterable<TarEntry>): Generator<Uint8Array> {
  for (const entry of entries) {
    yield tarHeader(entry);
    if ((entry.type ?? "file") !== "file" || entry.body === undefined) continue;
    const size = bodySize(entry.body);
    const body = entry.body;
    if (typeof body === "string") {
      yield Buffer.from(body, "utf8");
    } else if (body instanceof Uint8Array) {
      yield body;
    } else {
      for (let left = body.zeroBytes; left > 0; left -= ZERO_CHUNK.length) {
        yield left >= ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, left);
      }
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0) yield new Uint8Array(pad);
  }
  yield new Uint8Array(BLOCK * 2); // 終端
}
