import { describe, expect, it } from "vitest";
import { toApiRequestError } from "./api.js";

describe("toApiRequestError", () => {
  it("API のエラー本文からメッセージと code を取る", () => {
    const err = toApiRequestError(422, JSON.stringify({ error: "not a valid unitypackage", code: "invalid-unitypackage" }));
    expect(err).toMatchObject({ message: "not a valid unitypackage", status: 422, code: "invalid-unitypackage" });
  });

  it("JSON ではない本文は HTTP ステータスだけにする", () => {
    const err = toApiRequestError(502, "<html>Bad Gateway</html>");
    expect(err).toMatchObject({ message: "HTTP 502", status: 502, code: undefined });
  });
});
