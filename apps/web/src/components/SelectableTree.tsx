import type { FileTreeNode } from "@vr-upm/shared";
import { useState } from "react";
import { formatBytes } from "../format.js";
import { exclusionState, relativeTo } from "../packageForm.js";

interface Props {
  root: FileTreeNode;
  /** 選択中のパッケージルート(未選択なら空文字) */
  rootPath: string;
  exclude: readonly string[];
  onPickRoot: (path: string) => void;
  onToggleExclude: (relativePath: string) => void;
}

function Node({ node, depth, ...props }: Props & { node: FileTreeNode; depth: number }) {
  const { rootPath, exclude, onPickRoot, onToggleExclude } = props;
  // ルートまでの道すじは開いておく
  const onRootPath = rootPath !== "" && (node.path === rootPath || rootPath.startsWith(`${node.path}/`));
  const [open, setOpen] = useState(depth < 2 || onRootPath);

  const rel = relativeTo(rootPath, node.path);
  const inside = rootPath !== "" && rel !== null && rel !== "";
  const state = inside ? exclusionState(exclude, rel) : null;
  const isRoot = rootPath !== "" && node.path === rootPath;
  const classes = [node.kind, inside || isRoot || onRootPath ? "" : rootPath !== "" ? "outside" : "", state ? "excluded" : ""]
    .filter(Boolean)
    .join(" ");

  const excludeBox = inside && (
    <label className="exclude">
      <input
        type="checkbox"
        checked={state !== null}
        disabled={state === "inherited"}
        onChange={() => onToggleExclude(rel)}
      />{" "}
      除外{state === "inherited" ? "(親フォルダごと)" : ""}
    </label>
  );

  if (node.kind === "file") {
    return (
      <li className={classes}>
        <span className="name">{node.name}</span>
        {node.size !== null && <span className="size">{formatBytes(node.size)}</span>}
        {excludeBox}
      </li>
    );
  }
  return (
    <li className={classes}>
      <button type="button" className="toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {node.name}/
      </button>
      {isRoot ? (
        <span className="root-mark">パッケージのルート</span>
      ) : (
        <button type="button" className="pick" onClick={() => onPickRoot(node.path)}>
          ルートにする
        </button>
      )}
      {excludeBox}
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Node key={c.path} node={c} depth={depth + 1} {...props} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** ファイルツリー上で、パッケージのルートと除外するファイル・フォルダを選ぶ */
export function SelectableTree(props: Props) {
  if (props.root.children.length === 0) return <p>ファイルがありません。</p>;
  return (
    <ul className="tree">
      {props.root.children.map((c) => (
        <Node key={c.path} node={c} depth={0} {...props} />
      ))}
    </ul>
  );
}
