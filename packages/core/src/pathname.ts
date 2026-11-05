/**
 * unitypackage の `<guid>/pathname` に書かれたパスを検証・正規化する(DESIGN.md 8.2)。
 *
 * 入力は外部ファイルなので、パストラバーサル(`..`)や絶対パスを拒否する。
 */
export class UnsafePathnameError extends Error {
  constructor(
    readonly pathname: string,
    reason: string,
  ) {
    super(`unsafe pathname ${JSON.stringify(pathname)}: ${reason}`);
    this.name = "UnsafePathnameError";
  }
}

export function normalizeAssetPathname(raw: string): string {
  // pathname ファイルは 1 行目だけがパス。2 行目以降(古い形式の付加情報)は無視する。
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const pathname = firstLine.trim().replace(/\\/g, "/");

  if (pathname === "") {
    throw new UnsafePathnameError(raw, "empty");
  }
  if (pathname.includes("\0")) {
    throw new UnsafePathnameError(raw, "contains NUL");
  }
  if (pathname.startsWith("/") || /^[A-Za-z]:/.test(pathname)) {
    throw new UnsafePathnameError(raw, "absolute path");
  }

  const segments = pathname.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new UnsafePathnameError(raw, "path traversal");
  }
  if (segments.length === 0) {
    throw new UnsafePathnameError(raw, "empty");
  }
  return segments.join("/");
}
