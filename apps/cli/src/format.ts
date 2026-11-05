import { buildFileTree, type FileTreeNode } from "@vr-upm/core";
import type { AnalysisResult } from "@vr-upm/shared";

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
