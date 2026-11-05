import { ConvertConfig, type ConvertConfigInput, type FileTreeNode } from "@vr-upm/shared";

/** パッケージ設定フォームの値。入力欄に合わせて全部文字列(除外だけ glob の配列) */
export interface PackageFormValues {
  packageName: string;
  displayName: string;
  version: string;
  sourceVersionLabel: string;
  rootPath: string;
  exclude: string[];
  description: string;
  unity: string;
  boothUrl: string;
}

export function emptyForm(): PackageFormValues {
  return {
    packageName: "",
    displayName: "",
    version: "1.0.0",
    sourceVersionLabel: "",
    rootPath: "",
    exclude: [],
    description: "",
    unity: "",
    boothUrl: "",
  };
}

export function configToForm(config: ConvertConfig): PackageFormValues {
  return {
    packageName: config.packageName,
    displayName: config.displayName,
    version: config.version,
    sourceVersionLabel: config.sourceVersionLabel ?? "",
    rootPath: config.rootPath,
    exclude: config.exclude,
    description: config.description ?? "",
    unity: config.unity ?? "",
    boothUrl: config.boothUrl ?? "",
  };
}

/** 空欄は「未指定」にして ConvertConfig の入力にする */
export function formToConfigInput(v: PackageFormValues): ConvertConfigInput {
  const optional = (s: string) => (s.trim() === "" ? undefined : s.trim());
  return {
    packageName: v.packageName.trim(),
    displayName: v.displayName.trim(),
    version: v.version.trim(),
    sourceVersionLabel: optional(v.sourceVersionLabel),
    rootPath: v.rootPath,
    exclude: v.exclude.map((g) => g.trim()).filter((g) => g !== ""),
    description: optional(v.description),
    unity: optional(v.unity),
    boothUrl: optional(v.boothUrl),
  };
}

/** フォームの値を検証する。サーバーと同じ ConvertConfig のスキーマを使う */
export function validateForm(v: PackageFormValues): { ok: true; config: ConvertConfig } | { ok: false; errors: string[] } {
  const parsed = ConvertConfig.safeParse(formToConfigInput(v));
  if (parsed.success) return { ok: true, config: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${FIELD_LABELS[String(i.path[0])] ?? String(i.path[0] ?? "")}: ${i.message}`) };
}

const FIELD_LABELS: Record<string, string> = {
  packageName: "パッケージ名",
  displayName: "表示名",
  version: "version",
  rootPath: "ルート",
  exclude: "除外",
  unity: "Unity",
  boothUrl: "BOOTH URL",
};

/**
 * 解析結果のツリーから、パッケージのルートの候補を決める。
 * 枝分かれするまで、フォルダが 1 つだけの階層(`Assets/作者/商品` の `Assets/作者` など)をたどる。
 */
export function suggestRoot(tree: FileTreeNode): string {
  let node = tree;
  while (node.children.length === 1 && node.children[0]?.kind === "folder") {
    node = node.children[0];
  }
  return node.path;
}

/** `Assets/Shop/Item` を `Assets/Shop` の相対パス `Item` にする。ルートの外なら null、ルート自身は "" */
export function relativeTo(root: string, path: string): string | null {
  if (root === "") return path;
  if (path === root) return "";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** パスを glob のリテラルとして使えるようにする(picomatch の特殊文字をエスケープ) */
export function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@|]/g, "\\$&");
}

/** 自分自身(`self`)か、祖先のフォルダ(`inherited`)が除外に入っているか。glob の評価はせず、画面から追加した完全一致だけを見る */
export function exclusionState(exclude: readonly string[], rel: string): "self" | "inherited" | null {
  const set = new Set(exclude);
  if (set.has(escapeGlob(rel))) return "self";
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (set.has(escapeGlob(parts.slice(0, i).join("/")))) return "inherited";
  }
  return null;
}

/** ツリー上の除外チェックを切り替える。フォルダを除外するとその下の個別指定は不要なので外す */
export function toggleExclude(exclude: readonly string[], rel: string): string[] {
  const glob = escapeGlob(rel);
  if (exclude.includes(glob)) return exclude.filter((g) => g !== glob);
  const prefix = `${glob}/`;
  return [...exclude.filter((g) => !g.startsWith(prefix)), glob];
}

export function findNode(tree: FileTreeNode, path: string): FileTreeNode | null {
  if (tree.path === path) return tree;
  for (const child of tree.children) {
    if (path === child.path || path.startsWith(`${child.path}/`)) return findNode(child, path);
  }
  return null;
}

/** ルートに選べる(フォルダである)パスか */
export function isFolderPath(tree: FileTreeNode, path: string): boolean {
  return findNode(tree, path)?.kind === "folder";
}

/** ルートを変えると相対パスの意味が変わるので、画面から追加した除外(完全一致のもの)は捨てる */
export function changeRoot(values: PackageFormValues, rootPath: string): PackageFormValues {
  return { ...values, rootPath, exclude: values.exclude.filter((g) => g.includes("*")) };
}
