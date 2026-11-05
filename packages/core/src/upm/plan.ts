import type { AnalysisResult, AnalyzedAsset, ConvertConfig } from "@vr-upm/shared";
import picomatch from "picomatch";
import { deterministicFolderGuid } from "../guid.js";
import { parseMetaGuid } from "../unitypackage/analyze.js";

/** 変換元の unitypackage の情報(package.json のメタ情報になる) */
export interface SourceInfo {
  fileName: string;
  sha256: string;
}

export type PlannedContent =
  /** unitypackage の `<guid>/asset`。中身は {@link AssetStore} から読む */
  | { kind: "asset"; guid: string }
  /** メモリ上のテキスト(.meta、package.json) */
  | { kind: "text"; text: string };

export type PlannedFileOrigin =
  /** 元のアセット */
  | "asset"
  /** 元の .meta(そのまま維持。GUID も変えない) */
  | "meta"
  /** 元に無かったので決定的な GUID で作ったフォルダ .meta */
  | "generated-meta"
  /** package.json とその .meta */
  | "package";

export interface PlannedFile {
  /** tarball 内の `package/` を除いたパス */
  path: string;
  size: number;
  origin: PlannedFileOrigin;
  content: PlannedContent;
}

export type PlanMessageCode =
  | "root-not-found"
  | "no-files"
  | "duplicate-path"
  | "file-folder-conflict"
  | "duplicate-guid"
  | "reserved-path"
  | "missing-meta"
  | "meta-guid-mismatch";

export interface PlanMessage {
  code: PlanMessageCode;
  message: string;
  path?: string;
}

export interface UpmPlan {
  /** 生成する package.json の内容(`files` にも入っている) */
  packageJson: Record<string, unknown>;
  /** tarball に入れるファイル。tar のエントリ順そのまま(package.json → 残りはパス順) */
  files: PlannedFile[];
  /** 空でなければ tarball は作れない */
  errors: PlanMessage[];
  warnings: PlanMessage[];
  /** ルートの外にあって取り込まなかったアセット(フォルダ含む)の数 */
  outsideRootCount: number;
  /** 除外 glob に一致して取り込まなかったアセットのパス(ルートを剥がした後。ソート済み) */
  excluded: string[];
}

/** 文字列の大小比較(ロケールに依存させない。tar のエントリ順をどの環境でも固定する) */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const textSize = (text: string) => Buffer.byteLength(text, "utf8");

/** Unity が作るフォルダ .meta と同じ形 */
export function folderMetaText(guid: string): string {
  return `fileFormatVersion: 2\nguid: ${guid}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
}

function packageJsonMetaText(guid: string): string {
  return `fileFormatVersion: 2\nguid: ${guid}\nTextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
}

/** キー順を固定した package.json(DESIGN.md 3.3 の 2) */
export function buildPackageJson(config: ConvertConfig, source: SourceInfo): Record<string, unknown> {
  const sourceInfo: Record<string, unknown> = { fileName: source.fileName, sha256: source.sha256 };
  if (config.sourceVersionLabel !== undefined) sourceInfo.versionLabel = config.sourceVersionLabel;
  if (config.boothUrl !== undefined) sourceInfo.boothUrl = config.boothUrl;
  sourceInfo.rootPath = config.rootPath;

  const json: Record<string, unknown> = {
    name: config.packageName,
    version: config.version,
    displayName: config.displayName,
  };
  if (config.description !== undefined) json.description = config.description;
  if (config.unity !== undefined) json.unity = config.unity;
  json.vrUpm = { source: sourceInfo };
  return json;
}

function parentsOf(path: string): string[] {
  const segments = path.split("/");
  const result: string[] = [];
  for (let i = 1; i < segments.length; i++) result.push(segments.slice(0, i).join("/"));
  return result;
}

/**
 * 解析結果と変換設定から、tarball に入れるファイルの一覧を決める(DESIGN.md 3.2 / 3.3)。
 *
 * 純粋関数で、中身の読み書きはしない。dry-run のレポートにも、そのまま tarball の生成にも使う。
 * - ルートのプレフィックスを剥がし、ルートの外と除外 glob に一致するものを落とす
 * - 元の .meta はそのまま維持する(GUID を変えない)
 * - .meta が無いフォルダには `deterministicFolderGuid(パッケージ名, 相対パス)` で .meta を作る
 *
 * @param metas `<guid>` ディレクトリ名 → asset.meta の本文({@link inspectUnitypackage} の結果)
 */
export function planUpm(
  analysis: AnalysisResult,
  metas: ReadonlyMap<string, string>,
  config: ConvertConfig,
  source: SourceInfo,
): UpmPlan {
  const errors: PlanMessage[] = [];
  const warnings: PlanMessage[] = [];
  const root = config.rootPath;
  const rootPrefix = `${root}/`;
  const isExcluded = picomatch(config.exclude, { dot: true });

  let outsideRootCount = 0;
  let sawRoot = false;
  const excluded: string[] = [];
  const kept: { rel: string; asset: AnalyzedAsset }[] = [];

  for (const asset of analysis.assets) {
    if (asset.pathname === root) {
      sawRoot = true; // ルートのフォルダ自体は、パッケージのルートになるので入れない
      continue;
    }
    if (!asset.pathname.startsWith(rootPrefix)) {
      outsideRootCount++;
      continue;
    }
    sawRoot = true;
    const rel = asset.pathname.slice(rootPrefix.length);
    // 自分自身か、祖先のフォルダが除外 glob に一致すれば除外
    if ([...parentsOf(rel), rel].some((p) => isExcluded(p))) {
      excluded.push(rel);
      continue;
    }
    kept.push({ rel, asset });
  }
  excluded.sort(compareCodeUnits);

  if (!sawRoot) {
    errors.push({ code: "root-not-found", message: `ルート ${root} の下にアセットがありません`, path: root });
  }

  // パスの衝突(Windows でも展開できるよう、大文字小文字は区別しない)
  const byLowerPath = new Map<string, string>();
  const filePaths = new Set<string>();
  const folderPaths = new Set<string>();
  for (const { rel, asset } of kept) {
    const lower = rel.toLowerCase();
    const prev = byLowerPath.get(lower);
    if (prev !== undefined) {
      errors.push({ code: "duplicate-path", message: `${rel} に複数のアセットがあります(${prev === rel ? "同じパス" : prev})`, path: rel });
      continue;
    }
    byLowerPath.set(lower, rel);
    (asset.kind === "file" ? filePaths : folderPaths).add(rel);
  }
  for (const { rel } of kept) {
    for (const parent of parentsOf(rel)) {
      if (filePaths.has(parent)) {
        errors.push({ code: "file-folder-conflict", message: `${parent} はファイルですが、その下にもアセットがあります`, path: parent });
      } else {
        folderPaths.add(parent);
      }
    }
  }

  const files: PlannedFile[] = [];
  const guids = new Map<string, string>(); // .meta の guid → それを使う最初のパス
  const claimGuid = (guid: string, path: string) => {
    const prev = guids.get(guid);
    if (prev !== undefined) {
      errors.push({ code: "duplicate-guid", message: `GUID ${guid} が ${prev} と ${path} で重複しています`, path });
    } else {
      guids.set(guid, path);
    }
  };

  const keptByPath = new Map(kept.map((k) => [k.rel, k.asset]));
  const addMeta = (path: string, asset: AnalyzedAsset | undefined, folder: boolean) => {
    const metaPath = `${path}.meta`;
    const text = asset ? metas.get(asset.guid) : undefined;
    const guid = text === undefined ? null : parseMetaGuid(text);
    if (text !== undefined && guid !== null) {
      if (asset && asset.guid.toLowerCase() !== guid) {
        warnings.push({
          code: "meta-guid-mismatch",
          message: `${path} の .meta の guid (${guid}) が unitypackage 内のディレクトリ名と違います(.meta の guid を使います)`,
          path,
        });
      }
      claimGuid(guid, path);
      files.push({ path: metaPath, size: textSize(text), origin: "meta", content: { kind: "text", text } });
      return;
    }
    if (folder) {
      const generated = deterministicFolderGuid(config.packageName, path);
      const generatedText = folderMetaText(generated);
      claimGuid(generated, path);
      files.push({ path: metaPath, size: textSize(generatedText), origin: "generated-meta", content: { kind: "text", text: generatedText } });
      return;
    }
    warnings.push({
      code: "missing-meta",
      message: `${path} に .meta がありません。Unity は .meta の無いファイルを読み込まないので、そのまま入れます`,
      path,
    });
  };

  for (const path of filePaths) {
    const asset = keptByPath.get(path)!;
    files.push({ path, size: asset.size ?? 0, origin: "asset", content: { kind: "asset", guid: asset.guid } });
    addMeta(path, asset, false);
  }
  for (const path of folderPaths) {
    addMeta(path, keptByPath.get(path), true);
  }

  if (files.length === 0 && errors.length === 0) {
    errors.push({ code: "no-files", message: "変換後のパッケージにファイルが 1 つも残りません(ルート・除外の設定を確認してください)" });
  }

  // package.json とその .meta。同名のアセットがあれば衝突として止める
  const packageJson = buildPackageJson(config, source);
  const packageJsonText = `${JSON.stringify(packageJson, null, 2)}\n`;
  const packageJsonMetaGuid = deterministicFolderGuid(config.packageName, "package.json");
  const packageJsonMeta = packageJsonMetaText(packageJsonMetaGuid);
  const reserved = new Set(["package.json", "package.json.meta"]);
  for (const f of files) {
    if (reserved.has(f.path)) {
      errors.push({ code: "reserved-path", message: `${f.path} は変換で生成するため、パッケージ内に置けません`, path: f.path });
    }
  }
  claimGuid(packageJsonMetaGuid, "package.json");

  files.sort((a, b) => compareCodeUnits(a.path, b.path));
  files.unshift(
    { path: "package.json", size: textSize(packageJsonText), origin: "package", content: { kind: "text", text: packageJsonText } },
    { path: "package.json.meta", size: textSize(packageJsonMeta), origin: "package", content: { kind: "text", text: packageJsonMeta } },
  );

  warnings.sort((a, b) => compareCodeUnits(a.path ?? "", b.path ?? "") || compareCodeUnits(a.code, b.code));
  errors.sort((a, b) => compareCodeUnits(a.code, b.code) || compareCodeUnits(a.path ?? "", b.path ?? ""));

  return { packageJson, files, errors, warnings, outsideRootCount, excluded };
}
