import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";
import { UnitypackageAnalysisError } from "./errors.js";
import type { AnalyzeLimits } from "./limits.js";

/** 解析の入力。ファイルの読み込みは呼び出し側が行う(core は I/O を持たない) */
export type UnitypackageInput = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/** `<guid>/` ディレクトリ 1 つ分の中身 */
export interface RawGuidEntry {
  asset?: { size: number; sha256: string };
  /** asset.meta の本文 */
  meta?: string;
  /** pathname ファイルの本文(未検証) */
  pathname?: string;
  hasPreview: boolean;
}

export type RawNotice =
  | { code: "duplicate-entry"; dir: string; name: string }
  | { code: "unexpected-entry"; path: string };

export interface RawUnitypackage {
  /** キーは `<guid>` ディレクトリ名 */
  entries: Map<string, RawGuidEntry>;
  notices: RawNotice[];
  compressedBytes: number;
  extractedBytes: number;
  entryCount: number;
}

const FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const KNOWN_NAMES = new Set(["asset", "asset.meta", "pathname", "preview.png"]);

const GZIP_MAGIC = [0x1f, 0x8b];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function startsWith(chunk: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => chunk[i] === b);
}

function toIterable(input: UnitypackageInput): AsyncIterable<Uint8Array> | Iterable<Uint8Array> {
  return input instanceof Uint8Array ? [input] : input;
}

/**
 * tar のエントリパスを検証して `/` 区切りのセグメントにする。
 * 書き出しはしないが、外部入力なのでおかしなパスは解析ごと止める。
 */
function entrySegments(path: string): string[] {
  const p = path.replace(/\\/g, "/");
  if (p.includes("\0")) {
    throw new UnitypackageAnalysisError("unsafe-path", `tar entry path contains NUL: ${JSON.stringify(path)}`);
  }
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    throw new UnitypackageAnalysisError("unsafe-path", `absolute tar entry path: ${JSON.stringify(path)}`);
  }
  const segments = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new UnitypackageAnalysisError("unsafe-path", `path traversal in tar entry: ${JSON.stringify(path)}`);
  }
  return segments;
}

/**
 * gzip を展開しながら tar を読み、`<guid>/...` ごとに中身をまとめる。
 *
 * - `asset` は中身を保持せず、サイズと sha256 だけを取る
 * - `asset.meta` と `pathname` はメモリに読む(上限あり)
 * - 上限超過・壊れた入力・危険なパスは {@link UnitypackageAnalysisError} で止める
 */
export async function readUnitypackage(input: UnitypackageInput, limits: AnalyzeLimits): Promise<RawUnitypackage> {
  const result: RawUnitypackage = {
    entries: new Map(),
    notices: [],
    compressedBytes: 0,
    extractedBytes: 0,
    entryCount: 0,
  };

  let fatal: Error | undefined;
  const parser = new Parser({ strict: true });

  const fail = (err: Error) => {
    if (fatal) return;
    fatal = err;
    parser.abort(err);
  };

  parser.on("error", (err: Error) => {
    fatal ??= new UnitypackageAnalysisError("corrupt-archive", `broken tar: ${err.message}`, { cause: err });
  });

  const getEntry = (dir: string): RawGuidEntry => {
    let e = result.entries.get(dir);
    if (!e) {
      e = { hasPreview: false };
      result.entries.set(dir, e);
    }
    return e;
  };

  const readText = (entry: ReadEntry, max: number, onDone: (text: string) => void) => {
    if (entry.size > max) {
      fail(new UnitypackageAnalysisError("entry-too-large", `${entry.path} is ${entry.size} bytes (limit ${max})`));
      entry.resume();
      return;
    }
    const chunks: Buffer[] = [];
    entry.on("data", (c: Buffer) => chunks.push(c));
    entry.on("end", () => onDone(Buffer.concat(chunks).toString("utf8")));
  };

  parser.on("entry", (entry: ReadEntry) => {
    if (fatal) {
      entry.resume();
      return;
    }
    try {
      result.entryCount++;
      if (result.entryCount > limits.maxEntries) {
        throw new UnitypackageAnalysisError("too-many-entries", `more than ${limits.maxEntries} tar entries`);
      }
      const segments = entrySegments(entry.path);

      if (entry.type === "Directory") {
        entry.resume();
        return;
      }
      if (!FILE_TYPES.has(entry.type)) {
        throw new UnitypackageAnalysisError(
          "unsupported-entry-type",
          `unsupported tar entry type ${entry.type}: ${JSON.stringify(entry.path)}`,
        );
      }

      const [dir, name] = segments;
      if (segments.length !== 2 || dir === undefined || name === undefined || !KNOWN_NAMES.has(name)) {
        result.notices.push({ code: "unexpected-entry", path: segments.join("/") });
        entry.resume();
        return;
      }

      const e = getEntry(dir);
      const already =
        (name === "asset" && e.asset) ||
        (name === "asset.meta" && e.meta !== undefined) ||
        (name === "pathname" && e.pathname !== undefined) ||
        (name === "preview.png" && e.hasPreview);
      if (already) {
        result.notices.push({ code: "duplicate-entry", dir, name });
        entry.resume();
        return;
      }

      switch (name) {
        case "asset": {
          const hash = createHash("sha256");
          let size = 0;
          // 重複判定のために先に場所を確保しておく(本体は後から埋める)
          e.asset = { size: 0, sha256: "" };
          entry.on("data", (c: Buffer) => {
            size += c.length;
            hash.update(c);
          });
          entry.on("end", () => {
            e.asset = { size, sha256: hash.digest("hex") };
          });
          break;
        }
        case "asset.meta":
          e.meta = "";
          readText(entry, limits.maxMetaBytes, (text) => (e.meta = text));
          break;
        case "pathname":
          e.pathname = "";
          readText(entry, limits.maxPathnameBytes, (text) => (e.pathname = text));
          break;
        case "preview.png":
          e.hasPreview = true;
          entry.resume();
          break;
      }
    } catch (err) {
      entry.resume();
      fail(err as Error);
    }
  });

  const waitFor = (event: "drain" | "end") =>
    new Promise<void>((resolve) => {
      const done = () => {
        parser.off(event, done);
        parser.off("error", done);
        parser.off("abort", done);
        resolve();
      };
      parser.on(event, done);
      parser.on("error", done);
      parser.on("abort", done);
    });

  let firstInput = true;
  const countInput = new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (firstInput && chunk.length > 0) {
        firstInput = false;
        if (!startsWith(chunk, GZIP_MAGIC)) {
          cb(new UnitypackageAnalysisError("corrupt-archive", "input is not gzip-compressed"));
          return;
        }
      }
      result.compressedBytes += chunk.length;
      if (result.compressedBytes > limits.maxInputBytes) {
        cb(new UnitypackageAnalysisError("input-too-large", `input exceeds ${limits.maxInputBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });

  let firstOutput = true;
  const countOutput = new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (firstOutput && chunk.length > 0) {
        firstOutput = false;
        // tar の Parser は中身が圧縮されていると自動で展開してしまうので、二重圧縮は上限が効かなくなる
        if (startsWith(chunk, GZIP_MAGIC) || startsWith(chunk, ZSTD_MAGIC)) {
          cb(new UnitypackageAnalysisError("corrupt-archive", "nested compression is not supported"));
          return;
        }
      }
      result.extractedBytes += chunk.length;
      if (result.extractedBytes > limits.maxExtractedBytes) {
        cb(new UnitypackageAnalysisError("extracted-too-large", `extracted size exceeds ${limits.maxExtractedBytes} bytes`));
        return;
      }
      if (
        result.extractedBytes > limits.compressionRatioSlackBytes &&
        result.extractedBytes > result.compressedBytes * limits.maxCompressionRatio
      ) {
        cb(
          new UnitypackageAnalysisError(
            "compression-ratio-exceeded",
            `compression ratio exceeds ${limits.maxCompressionRatio} (possible gzip bomb)`,
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.from(toIterable(input)), countInput, createGunzip(), countOutput, async (source) => {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        if (fatal) throw fatal;
        if (!parser.write(chunk)) await waitFor("drain");
        if (fatal) throw fatal;
      }
      const ended = waitFor("end");
      parser.end();
      await ended;
      if (fatal) throw fatal;
    });
  } catch (err) {
    if (err instanceof UnitypackageAnalysisError) throw err;
    if (fatal) throw fatal;
    // zlib のエラー(壊れた gzip、途中で切れた入力など)
    throw new UnitypackageAnalysisError("corrupt-archive", `broken gzip: ${(err as Error).message}`, { cause: err });
  }

  if (firstOutput) {
    throw new UnitypackageAnalysisError("corrupt-archive", "empty archive");
  }
  return result;
}
