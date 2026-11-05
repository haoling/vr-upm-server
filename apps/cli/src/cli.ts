import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type AnalyzeLimits, analyzeUnitypackage, UnitypackageAnalysisError } from "@vr-upm/core";
import { runBuild } from "./build.js";
import { formatAnalysis, parseBytes } from "./format.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** 相対パスの基準(base-dir.ts を参照) */
  cwd: string;
}

const USAGE = `使い方:
  vr-upm analyze <file> [--json] [--max-input <size>] [--max-extracted <size>]
  vr-upm build <file> --config <json> [--out <tgz>] [--dry-run] [--json] [--max-input <size>] [--max-extracted <size>]

コマンド:
  analyze   .unitypackage を解析し、ファイルツリー・.meta が無いフォルダ・問題点を表示する
  build     変換設定(JSON)に従って .unitypackage を UPM の tarball(.tgz)に変換する。
            同じ入力・同じ設定なら、いつも同じ integrity になる

オプション:
  --json                 analyze: 解析結果(AnalysisResult)/ build: ビルド結果を JSON で出力する
  --config <json>        build: 変換設定の JSON(packageName, displayName, version, rootPath, exclude など)
  --out <tgz>            build: 出力先(省略すると ./<packageName>-<version>.tgz)
  --dry-run              build: tarball を作らず、含まれるファイルの一覧とサイズだけ表示する
  --max-input <size>     入力サイズの上限(例: 4GiB)
  --max-extracted <size> 展開後サイズの上限(例: 16GiB)
  -h, --help             この説明を表示する

終了コード: 0 = 完了 / 1 = 止めた(壊れた入力・上限超過・危険なパス・変換できない設定等)/ 2 = 引数・設定ファイルの誤り
`;

/**
 * CLI の本体。テストから呼べるよう、出力先と終了コードを返す形にしている。
 */
export async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        config: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "max-input": { type: "string" },
        "max-extracted": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    (values.help ? io.stdout : io.stderr)(USAGE);
    return values.help ? 0 : 2;
  }
  if (command !== "analyze" && command !== "build") {
    io.stderr(`不明なコマンドです: ${command}\n\n${USAGE}`);
    return 2;
  }
  const [file, ...extra] = rest;
  if (file === undefined || extra.length > 0) {
    io.stderr(`${command} にはファイルを 1 つ指定してください\n\n${USAGE}`);
    return 2;
  }
  if (command === "analyze" && (values.config !== undefined || values.out !== undefined || values["dry-run"])) {
    io.stderr(`--config / --out / --dry-run は build でだけ使えます\n\n${USAGE}`);
    return 2;
  }
  if (command === "build" && values.config === undefined) {
    io.stderr(`build には --config <json> が必要です\n\n${USAGE}`);
    return 2;
  }

  const limits: Partial<AnalyzeLimits> = {};
  try {
    if (values["max-input"] !== undefined) limits.maxInputBytes = parseBytes(values["max-input"]);
    if (values["max-extracted"] !== undefined) limits.maxExtractedBytes = parseBytes(values["max-extracted"]);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 2;
  }

  if (command === "build") {
    return runBuild(
      { file, configPath: values.config!, out: values.out, dryRun: values["dry-run"], json: values.json, limits },
      io,
    );
  }

  const path = resolve(io.cwd, file);
  try {
    const result = await analyzeUnitypackage(createReadStream(path), { limits });
    io.stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatAnalysis(basename(path), result));
    return 0;
  } catch (err) {
    if (err instanceof UnitypackageAnalysisError) {
      io.stderr(`${basename(path)}: 解析を中止しました [${err.code}] ${err.message}\n`);
      return 1;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "EACCES") {
      io.stderr(`${file}: ファイルを読めません (${code})\n`);
      return 1;
    }
    throw err;
  }
}
