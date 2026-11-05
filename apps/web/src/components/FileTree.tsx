import type { FileTreeNode } from "@vr-upm/shared";
import { useState } from "react";
import { formatBytes } from "../format.js";

/** 子はフォルダを開いたときだけ描画する(巨大なツリーでも DOM を増やさない) */
function Node({ node, depth }: { node: FileTreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (node.kind === "file") {
    return (
      <li className="file">
        <span className="name">{node.name}</span>
        {node.size !== null && <span className="size">{formatBytes(node.size)}</span>}
      </li>
    );
  }
  return (
    <li className="folder">
      <button type="button" className="toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {node.name}/
      </button>
      {node.missingMeta && (
        <span className="badge warn" title="unitypackage にフォルダの .meta が入っていません。変換時に生成します">
          .meta なし
        </span>
      )}
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Node key={c.path} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree({ root }: { root: FileTreeNode }) {
  if (root.children.length === 0) return <p>ファイルがありません。</p>;
  return (
    <ul className="tree">
      {root.children.map((c) => (
        <Node key={c.path} node={c} depth={0} />
      ))}
    </ul>
  );
}
