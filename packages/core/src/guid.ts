import { createHash } from "node:crypto";

/**
 * Unity の GUID(32 桁の小文字 16 進数)。
 */
export type UnityGuid = string;

const GUID_PATTERN = /^[0-9a-f]{32}$/;

export function isUnityGuid(value: string): value is UnityGuid {
  return GUID_PATTERN.test(value);
}

/**
 * 欠けているフォルダ .meta 用の GUID を決定的に生成する(DESIGN.md 3.3)。
 *
 * `hash(パッケージ名 + 相対パス)` から作るので、同じパッケージ・同じパスなら
 * バージョンをまたいでも同じ GUID になる。
 */
export function deterministicFolderGuid(packageName: string, relativePath: string): UnityGuid {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return createHash("sha256")
    .update(`${packageName}\0${normalized}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
