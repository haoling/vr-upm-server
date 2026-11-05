import {
  ApiError,
  BuildDetail,
  BuildListResponse,
  HealthResponse,
  PackageDetail,
  PackageListResponse,
  type PackageSaveRequest,
  UploadCreateResponse,
  UploadDetail,
  UploadListResponse,
} from "@vr-upm/shared";
import type { z } from "zod";

/** API が返したエラー(`code` は {@link ApiError} の code) */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ApiError["code"],
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** エラー応答の本文から ApiRequestError を作る。API の形でなければ HTTP ステータスだけを使う */
export function toApiRequestError(status: number, bodyText: string): ApiRequestError {
  try {
    const parsed = ApiError.safeParse(JSON.parse(bodyText));
    if (parsed.success) return new ApiRequestError(parsed.data.error, status, parsed.data.code);
  } catch {
    // JSON ではない(プロキシのエラーページなど)
  }
  return new ApiRequestError(`HTTP ${status}`, status);
}

async function getJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw toApiRequestError(res.status, await res.text());
  return schema.parse(await res.json());
}

async function sendJson<S extends z.ZodType>(method: string, path: string, body: unknown, schema: S): Promise<z.infer<S>> {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw toApiRequestError(res.status, await res.text());
  return schema.parse(await res.json());
}

/**
 * unitypackage をボディにそのまま入れて送る(multipart ではない)。
 * fetch ではアップロードの進捗が取れないので XMLHttpRequest を使う。
 */
export function uploadUnitypackage(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<UploadCreateResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/uploads?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(toApiRequestError(xhr.status, xhr.responseText));
        return;
      }
      try {
        resolve(UploadCreateResponse.parse(JSON.parse(xhr.responseText)));
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error("ネットワークエラーでアップロードできませんでした"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export const api = {
  health: () => getJson("/api/health", HealthResponse),
  uploads: () => getJson("/api/uploads", UploadListResponse),
  upload: (id: number) => getJson(`/api/uploads/${id}`, UploadDetail),
  packages: () => getJson("/api/packages", PackageListResponse),
  package: (id: number) => getJson(`/api/packages/${id}`, PackageDetail),
  createPackage: (body: PackageSaveRequest) => sendJson("POST", "/api/packages", body, PackageDetail),
  updatePackage: (id: number, body: PackageSaveRequest) => sendJson("PUT", `/api/packages/${id}`, body, PackageDetail),
  builds: () => getJson("/api/builds", BuildListResponse),
  build: (id: number) => getJson(`/api/builds/${id}`, BuildDetail),
  createBuild: (packageId: number, uploadId: number) => sendJson("POST", "/api/builds", { packageId, uploadId }, BuildDetail),
  discardBuild: async (id: number): Promise<void> => {
    const res = await fetch(`/api/builds/${id}`, { method: "DELETE" });
    if (!res.ok) throw toApiRequestError(res.status, await res.text());
  },
};
