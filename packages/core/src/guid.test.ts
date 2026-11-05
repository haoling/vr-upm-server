import { describe, expect, it } from "vitest";
import { deterministicFolderGuid, isUnityGuid } from "./guid.js";

describe("deterministicFolderGuid", () => {
  it("同じ入力なら同じ GUID を返す", () => {
    const a = deterministicFolderGuid("com.haoling.booth.shop.item", "Runtime/Textures");
    const b = deterministicFolderGuid("com.haoling.booth.shop.item", "Runtime/Textures");
    expect(a).toBe(b);
    expect(isUnityGuid(a)).toBe(true);
  });

  it("区切り文字と前後のスラッシュの違いを吸収する", () => {
    const a = deterministicFolderGuid("pkg", "Runtime/Textures");
    expect(deterministicFolderGuid("pkg", "Runtime\\Textures")).toBe(a);
    expect(deterministicFolderGuid("pkg", "/Runtime/Textures/")).toBe(a);
  });

  it("パッケージ名かパスが違えば別の GUID になる", () => {
    const base = deterministicFolderGuid("pkg", "Runtime");
    expect(deterministicFolderGuid("pkg2", "Runtime")).not.toBe(base);
    expect(deterministicFolderGuid("pkg", "Editor")).not.toBe(base);
  });
});
