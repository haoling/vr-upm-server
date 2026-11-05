import { z } from "zod";

/**
 * UPM への変換設定(DESIGN.md 3.2 の基本設定)。
 *
 * Package のテンプレートや Build の `config_snapshot` にそのまま保存する形。
 * 形を変えるときは後方互換を保つこと(保存済みの JSON から同じ tarball を再ビルドできる必要がある)。
 */

/** UPM のパッケージ名(例: `com.haoling.booth.shop.item`)。小文字・数字・`.` `-` `_` のみ */
export const UpmPackageName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "小文字・数字・'.' '-' '_' だけが使えます(スコープ '@' は使えません)");

/** https://semver.org の正規表現 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const Semver = z.string().regex(SEMVER, "semver(例: 1.0.0)で指定してください");

/**
 * unitypackage 内のパス(例: `Assets/Shop/Item`)。`\` は `/` に直し、前後の `/` を取り除く。
 * `..` や絶対パスは使えない。
 */
export const AssetRootPath = z
  .string()
  .transform((v) => v.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
  .refine((v) => v !== "", "空にはできません")
  .refine((v) => !v.split("/").some((s) => s === ".." || s === "." || s === ""), "'.' や '..'、空の要素は使えません")
  .refine((v) => !/^[A-Za-z]:/.test(v) && !v.includes("\0"), "絶対パスは使えません");

export const ConvertConfig = z.object({
  /** UPM パッケージ名 */
  packageName: UpmPackageName,
  displayName: z.string().min(1),
  /** UPM としての version(semver)。BOOTH 側の表記は `sourceVersionLabel` に残す */
  version: Semver,
  /** BOOTH など配布元での version 表記(例: `Ver.1.2.3`)。メタ情報として記録するだけ */
  sourceVersionLabel: z.string().optional(),
  /** パッケージのルートにする unitypackage 内のフォルダ。このプレフィックスを剥がす */
  rootPath: AssetRootPath,
  /**
   * 除外する glob(picomatch)。ルートを剥がした後のパスに対して判定する。
   * フォルダに一致すれば、その下もすべて除外する。
   */
  exclude: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
  /** 対応する Unity のバージョン(例: `2022.3`) */
  unity: z
    .string()
    .regex(/^\d{4}\.\d+$/, "例: 2022.3")
    .optional(),
  /** 入手元(BOOTH)の URL。package.json のメタ情報に入る */
  boothUrl: z.url({ protocol: /^https?$/ }).optional(),
});
export type ConvertConfig = z.infer<typeof ConvertConfig>;
export type ConvertConfigInput = z.input<typeof ConvertConfig>;
