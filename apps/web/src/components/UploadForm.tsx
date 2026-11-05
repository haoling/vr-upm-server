import type { UploadCreateResponse } from "@vr-upm/shared";
import { useRef, useState } from "react";
import { uploadUnitypackage } from "../api.js";
import { formatBytes } from "../format.js";

type State =
  | { status: "idle" }
  | { status: "uploading"; loaded: number; total: number }
  | { status: "error"; message: string };

export function UploadForm({ onUploaded }: { onUploaded: (result: UploadCreateResponse) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ status: "idle" });
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setState({ status: "uploading", loaded: 0, total: file.size });
    try {
      const result = await uploadUnitypackage(file, (loaded, total) => setState({ status: "uploading", loaded, total }));
      setState({ status: "idle" });
      setFile(null);
      if (input.current) input.current.value = "";
      onUploaded(result);
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const uploading = state.status === "uploading";
  return (
    <form onSubmit={submit} className="upload-form">
      <label>
        unitypackage
        <input
          ref={input}
          type="file"
          accept=".unitypackage"
          disabled={uploading}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setState({ status: "idle" });
          }}
        />
      </label>
      <button type="submit" disabled={!file || uploading}>
        アップロード
      </button>
      {state.status === "uploading" && (
        <div className="progress">
          <progress value={state.loaded} max={state.total} />
          <span>
            {formatBytes(state.loaded)} / {formatBytes(state.total)}
            {state.loaded >= state.total && "(解析中…)"}
          </span>
        </div>
      )}
      {state.status === "error" && (
        <p role="alert" className="error">
          アップロードできませんでした: {state.message}
        </p>
      )}
    </form>
  );
}
