import { describe, expect, it } from "vitest";
import { normalizeAssetPathname, UnsafePathnameError } from "./pathname.js";

describe("normalizeAssetPathname", () => {
  it("通常のパスを正規化する", () => {
    expect(normalizeAssetPathname("Assets/Shop/Item/a.fbx")).toBe("Assets/Shop/Item/a.fbx");
    expect(normalizeAssetPathname("Assets\\Shop\\./a.fbx\n00")).toBe("Assets/Shop/a.fbx");
  });

  it.each([
    ["../etc/passwd"],
    ["Assets/../../x"],
    ["/abs/path"],
    ["C:/Windows/x"],
    [""],
    ["./"],
    ["a\0b"],
  ])("危険なパス %j を拒否する", (input) => {
    expect(() => normalizeAssetPathname(input)).toThrow(UnsafePathnameError);
  });
});
