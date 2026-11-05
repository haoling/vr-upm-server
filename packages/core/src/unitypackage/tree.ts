import type { AnalysisResult } from "@vr-upm/shared";

export interface FileTreeNode {
  /** パスの最後の要素(ルートは空文字) */
  name: string;
  /** フルパス(ルートは空文字) */
  path: string;
  kind: "file" | "folder";
  /** unitypackage に入っていた GUID。暗黙のフォルダ(エントリが無い)は null */
  guid: string | null;
  /** フォルダ .meta が入っておらず、変換時に生成が必要か */
  missingMeta: boolean;
  /** ファイルのバイト数(フォルダは null) */
  size: number | null;
  /** 名前順。ファイルは空配列 */
  children: FileTreeNode[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 解析結果の pathname 一覧からファイルツリーを作る。
 * エントリが無い中間フォルダも作り、`missingFolderMetas` に入っていれば `missingMeta` を立てる。
 */
export function buildFileTree(result: AnalysisResult): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", kind: "folder", guid: null, missingMeta: false, size: null, children: [] };
  const nodes = new Map<string, FileTreeNode>([["", root]]);
  const missing = new Set(result.missingFolderMetas);

  const ensureFolder = (path: string): FileTreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureFolder(slash === -1 ? "" : path.slice(0, slash));
    const node: FileTreeNode = {
      name: path.slice(slash + 1),
      path,
      kind: "folder",
      guid: null,
      missingMeta: missing.has(path),
      size: null,
      children: [],
    };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };

  for (const asset of result.assets) {
    if (asset.kind === "folder") {
      const node = ensureFolder(asset.pathname);
      node.guid ??= asset.guid;
      continue;
    }
    if (nodes.has(asset.pathname)) continue; // 重複パスは issues 側で報告済み
    const slash = asset.pathname.lastIndexOf("/");
    const parent = ensureFolder(slash === -1 ? "" : asset.pathname.slice(0, slash));
    const node: FileTreeNode = {
      name: asset.pathname.slice(slash + 1),
      path: asset.pathname,
      kind: "file",
      guid: asset.guid,
      missingMeta: false,
      size: asset.size,
      children: [],
    };
    parent.children.push(node);
    nodes.set(asset.pathname, node);
  }

  const sortChildren = (node: FileTreeNode) => {
    node.children.sort((a, b) => compare(a.name, b.name));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root;
}
