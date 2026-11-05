import type { BuildDetail } from "@vr-upm/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiRequestError, api } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatBytes, formatDateTime } from "../format.js";
import { useLoad } from "../hooks.js";

const ORIGIN_LABELS = { asset: "アセット", meta: ".meta", "generated-meta": ".meta(生成)", package: "package.json" } as const;

export function BuildDetailPage() {
  const { id } = useParams();
  const { state, reload } = useLoad(() => api.build(Number(id)), [id]);

  // 待機中・ビルド中は結果が出るまで読み直す
  const active = state.status === "ready" && (state.data.status === "queued" || state.data.status === "building");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [active, reload]);

  return (
    <>
      <p>
        <Link to="/builds">← Build 一覧</Link>
      </p>
      {state.status === "loading" && <p>読み込み中…</p>}
      {state.status === "error" && (
        <p role="alert" className="error">
          {state.error instanceof ApiRequestError && state.error.status === 404 ? "Build が見つかりません。" : state.error.message}
        </p>
      )}
      {state.status === "ready" && <Detail build={state.data} />}
    </>
  );
}

function Detail({ build }: { build: BuildDetail }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discard = async () => {
    try {
      await api.discardBuild(build.id);
      navigate("/builds");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirming(false);
    }
  };

  const { dryRun } = build;
  const canDiscard = build.status !== "building" && build.status !== "published";
  return (
    <>
      <h1>
        Build #{build.id} <StatusBadge status={build.status} />
      </h1>
      <dl className="meta">
        <dt>パッケージ</dt>
        <dd>
          <Link to={`/packages/${build.packageId}`}>{build.packageName}</Link> {build.version}
          {build.sourceVersionLabel ? `(元の表記: ${build.sourceVersionLabel})` : ""}
        </dd>
        <dt>元ファイル</dt>
        <dd>
          <Link to={`/uploads/${build.uploadId}`}>{build.uploadFilename}</Link>
        </dd>
        <dt>作成日時</dt>
        <dd>{formatDateTime(build.createdAt)}</dd>
        {build.tarballIntegrity && (
          <>
            <dt>tarball</dt>
            <dd>
              {build.tarballSize !== null && `${formatBytes(build.tarballSize)} / `}
              <code>{build.tarballIntegrity}</code>
            </dd>
          </>
        )}
      </dl>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {canDiscard && (
        <div className="actions">
          {confirming ? (
            <>
              <span>この Build を破棄しますか?(tarball も消えます)</span>
              <button type="button" className="danger" onClick={discard}>
                破棄する
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                やめる
              </button>
            </>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirming(true)}>
              この Build を破棄
            </button>
          )}
        </div>
      )}

      {build.status === "failed" && build.log.includes("再アップロード") && (
        <p role="alert" className="error">
          元ファイルがありません。<Link to="/">Upload</Link> から同じファイルをもう一度アップロードすると、元の Upload に戻ってビルドし直せます。
        </p>
      )}

      {dryRun && (
        <>
          <h2>dry-run(tarball に入るもの)</h2>
          <p>
            {dryRun.files.length} ファイル・合計 {formatBytes(dryRun.totalSize)}・除外 {dryRun.excluded.length} 件・ルート外のためスキップ{" "}
            {dryRun.outsideRootCount} 件
          </p>
          {(dryRun.errors.length > 0 || dryRun.warnings.length > 0) && (
            <ul className="issues">
              {dryRun.errors.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ内容が並ぶことがある
                <li key={`e${i}`} className="error">
                  <strong>[{e.code}]</strong> {e.message}
                </li>
              ))}
              {dryRun.warnings.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ内容が並ぶことがある
                <li key={`w${i}`} className="warning">
                  <strong>[{w.code}]</strong> {w.message}
                </li>
              ))}
            </ul>
          )}
          <table>
            <thead>
              <tr>
                <th>パス</th>
                <th>種別</th>
                <th className="num">サイズ</th>
              </tr>
            </thead>
            <tbody>
              {dryRun.files.map((f) => (
                <tr key={f.path}>
                  <td>
                    <code>{f.path}</code>
                  </td>
                  <td>{ORIGIN_LABELS[f.origin]}</td>
                  <td className="num">{formatBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {dryRun.excluded.length > 0 && (
            <details>
              <summary>除外したパス({dryRun.excluded.length} 件)</summary>
              <ul>
                {dryRun.excluded.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <h2>ログ</h2>
      {build.log === "" ? <p>まだありません。</p> : <pre className="log">{build.log}</pre>}

      <details>
        <summary>ビルド時の設定(スナップショット)</summary>
        <pre className="log">{JSON.stringify(build.config, null, 2)}</pre>
      </details>
    </>
  );
}
