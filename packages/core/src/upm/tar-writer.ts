/**
 * 決定的な tar(ustar + 必要なときだけ pax)の書き出し。
 *
 * `tar` ライブラリの Pack はファイルシステムの stat から mtime・uid・mode を取るため、
 * 環境によって結果が変わる。ここではメタデータをすべて固定し、同じ入力から同じバイト列を作る。
 */

const BLOCK = 512;

/** npm pack と同じ固定 mtime(1985-10-26T08:15:00Z) */
export const FIXED_MTIME = 499162500;
const FILE_MODE = 0o644;
const MAX_USTAR_SIZE = 8 ** 11 - 1;

export type TarBodyChunks = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export interface TarFileEntry {
  /** tar 内のフルパス(`package/...`) */
  path: string;
  size: number;
  body: TarBodyChunks;
}

function writeString(buf: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(buf, offset);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
  writeString(buf, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

const isAscii = (s: string) => /^[\x01-\x7f]*$/.test(s);

/** ustar の name(100)と prefix(155)に分けられれば分ける */
function splitUstarPath(path: string): { name: string; prefix: string } | null {
  if (!isAscii(path)) return null;
  if (path.length <= 100) return { name: path, prefix: "" };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
    if (name.length > 100) break;
  }
  return null;
}

function header(opts: { name: string; prefix: string; size: number; type: "0" | "x" }): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeString(h, 0, 100, opts.name);
  writeOctal(h, 100, 8, FILE_MODE);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, opts.size);
  writeOctal(h, 136, 12, FIXED_MTIME);
  h.fill(0x20, 148, 156); // チェックサム計算中は空白
  h[156] = opts.type.charCodeAt(0);
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  // uname / gname は空(環境のユーザー名を入れない)
  writeString(h, 345, 155, opts.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** pax の 1 レコード(`<長さ> <key>=<value>\n`。長さは自分自身の桁数を含む) */
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length), "ascii"), body]);
}

function padding(size: number): Uint8Array | null {
  const rest = size % BLOCK;
  return rest === 0 ? null : new Uint8Array(BLOCK - rest);
}

async function* chunksOf(body: TarBodyChunks): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) yield body;
  else yield* body;
}

/**
 * エントリを順に tar のバイト列にする。`size` と実際の中身の長さが違えば例外を投げる。
 * 呼び出し側が渡した順序のまま書く(並べ替えは呼び出し側の責任)。
 */
export async function* tarChunks(entries: Iterable<TarFileEntry>): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    const split = splitUstarPath(entry.path);
    const records: Buffer[] = [];
    if (!split) records.push(paxRecord("path", entry.path));
    const bigSize = entry.size > MAX_USTAR_SIZE;
    if (bigSize) records.push(paxRecord("size", String(entry.size)));

    if (records.length > 0) {
      const pax = Buffer.concat(records);
      yield header({ name: "PaxHeader/entry", prefix: "", size: pax.length, type: "x" });
      yield pax;
      const pad = padding(pax.length);
      if (pad) yield pad;
    }
    yield header({
      name: split?.name ?? "pax-entry",
      prefix: split?.prefix ?? "",
      size: bigSize ? 0 : entry.size,
      type: "0",
    });

    let written = 0;
    for await (const chunk of chunksOf(entry.body)) {
      written += chunk.length;
      if (written > entry.size) break;
      yield chunk;
    }
    if (written !== entry.size) {
      throw new Error(`tar entry ${entry.path}: expected ${entry.size} bytes but body has ${written >= entry.size ? "more" : written}`);
    }
    const pad = padding(entry.size);
    if (pad) yield pad;
  }
  yield new Uint8Array(BLOCK * 2);
}
