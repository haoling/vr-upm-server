import { Link } from "react-router";
import { api } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatBytes, formatDateTime } from "../format.js";
import { useLoad } from "../hooks.js";

export function BuildsPage() {
  const { state } = useLoad(() => api.builds(), []);
  return (
    <>
      <h1>Build</h1>
      {state.status === "loading" && <p>読み込み中…</p>}
      {state.status === "error" && (
        <p role="alert" className="error">
          {state.error.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.data.builds.length === 0 ? (
          <p>まだビルドはありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>パッケージ</th>
                <th>version</th>
                <th>元ファイル</th>
                <th>状態</th>
                <th className="num">tarball</th>
                <th>作成日時</th>
              </tr>
            </thead>
            <tbody>
              {state.data.builds.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/builds/${b.id}`}>#{b.id}</Link>
                  </td>
                  <td>{b.packageName}</td>
                  <td>{b.version}</td>
                  <td>{b.uploadFilename}</td>
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="num">{b.tarballSize === null ? "-" : formatBytes(b.tarballSize)}</td>
                  <td>{formatDateTime(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
