import type { HealthResponse, UploadSummary } from "@vr-upm/shared";
import { useEffect, useState } from "react";
import { api } from "./api.js";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [uploads, setUploads] = useState<UploadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.health(), api.uploads()])
      .then(([h, u]) => {
        setHealth(h);
        setUploads(u.uploads);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>
      <h1>VR UPM Server</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {health && (
        <p>
          server {health.version} (mode: {health.mode})
        </p>
      )}
      <h2>Uploads</h2>
      {uploads.length === 0 ? (
        <p>まだアップロードはありません。</p>
      ) : (
        <ul>
          {uploads.map((u) => (
            <li key={u.id}>
              {u.originalFilename} ({u.fileState})
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
