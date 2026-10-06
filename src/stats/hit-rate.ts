/**
 * Token accounting and cache hit-rate formulas (DESIGN.md §5 口径).
 * Pure functions, zero IO.
 */

/**
 * Cache hit rate, usage-meter compatible: cacheRead / (cacheRead + input).
 * Returns 0 when the denominator is 0 (no usage at all — never NaN/Infinity).
 */
export function hitRate(cacheRead: number, input: number): number {
  const denominator = cacheRead + input
  if (denominator <= 0) return 0
  return cacheRead / denominator
}

/**
 * Strict hit rate including cache writes:
 * cacheRead / (cacheRead + input + cacheWrite).
 * Returns 0 when the denominator is 0.
 */
export function strictHitRate(cacheRead: number, input: number, cacheWrite: number): number {
  const denominator = cacheRead + input + cacheWrite
  if (denominator <= 0) return 0
  return cacheRead / denominator
}

/**
 * "Total usage" per DESIGN §5: Σ input + output + cache.read.
 * Cache writes and reasoning tokens are deliberately excluded (reasoning is
 * part of output billing; cache writes are a storage cost, not consumption).
 * Structural parameter: any {input, output, cacheRead} satisfies it, so the
 * lightweight SQL-side samples (P0-1) share the same formula.
 */
export function totalUsageTokens(tokens: { input: number; output: number; cacheRead: number }): number {
  return tokens.input + tokens.output + tokens.cacheRead
}
