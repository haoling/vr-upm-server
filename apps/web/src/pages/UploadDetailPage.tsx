import { Link, useParams } from "react-router";
import { ApiRequestError, api } from "../api.js";
import { FileTree } from "../components/FileTree.js";
import { formatBytes, formatDateTime } from "../format.js";
import { useLoad } from "../hooks.js";

export function UploadDetailPage() {
  const { id } = useParams();
  const { state } = useLoad(() => api.upload(Number(id)), [id]);

  return (
    <>
      <p>
        <Link to="/">← Upload 一覧</Link>
      </p>
      {state.status === "loading" && <p>読み込み中…</p>}
      {state.status === "error" && (
        <p role="alert" className="error">
          {state.error instanceof ApiRequestError && state.error.status === 404
            ? "Upload が見つかりません。"
            : state.error.message}
        </p>
      )}
      {state.status === "ready" && <Detail upload={state.data} />}
    </>
  );
}

function Detail({ upload }: { upload: import("@vr-upm/shared").UploadDetail }) {
  const { analysis } = upload;
  return (
    <>
      <h1>{upload.originalFilename}</h1>
      <dl className="meta">
        <dt>サイズ</dt>
        <dd>{formatBytes(upload.size)}</dd>
        <dt>sha256</dt>
        <dd>
          <code>{upload.sha256}</code>
        </dd>
        <dt>状態</dt>
        <dd>{upload.fileState}</dd>
        <dt>アップロード日時</dt>
        <dd>{formatDateTime(upload.uploadedAt)}</dd>
        {analysis && (
          <>
            <dt>内容</dt>
            <dd>
              ファイル {analysis.stats.fileCount} 件・フォルダ {analysis.stats.folderCount} 件・展開後{" "}
              {formatBytes(analysis.stats.totalAssetBytes)}
            </dd>
          </>
        )}
      </dl>

      {analysis && (
        <p>
          <Link to={`/uploads/${upload.id}/packages/new`} className="button">
            このファイルからパッケージ設定を作る
          </Link>
        </p>
      )}

      {!analysis ? (
        <p role="alert" className="error">
          解析結果がありません(保存された形式が古いか、解析されていません)。
        </p>
      ) : (
        <>
          <h2>警告</h2>
          {analysis.issues.length === 0 && analysis.missingFolderMetas.length === 0 ? (
            <p>問題は見つかりませんでした。</p>
          ) : (
            <ul className="issues">
              {analysis.missingFolderMetas.length > 0 && (
                <li className="warning">
                  <strong>フォルダの .meta が欠けています({analysis.missingFolderMetas.length} 件)</strong>
                  <span> 変換時に決定的な GUID で生成します。</span>
                  <details>
                    <summary>一覧</summary>
                    <ul>
                      {analysis.missingFolderMetas.map((p) => (
                        <li key={p}>
                          <code>{p}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              )}
              {analysis.issues.map((issue, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ内容の issue が並ぶことがある
                <li key={i} className={issue.severity}>
                  <strong>[{issue.code}]</strong> {issue.message}
                  {issue.pathname && (
                    <>
                      {" "}
                      <code>{issue.pathname}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h2>ファイルツリー</h2>
          <FileTree root={analysis.tree} />
        </>
      )}
    </>
  );
}
