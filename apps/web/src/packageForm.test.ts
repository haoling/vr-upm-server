import type { FileTreeNode } from "@vr-upm/shared";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import {
  changeRoot,
  emptyForm,
  escapeGlob,
  exclusionState,
  findNode,
  formToConfigInput,
  relativeTo,
  suggestRoot,
  toggleExclude,
  validateForm,
} from "./packageForm.js";

const node = (path: string, kind: "file" | "folder", children: FileTreeNode[] = []): FileTreeNode => ({
  name: path.split("/").pop() ?? "",
  path,
  kind,
  guid: null,
  missingMeta: false,
  size: kind === "file" ? 1 : null,
  children,
});

const tree = node("", "folder", [
  node("Assets", "folder", [
    node("Assets/Shop", "folder", [
      node("Assets/Shop/Item", "folder", [
        node("Assets/Shop/Item/Models", "folder", [node("Assets/Shop/Item/Models/a.fbx", "file")]),
        node("Assets/Shop/Item/readme.txt", "file"),
      ]),
    ]),
  ]),
]);

describe("suggestRoot", () => {
  it("枝分かれするまで 1 つしかないフォルダをたどる", () => {
    expect(suggestRoot(tree)).toBe("Assets/Shop/Item");
  });
  it("ファイルしか無ければそのフォルダ", () => {
    expect(suggestRoot(node("", "folder", [node("a.txt", "file")]))).toBe("");
  });
});

describe("relativeTo / findNode", () => {
  it("ルートからの相対パス", () => {
    expect(relativeTo("Assets/Shop/Item", "Assets/Shop/Item/Models")).toBe("Models");
    expect(relativeTo("Assets/Shop/Item", "Assets/Shop/Item")).toBe("");
    expect(relativeTo("Assets/Shop/Item", "Assets/Shop/Other/x")).toBeNull();
    expect(relativeTo("Assets/Shop/Item", "Assets/Shop/ItemX")).toBeNull();
  });
  it("パスでノードを探す", () => {
    expect(findNode(tree, "Assets/Shop/Item/Models")?.kind).toBe("folder");
    expect(findNode(tree, "Assets/Nope")).toBeNull();
  });
});

describe("除外の指定", () => {
  it("escapeGlob した glob は picomatch で元のパスだけに一致する", () => {
    for (const path of ["Models/a [v2].fbx", "Tex (old)/b{1}.png", "x!y/z+w@q.txt", "plain/file.txt"]) {
      const glob = escapeGlob(path);
      expect(picomatch(glob, { dot: true })(path)).toBe(true);
      expect(picomatch(glob, { dot: true })(`${path}x`)).toBe(false);
    }
  });

  it("toggleExclude は追加・解除でき、フォルダを除外すると下の個別指定は外す", () => {
    let ex = toggleExclude([], "Textures/a.png");
    ex = toggleExclude(ex, "Textures/b.png");
    expect(ex).toEqual(["Textures/a.png", "Textures/b.png"]);
    ex = toggleExclude(ex, "Textures");
    expect(ex).toEqual(["Textures"]);
    expect(toggleExclude(ex, "Textures")).toEqual([]);
  });

  it("exclusionState は自分自身と祖先を見分ける", () => {
    const ex = ["Textures", "a\\[1\\].png"];
    expect(exclusionState(ex, "Textures")).toBe("self");
    expect(exclusionState(ex, "Textures/sub/x.png")).toBe("inherited");
    expect(exclusionState(ex, "a[1].png")).toBe("self");
    expect(exclusionState(ex, "Models")).toBeNull();
  });

  it("changeRoot は画面から追加した完全一致の除外を捨て、glob は残す", () => {
    const v = { ...emptyForm(), rootPath: "Assets/A", exclude: ["Textures", "**/*.psd"] };
    expect(changeRoot(v, "Assets/B")).toMatchObject({ rootPath: "Assets/B", exclude: ["**/*.psd"] });
  });
});

describe("フォームの検証", () => {
  const valid = {
    ...emptyForm(),
    packageName: "com.example.shop.item",
    displayName: "Item",
    rootPath: "Assets/Shop/Item",
  };

  it("空欄の任意項目は未指定にして ConvertConfig に通す", () => {
    expect(formToConfigInput({ ...valid, exclude: [" Textures ", ""] })).toMatchObject({
      packageName: "com.example.shop.item",
      exclude: ["Textures"],
      description: undefined,
      boothUrl: undefined,
    });
    const result = validateForm(valid);
    expect(result.ok).toBe(true);
  });

  it("不正な値は項目名つきのエラーにする", () => {
    const result = validateForm({ ...valid, packageName: "Bad Name", version: "1.0", rootPath: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("パッケージ名:"))).toBe(true);
      expect(result.errors.some((e) => e.startsWith("version:"))).toBe(true);
      expect(result.errors.some((e) => e.startsWith("ルート:"))).toBe(true);
    }
  });
});
