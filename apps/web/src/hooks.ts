import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export type Loadable<T> = { status: "loading" } | { status: "error"; error: Error } | { status: "ready"; data: T };

/** `load` の結果を state にする。`deps` が変わったら読み直す */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): { state: Loadable<T>; reload: () => void } {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  // reload() での読み直しは、表示を「読み込み中」に戻さずに差し替える(ポーリングでちらつかせない)
  const silent = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps は呼び出し側が指定する
  useEffect(() => {
    let cancelled = false;
    if (!silent.current) setState({ status: "loading" });
    silent.current = false;
    load().then(
      (data) => !cancelled && setState({ status: "ready", data }),
      (error: unknown) => !cancelled && setState({ status: "error", error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);
  const reload = useCallback(() => {
    silent.current = true;
    setNonce((n) => n + 1);
  }, []);
  return { state, reload };
}
