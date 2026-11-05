import { buildFileTree, type FileTreeNode } from "@vr-upm/core";
import type { TarballDigest, UpmPlan } from "@vr-upm/core";
import type { AnalysisResult, ConvertConfig } from "@vr-upm/shared";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** `1024`, `512KiB`, `64M`, `4GiB` のようなサイズ指定をバイト数にする */
export function parseBytes(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(?:(k|m|g|t)(?:i?b)?|b)?$/i.exec(text.trim());
  if (!m) throw new Error(`サイズの指定が読めません: ${text}`);
  const power = { k: 1, m: 2, g: 3, t: 4 }[(m[2] ?? "").toLowerCase()] ?? 0;
  return Math.floor(Number(m[1]) * 1024 ** power);
}

function treeLines(node: FileTreeNode, prefix: string, isLast: boolean, depth: number, out: string[]) {
  const branch = depth === 0 ? "" : isLast ? "└── " : "├── ";
  const label =
    node.kind === "folder"
      ? `${node.name}/${node.missingMeta ? "  [.meta なし]" : ""}`
      : `${node.name}  ${formatBytes(node.size ?? 0)}`;
  out.push(`${prefix}${branch}${label}`);
  const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`;
  node.children.forEach((child, i) => treeLines(child, childPrefix, i === node.children.length - 1, depth + 1, out));
}

const SEVERITY_LABEL = { error: "エラー", warning: "警告", info: "情報" } as const;

/** `vr-upm analyze` の人間向け出力 */
export function formatAnalysis(name: string, result: AnalysisResult): string {
  const { stats } = result;
  const out: string[] = [];
  out.push(name);
  out.push(
    `  ファイル ${stats.fileCount} 個(${formatBytes(stats.totalAssetBytes)})/ フォルダ .meta ${stats.folderCount} 個 / tar エントリ ${stats.entryCount} 個`,
  );
  out.push("");

  const root = buildFileTree(result);
  if (root.children.length === 0) {
    out.push("(アセットなし)");
  }
  for (const top of root.children) {
    treeLines(top, "", true, 0, out);
  }
  out.push("");

  out.push(`.meta が無いフォルダ: ${result.missingFolderMetas.length} 個`);
  for (const path of result.missingFolderMetas) {
    out.push(`  ${path}`);
  }
  out.push("");

  out.push(`問題: ${result.issues.length === 0 ? "なし" : `${result.issues.length} 件`}`);
  for (const issue of result.issues) {
    out.push(`  [${SEVERITY_LABEL[issue.severity]}] ${issue.code}: ${issue.message}`);
  }
  return `${out.join("\n")}\n`;
}

const ORIGIN_LABEL = { asset: "", meta: "", "generated-meta": "  [.meta 生成]", package: "  [生成]" } as const;

export interface BuildReportInput {
  sourceName: string;
  config: ConvertConfig;
  plan: UpmPlan;
  digest: TarballDigest | null;
  /** 書き出した tgz のパス(dry-run・エラー時は null) */
  outPath: string | null;
  dryRun: boolean;
  json: boolean;
}

/** `vr-upm build` の出力。`--json` ではファイル一覧・メッセージ・integrity を機械可読で出す */
export function formatBuildReport(r: BuildReportInput): string {
  const { plan, config } = r;
  const totalBytes = plan.files.reduce((sum, f) => sum + f.size, 0);

  if (r.json) {
    return `${JSON.stringify(
      {
        dryRun: r.dryRun,
        packageName: config.packageName,
        version: config.version,
        out: r.outPath,
        integrity: r.digest?.integrity ?? null,
        shasum: r.digest?.shasum ?? null,
        tarballBytes: r.digest?.size ?? null,
        fileCount: plan.files.length,
        totalBytes,
        outsideRootCount: plan.outsideRootCount,
        excluded: plan.excluded,
        files: plan.files.map((f) => ({ path: f.path, size: f.size, origin: f.origin })),
        errors: plan.errors,
        warnings: plan.warnings,
      },
      null,
      2,
    )}\n`;
  }

  const out: string[] = [];
  out.push(`${r.sourceName} → ${config.packageName}@${config.version}${r.dryRun ? "(dry-run: tarball は作りません)" : ""}`);
  out.push(`  ルート: ${config.rootPath}(外のアセット ${plan.outsideRootCount} 個は取り込まない)`);
  out.push(`  除外: ${plan.excluded.length} 個${config.exclude.length > 0 ? `(${config.exclude.join(", ")})` : ""}`);
  out.push("");

  if (r.dryRun || plan.errors.length > 0) {
    out.push(`ファイル(package/ 配下): ${plan.files.length} 個, ${formatBytes(totalBytes)}`);
    for (const f of plan.files) {
      out.push(`  ${f.path}  ${formatBytes(f.size)}${ORIGIN_LABEL[f.origin]}`);
    }
    if (plan.excluded.length > 0) {
      out.push("");
      out.push("除外したアセット:");
      for (const path of plan.excluded) out.push(`  ${path}`);
    }
    out.push("");
  }

  if (plan.warnings.length > 0) {
    out.push(`警告: ${plan.warnings.length} 件`);
    for (const w of plan.warnings) out.push(`  [${w.code}] ${w.message}`);
    out.push("");
  }
  if (plan.errors.length > 0) {
    out.push(`エラー: ${plan.errors.length} 件`);
    for (const e of plan.errors) out.push(`  [${e.code}] ${e.message}`);
    out.push("");
  }

  if (r.digest && r.outPath) {
    out.push(`出力: ${r.outPath}`);
    out.push(`  ファイル ${plan.files.length} 個 / 展開後 ${formatBytes(totalBytes)} / tgz ${formatBytes(r.digest.size)}`);
    out.push(`  integrity: ${r.digest.integrity}`);
    out.push(`  shasum:    ${r.digest.shasum}`);
  } else if (r.dryRun && plan.errors.length === 0) {
    out.push("問題はありません。--dry-run を外すと tarball を作ります");
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
