import type { UploadCreateResponse } from "@vr-upm/shared";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.js";
import { UploadForm } from "../components/UploadForm.js";
import { formatBytes, formatDateTime } from "../format.js";
import { useLoad } from "../hooks.js";

export function UploadsPage() {
  const { state, reload } = useLoad(() => api.uploads(), []);
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);

  const onUploaded = (result: UploadCreateResponse) => {
    if (result.created) {
      navigate(`/uploads/${result.upload.id}`);
      return;
    }
    // 同じファイルは既存の Upload に紐付く
    setNotice(
      `${result.upload.originalFilename} は登録済みです${result.restored ? "(元ファイルを戻しました)" : ""}。`,
    );
    reload();
  };

  return (
    <>
      <h1>Upload</h1>
      <UploadForm onUploaded={onUploaded} />
      {notice && <p role="status">{notice}</p>}
      {state.status === "loading" && <p>読み込み中…</p>}
      {state.status === "error" && (
        <p role="alert" className="error">
          {state.error.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.data.uploads.length === 0 ? (
          <p>まだアップロードはありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ファイル名</th>
                <th>サイズ</th>
                <th>ファイル数</th>
                <th>警告</th>
                <th>状態</th>
                <th>アップロード日時</th>
              </tr>
            </thead>
            <tbody>
              {state.data.uploads.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link to={`/uploads/${u.id}`}>{u.originalFilename}</Link>
                  </td>
                  <td>{formatBytes(u.size)}</td>
                  <td>{u.fileCount ?? "-"}</td>
                  <td>{u.issueCount ?? "-"}</td>
                  <td>{u.fileState}</td>
                  <td>{formatDateTime(u.uploadedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
