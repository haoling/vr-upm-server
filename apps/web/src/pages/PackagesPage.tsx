import { Link } from "react-router";
import { api } from "../api.js";
import { formatDateTime } from "../format.js";
import { useLoad } from "../hooks.js";

export function PackagesPage() {
  const { state } = useLoad(() => api.packages(), []);
  return (
    <>
      <h1>Package</h1>
      <p>
        パッケージ設定は <Link to="/">Upload</Link> の詳細から作ります。
      </p>
      {state.status === "loading" && <p>読み込み中…</p>}
      {state.status === "error" && (
        <p role="alert" className="error">
          {state.error.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.data.packages.length === 0 ? (
          <p>まだパッケージ設定はありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>パッケージ名</th>
                <th>表示名</th>
                <th>version</th>
                <th>作成日時</th>
              </tr>
            </thead>
            <tbody>
              {state.data.packages.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/packages/${p.id}`}>{p.name}</Link>
                  </td>
                  <td>{p.displayName}</td>
                  <td>{p.version}</td>
                  <td>{formatDateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
