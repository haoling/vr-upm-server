import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtures, generateFixtures } from "@vr-upm/fixtures";
import { AnalysisResult } from "@vr-upm/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import { parseBytes } from "./format.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vr-upm-cli-test-"));
  await generateFixtures(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runCli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd: dir,
  });
  return { code, stdout, stderr };
}

describe("vr-upm analyze", () => {
  describe.each(fixtures.filter((f) => !f.expectedError).map((f) => [f.name]))("%s", (name) => {
    it("ツリーと .meta が無いフォルダを表示する", async () => {
      const r = await runCli("analyze", `${name}.unitypackage`);
      expect(r).toMatchObject({ code: 0, stderr: "" });
      expect(r.stdout).toMatchSnapshot();
    });

    it("--json で AnalysisResult を出す", async () => {
      const r = await runCli("analyze", join(dir, `${name}.unitypackage`), "--json");
      expect(r.code).toBe(0);
      const parsed = AnalysisResult.parse(JSON.parse(r.stdout));
      expect(parsed.assets.length).toBeGreaterThan(0);
    });
  });

  it.each(fixtures.filter((f) => f.expectedError).map((f) => [f.name, f.expectedError]))(
    "異常系 %s は [%s] で止まり、何も出力しない",
    async (name, code) => {
      const r = await runCli("analyze", `${name}.unitypackage`);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`[${code}]`);
      expect(r.stderr).toMatchSnapshot();
    },
  );

  it("上限をオプションで変えられる", async () => {
    const r = await runCli("analyze", "simple.unitypackage", "--max-extracted", "1KiB");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[extracted-too-large]");
  });

  it("存在しないファイル", async () => {
    const r = await runCli("analyze", "nope.unitypackage");
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toContain("ENOENT");
  });

  it.each([[[]], [["unknown"]], [["analyze"]], [["analyze", "a", "b"]], [["analyze", "a", "--max-input", "lots"]], [["--nope"]]])(
    "引数の誤り %j は終了コード 2",
    async (argv) => {
      const r = await runCli(...argv);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
    },
  );

  it("--help", async () => {
    const r = await runCli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("vr-upm analyze <file>");
  });
});

describe("parseBytes", () => {
  it.each([
    ["1024", 1024],
    ["512KiB", 512 * 1024],
    ["64M", 64 * 1024 ** 2],
    ["4GiB", 4 * 1024 ** 3],
    ["1.5k", 1536],
    ["10b", 10],
  ])("%s", (text, bytes) => {
    expect(parseBytes(text)).toBe(bytes);
  });
});
