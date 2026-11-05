import { HealthResponse, UploadListResponse } from "@vr-upm/shared";
import type { z } from "zod";

async function getJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return schema.parse(await res.json());
}

export const api = {
  health: () => getJson("/api/health", HealthResponse),
  uploads: () => getJson("/api/uploads", UploadListResponse),
};
