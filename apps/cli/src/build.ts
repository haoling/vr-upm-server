import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type AnalyzeLimits,
  type AssetSink,
  inspectUnitypackage,
  packTarball,
  planUpm,
  UnitypackageAnalysisError,
  type TarballDigest,
  type UpmPlan,
} from "@vr-upm/core";
import { ConvertConfig } from "@vr-upm/shared";
import type { CliIO } from "./cli.js";
import { formatBuildReport } from "./format.js";

export interface BuildOptions {
  file: string;
  configPath: string;
  out: string | undefined;
  dryRun: boolean;
  json: boolean;
  limits: Partial<AnalyzeLimits>;
}

/** 読み込みながら sha256 を取る(ファイルを 2 回読まずに済む) */
async function* tapHash(stream: AsyncIterable<Uint8Array>, hash: ReturnType<typeof createHash>) {
  for await (const chunk of stream) {
    hash.update(chunk);
    yield chunk;
  }
}

/** `com.example.item` + `1.0.0` → `com.example.item-1.0.0.tgz`(npm pack と同じ命名) */
export function defaultTarballName(packageName: string, version: string): string {
  return `${packageName}-${version}.tgz`;
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  return codes.includes((err as NodeJS.ErrnoException).code ?? "");
}

/**
 * `vr-upm build`。終了コード: 0 = 完了 / 1 = 止めた(解析できない・変換設定に合わないなど)/ 2 = 設定ファイルの誤り。
 */
export async function runBuild(opts: BuildOptions, io: CliIO): Promise<number> {
  // 変換設定
  let config: ConvertConfig;
  try {
    const raw = JSON.parse(await readFile(resolve(io.cwd, opts.configPath), "utf8"));
    const parsed = ConvertConfig.safeParse(raw);
    if (!parsed.success) {
      const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
      io.stderr(`${opts.configPath}: 変換設定が正しくありません\n${lines.join("\n")}\n`);
      return 2;
    }
    config = parsed.data;
  } catch (err) {
    if (err instanceof SyntaxError) {
      io.stderr(`${opts.configPath}: JSON として読めません (${err.message})\n`);
      return 2;
    }
    if (isErrno(err, "ENOENT", "EISDIR", "EACCES")) {
      io.stderr(`${opts.configPath}: 設定ファイルを読めません (${(err as NodeJS.ErrnoException).code})\n`);
      return 2;
    }
    throw err;
  }

  const inputPath = resolve(io.cwd, opts.file);
  const outPath = resolve(io.cwd, opts.out ?? defaultTarballName(config.packageName, config.version));
  const name = basename(inputPath);

  // dry-run は asset の中身を書き出さない。ビルドは一時ディレクトリに展開して、tarball 生成後に消す
  const workDir = opts.dryRun ? null : await mkdtemp(join(tmpdir(), "vr-upm-build-"));
  const files = new Map<string, string>(); // guid → 一時ファイル(ディレクトリ名は外部入力なのでファイル名には使わない)
  const assetSink: AssetSink | undefined = workDir
    ? (guid) => {
        const file = join(workDir, `${files.size}.bin`);
        files.set(guid, file);
        return createWriteStream(file);
      }
    : undefined;

  const tmpOut = `${outPath}.tmp-${process.pid}`;
  try {
    const hash = createHash("sha256");
    let inspected;
    try {
      inspected = await inspectUnitypackage(tapHash(createReadStream(inputPath), hash), { limits: opts.limits, assetSink });
    } catch (err) {
      if (err instanceof UnitypackageAnalysisError) {
        io.stderr(`${name}: 変換を中止しました [${err.code}] ${err.message}\n`);
        return 1;
      }
      if (isErrno(err, "ENOENT", "EISDIR", "EACCES")) {
        io.stderr(`${opts.file}: ファイルを読めません (${(err as NodeJS.ErrnoException).code})\n`);
        return 1;
      }
      throw err;
    }

    const plan: UpmPlan = planUpm(inspected.analysis, inspected.metas, config, { fileName: name, sha256: hash.digest("hex") });

    let digest: TarballDigest | null = null;
    if (plan.errors.length === 0 && !opts.dryRun) {
      try {
        digest = await packTarball(
          plan,
          { open: (guid) => createReadStream(files.get(guid)!) },
          createWriteStream(tmpOut),
        );
        await rename(tmpOut, outPath);
      } catch (err) {
        await rm(tmpOut, { force: true });
        if (isErrno(err, "ENOENT", "EISDIR", "EACCES", "ENOSPC")) {
          io.stderr(`${opts.out ?? outPath}: tarball を書き出せません (${(err as NodeJS.ErrnoException).code})\n`);
          return 1;
        }
        throw err;
      }
    }

    io.stdout(
      formatBuildReport({
        sourceName: name,
        config,
        plan,
        digest,
        outPath: digest ? outPath : null,
        dryRun: opts.dryRun,
        json: opts.json,
      }),
    );
    if (plan.errors.length > 0) {
      io.stderr(`${plan.errors.length} 件のエラーがあるため、tarball は作りませんでした\n`);
      return 1;
    }
    return 0;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}
