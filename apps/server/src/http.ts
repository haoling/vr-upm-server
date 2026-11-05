import type { ApiError } from "@vr-upm/shared";
import type { Context } from "hono";
import type { z } from "zod";

export type ErrorStatus = 400 | 404 | 409 | 413 | 422 | 500;

export const fail = (status: ErrorStatus, body: ApiError) => Response.json(body, { status });

/** `:id` パラメータを正の整数として読む。不正なら null */
export function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** JSON ボディを zod で検証する。失敗したら 400 の Response を返す */
export async function parseJsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S> | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(400, { error: "request body must be JSON", code: "invalid-request" });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return fail(400, { error: detail, code: "invalid-request" });
  }
  return parsed.data;
}
