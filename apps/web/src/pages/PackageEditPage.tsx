import type { PackageDetail, UploadDetail } from "@vr-upm/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api.js";
import { SelectableTree } from "../components/SelectableTree.js";
import { useLoad } from "../hooks.js";
import {
  type PackageFormValues,
  changeRoot,
  configToForm,
  emptyForm,
  isFolderPath,
  suggestRoot,
  toggleExclude,
  validateForm,
} from "../packageForm.js";

/**
 * パッケージ設定の作成・編集(DESIGN.md 3.2)。
 * - `/uploads/:uploadId/packages/new`: Upload から新しく作る
 * - `/packages/:id?upload=<id>`: 既存の設定を編集して、選んだ Upload でビルドする
 */
export function PackageEditPage() {
  const { id, uploadId } = useParams();
  const [search, setSearch] = useSearchParams();
  const packageId = id === undefined ? null : Number(id);

  const pkg = useLoad(() => (packageId === null ? Promise.resolve(null) : api.package(packageId)), [packageId]);
  const uploads = useLoad(() => api.uploads(), []);

  // 使う Upload: 新規作成は URL、編集は ?upload= か、元ファイルのある最新の Upload
  const chosen =
    uploadId !== undefined
      ? Number(uploadId)
      : search.get("upload") !== null
        ? Number(search.get("upload"))
        : uploads.state.status === "ready"
          ? (uploads.state.data.uploads.find((u) => u.fileState === "stored" && u.fileCount !== null)?.id ?? null)
          : null;
  const upload = useLoad(() => (chosen === null ? Promise.resolve(null) : api.upload(chosen)), [chosen]);

  if (pkg.state.status === "loading" || uploads.state.status === "loading" || upload.state.status === "loading") return <p>読み込み中…</p>;
  for (const s of [pkg.state, uploads.state, upload.state]) {
    if (s.status === "error") {
      return (
        <p role="alert" className="error">
          {s.error.message}
        </p>
      );
    }
  }
  if (pkg.state.status !== "ready" || uploads.state.status !== "ready" || upload.state.status !== "ready") return null;

  return (
    <Editor
      key={`${packageId ?? "new"}-${chosen ?? "none"}`}
      pkg={pkg.state.data}
      upload={upload.state.data}
      uploadChoices={uploads.state.data.uploads}
      onPickUpload={uploadId === undefined ? (n) => setSearch({ upload: String(n) }) : undefined}
    />
  );
}

function initialValues(pkg: PackageDetail | null, upload: UploadDetail | null): PackageFormValues {
  if (pkg) return configToForm(pkg.config);
  const values = emptyForm();
  const root = upload?.analysis ? suggestRoot(upload.analysis.tree) : "";
  const last = root.split("/").pop() ?? "";
  return { ...values, rootPath: root, displayName: last };
}

function Editor({
  pkg,
  upload,
  uploadChoices,
  onPickUpload,
}: {
  pkg: PackageDetail | null;
  upload: UploadDetail | null;
  uploadChoices: { id: number; originalFilename: string; fileState: string }[];
  onPickUpload?: (id: number) => void;
}) {
  const navigate = useNavigate();
  const [values, setValues] = useState(() => initialValues(pkg, upload));
  const [excludeText, setExcludeText] = useState(values.exclude.join("\n"));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ツリーでの変更を、除外 glob のテキスト欄にも反映する
  useEffect(() => {
    setExcludeText(values.exclude.join("\n"));
  }, [values.exclude]);

  const set = (patch: Partial<PackageFormValues>) => {
    setNotice(null);
    setValues((v) => ({ ...v, ...patch }));
  };

  /** 検証して保存する。成功したら保存済みの Package を返す */
  const save = async (): Promise<PackageDetail | null> => {
    const result = validateForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return null;
    }
    setErrors([]);
    setSaving(true);
    try {
      const saved = pkg ? await api.updatePackage(pkg.id, { config: result.config }) : await api.createPackage({ config: result.config });
      setNotice("保存しました。");
      return saved;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    const saved = await save();
    if (saved && !pkg) navigate(`/packages/${saved.id}${upload ? `?upload=${upload.id}` : ""}`, { replace: true });
  };

  const onBuild = async () => {
    if (!upload) return;
    const saved = await save();
    if (!saved) return;
    setSaving(true);
    try {
      const build = await api.createBuild(saved.id, upload.id);
      navigate(`/builds/${build.id}`);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      setSaving(false);
    }
  };

  const analysis = upload?.analysis ?? null;
  const rootIsFolder = analysis ? isFolderPath(analysis.tree, values.rootPath) : false;
  return (
    <>
      <p>
        <Link to={pkg ? "/packages" : upload ? `/uploads/${upload.id}` : "/"}>← 戻る</Link>
      </p>
      <h1>{pkg ? `パッケージ設定: ${pkg.name}` : "パッケージ設定を作る"}</h1>

      <div className="form-grid">
        <label htmlFor="f-name">
          パッケージ名
          <div className="hint">例: com.haoling.booth.shop.item(作成後は変更不可)</div>
        </label>
        <input id="f-name" value={values.packageName} disabled={pkg !== null} onChange={(e) => set({ packageName: e.target.value })} />

        <label htmlFor="f-display">表示名</label>
        <input id="f-display" value={values.displayName} onChange={(e) => set({ displayName: e.target.value })} />

        <label htmlFor="f-version">
          version
          <div className="hint">semver(例: 1.0.0)</div>
        </label>
        <input id="f-version" value={values.version} onChange={(e) => set({ version: e.target.value })} />

        <label htmlFor="f-label">
          元の version 表記<div className="hint">BOOTH 側の表記(任意)</div>
        </label>
        <input id="f-label" value={values.sourceVersionLabel} onChange={(e) => set({ sourceVersionLabel: e.target.value })} />

        <label htmlFor="f-booth">BOOTH の URL</label>
        <input id="f-booth" value={values.boothUrl} onChange={(e) => set({ boothUrl: e.target.value })} />

        <label htmlFor="f-unity">
          Unity<div className="hint">例: 2022.3(任意)</div>
        </label>
        <input id="f-unity" value={values.unity} onChange={(e) => set({ unity: e.target.value })} />

        <label htmlFor="f-desc">説明</label>
        <input id="f-desc" value={values.description} onChange={(e) => set({ description: e.target.value })} />

        <label htmlFor="f-root">
          ルート<div className="hint">下のツリーで選べます</div>
        </label>
        <input id="f-root" value={values.rootPath} onChange={(e) => set(changeRoot(values, e.target.value))} />

        <label htmlFor="f-exclude">
          除外<div className="hint">ルートからの相対パスの glob(1 行に 1 つ)。ツリーのチェックも反映されます</div>
        </label>
        <textarea
          id="f-exclude"
          rows={4}
          value={excludeText}
          onChange={(e) => {
            setExcludeText(e.target.value);
            setNotice(null);
            setValues((v) => ({ ...v, exclude: e.target.value.split("\n") }));
          }}
        />
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="error">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={saving} onClick={onSave}>
          保存
        </button>
        <button type="button" className="primary" disabled={saving || !upload || upload.fileState !== "stored"} onClick={onBuild}>
          保存してビルド
        </button>
        {notice && <span role="status">{notice}</span>}
        {upload && upload.fileState !== "stored" && (
          <span className="error">元ファイルがありません。同じファイルを再アップロードしてください。</span>
        )}
      </div>

      <h2>元ファイル</h2>
      {onPickUpload ? (
        <p>
          <select value={upload?.id ?? ""} onChange={(e) => onPickUpload(Number(e.target.value))} aria-label="元ファイル">
            {!upload && <option value="">(選んでください)</option>}
            {uploadChoices.map((u) => (
              <option key={u.id} value={u.id}>
                {u.originalFilename}({u.fileState})
              </option>
            ))}
          </select>
        </p>
      ) : (
        upload && <p>{upload.originalFilename}</p>
      )}

      {analysis ? (
        <>
          {values.rootPath !== "" && !rootIsFolder && (
            <p role="alert" className="error">
              ルート {values.rootPath} は、この元ファイルにあるフォルダではありません。
            </p>
          )}
          <SelectableTree
            root={analysis.tree}
            rootPath={values.rootPath}
            exclude={values.exclude}
            onPickRoot={(path) => set(changeRoot(values, path))}
            onToggleExclude={(rel) => set({ exclude: toggleExclude(values.exclude, rel) })}
          />
        </>
      ) : (
        <p>元ファイルを選ぶと、ここにファイルツリーが出ます。</p>
      )}
    </>
  );
}
