/**
 * 解析を続けられない(または続けるべきでない)入力に対するエラー。
 *
 * これが投げられたら解析結果は作らず、中身もどこにも書き出さない(DESIGN.md 8.2)。
 */
export type UnitypackageErrorCode =
  /** 入力(圧縮済み)が上限を超えた */
  | "input-too-large"
  /** 展開後のサイズが上限を超えた */
  | "extracted-too-large"
  /** 圧縮率が異常に高い(gzip bomb の疑い) */
  | "compression-ratio-exceeded"
  /** tar のエントリ数が上限を超えた */
  | "too-many-entries"
  /** pathname や asset.meta が上限より大きい */
  | "entry-too-large"
  /** gzip / tar として読めない */
  | "corrupt-archive"
  /** パストラバーサルや絶対パス */
  | "unsafe-path"
  /** シンボリックリンク・ハードリンク・デバイスファイルなど */
  | "unsupported-entry-type";

export class UnitypackageAnalysisError extends Error {
  constructor(
    readonly code: UnitypackageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UnitypackageAnalysisError";
  }
}
