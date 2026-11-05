import { Link } from "react-router";
import { api } from "../api.js";
import { formatBytes, formatDateTime } from "../format.js";
import { useLoad } from "../hooks.js";

/** publish 済みのバージョン一覧(DESIGN.md 3.4: Verdaccio を失ったときの再 publish の手がかりにもなる) */
export function PublishedPage() {
  const { state } = useLoad(() => api.published(), []);
  const registry = useLoad(() => api.registry(), []).state;
  return (
    <>
      <h1>公開済み</h1>
      {registry.status === "ready" && (
        <p>
          publish 先: <code>{registry.data.url ?? "(未設定)"}</code>
        </p>
      )}
      {state.status === "loading" && <p>読み込み中…</p>}
      {state.status === "error" && (
        <p role="alert" className="error">
          {state.error.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.data.published.length === 0 ? (
          <p>まだ publish したバージョンはありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>パッケージ</th>
                <th>version</th>
                <th>publish 日時</th>
                <th>Build</th>
                <th className="num">サイズ</th>
                <th>integrity</th>
              </tr>
            </thead>
            <tbody>
              {state.data.published.map((b) => (
                <tr key={b.id}>
                  <td>{b.packageName}</td>
                  <td>{b.version}</td>
                  <td>{b.publishedAt ? formatDateTime(b.publishedAt) : "-"}</td>
                  <td>
                    <Link to={`/builds/${b.id}`}>#{b.id}</Link>
                  </td>
                  <td className="num">{b.tarballSize === null ? "-" : formatBytes(b.tarballSize)}</td>
                  <td>
                    <code>{b.tarballIntegrity ?? "-"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
