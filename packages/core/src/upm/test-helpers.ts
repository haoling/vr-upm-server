import { gunzipSync } from "node:zlib";
import { Writable } from "node:stream";
import { buildUnitypackage, type FixtureAsset, unitypackageEntries } from "@vr-upm/fixtures";
import { type ConvertConfig, ConvertConfig as ConvertConfigSchema, type ConvertConfigInput } from "@vr-upm/shared";
import { Parser } from "tar";
import { inspectUnitypackage } from "../unitypackage/analyze.js";
import { type AssetStore, packTarball, type TarballDigest } from "./pack.js";
import { planUpm, type UpmPlan } from "./plan.js";

export function makeConfig(overrides: Partial<ConvertConfigInput> = {}): ConvertConfig {
  return ConvertConfigSchema.parse({
    packageName: "com.example.shop.item",
    displayName: "Dummy Item",
    version: "1.0.0",
    rootPath: "Assets/DummyShop/DummyItem",
    ...overrides,
  });
}

export const SOURCE = { fileName: "dummy.unitypackage", sha256: "ab".repeat(32) };

export interface Converted {
  plan: UpmPlan;
  /** plan にエラーがあれば null */
  tgz: Buffer | null;
  digest: TarballDigest | null;
}

/** 中身を何バイトずつのチャンクで流すか(結果が変わらないことのテスト用) */
export interface ConvertOptions {
  inputChunk?: number;
  storeChunk?: number;
}

function chunked(bytes: Uint8Array, size: number | undefined): Uint8Array[] {
  if (!size) return [bytes];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** unitypackage の組み立て → 解析 → 計画 → tgz を、すべてメモリ上で行う */
export async function convert(
  assets: FixtureAsset[],
  config: ConvertConfig = makeConfig(),
  options: ConvertOptions = {},
): Promise<Converted> {
  const input = buildUnitypackage(unitypackageEntries(assets));
  const contents = new Map<string, Buffer[]>();
  const { analysis, metas } = await inspectUnitypackage(chunked(input, options.inputChunk), {
    assetSink: (guid) => {
      const chunks: Buffer[] = [];
      contents.set(guid, chunks);
      return new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
    },
  });
  const plan = planUpm(analysis, metas, config, SOURCE);
  if (plan.errors.length > 0) return { plan, tgz: null, digest: null };

  const store: AssetStore = {
    open: (guid) => chunked(Buffer.concat(contents.get(guid)!), options.storeChunk),
  };
  const out: Buffer[] = [];
  const digest = await packTarball(
    plan,
    store,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        out.push(Buffer.from(chunk));
        cb();
      },
    }),
  );
  return { plan, tgz: Buffer.concat(out), digest };
}

export interface ReadTarEntry {
  path: string;
  type: string;
  mode: number | undefined;
  uid: number | undefined;
  gid: number | undefined;
  uname: string | undefined;
  mtime: number | undefined;
  content: string;
}

/** tgz を `tar` ライブラリで読み戻す(書き出し側とは別実装なので、構造の検証になる) */
export async function readTgz(tgz: Buffer): Promise<ReadTarEntry[]> {
  const entries: ReadTarEntry[] = [];
  const parser = new Parser({ strict: true });
  parser.on("entry", (entry) => {
    const chunks: Buffer[] = [];
    entry.on("data", (c: Buffer) => chunks.push(c));
    entry.on("end", () => {
      entries.push({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        uname: entry.uname,
        mtime: entry.mtime?.getTime(),
        content: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    parser.on("end", resolve);
    parser.on("error", reject);
    parser.end(gunzipSync(tgz));
  });
  return entries;
}
