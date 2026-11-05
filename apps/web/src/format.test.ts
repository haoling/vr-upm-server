import { describe, expect, it } from "vitest";
import { formatBytes, formatDateTime } from "./format.js";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [150 * 1024, "150 KiB"],
    [5 * 1024 ** 3, "5.0 GiB"],
  ])("%d → %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe("formatDateTime", () => {
  it("不正な値はそのまま返す", () => {
    expect(formatDateTime("not a date")).toBe("not a date");
  });
  it("YYYY-MM-DD HH:mm にする", () => {
    expect(formatDateTime("2026-11-05T13:35:00Z")).toMatch(/^2026-11-0[56] \d\d:\d\d$/);
  });
});
