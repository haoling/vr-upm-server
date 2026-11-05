const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/**
 * 解析時の上限(gzip bomb・巨大入力対策。DESIGN.md 8.2)。
 */
export interface AnalyzeLimits {
  /** 入力(gzip 圧縮済み)の最大バイト数 */
  maxInputBytes: number;
  /** 展開後(tar)の最大バイト数 */
  maxExtractedBytes: number;
  /**
   * 展開後 / 圧縮済み の比の上限。
   * 単色テクスチャなどで局所的に高くなることはあるので、`compressionRatioSlackBytes` までは許す。
   */
  maxCompressionRatio: number;
  /** 圧縮率の判定を始めるまでに許す展開後バイト数 */
  compressionRatioSlackBytes: number;
  /** tar の最大エントリ数(ディレクトリを含む) */
  maxEntries: number;
  /** `<guid>/pathname` の最大バイト数 */
  maxPathnameBytes: number;
  /** `<guid>/asset.meta` の最大バイト数(メモリに読み込むため) */
  maxMetaBytes: number;
}

export const DEFAULT_ANALYZE_LIMITS: Readonly<AnalyzeLimits> = Object.freeze({
  maxInputBytes: 4 * GiB,
  maxExtractedBytes: 16 * GiB,
  maxCompressionRatio: 100,
  compressionRatioSlackBytes: 128 * MiB,
  maxEntries: 400_000,
  maxPathnameBytes: 4 * KiB,
  maxMetaBytes: 16 * MiB,
});
