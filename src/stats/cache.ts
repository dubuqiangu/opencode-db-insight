/**
 * Process-local result cache with a 60s TTL (DESIGN.md §10 / tasks.md T1.4).
 * Full-table aggregation over session_message can take hundreds of ms, so
 * the M2 API layer wraps each query in this cache. Key = function name +
 * JSON-serialized parameters.
 */

/** Default TTL per DESIGN.md §10. */
export const DEFAULT_CACHE_TTL_MS = 60_000

/**
 * Hard cap on stored entries (P1-6): without one, a hostile or chatty
 * caller could grow the process-local cache without bound (e.g. via
 * unlimited distinct ?days= / limit / offset combinations). Oldest entry
 * (Map insertion order) is evicted once the cap is reached.
 */
export const MAX_CACHE_ENTRIES = 64

interface CacheEntry {
  value: unknown
  expiresAtEpochMs: number
}

const entriesByCacheKey = new Map<string, CacheEntry>()

/** Build a cache key from the query function name and its arguments. */
export function buildCacheKey(functionName: string, parameters: unknown[]): string {
  return `${functionName}:${JSON.stringify(parameters)}`
}

/** Drop the oldest stored entry (Map insertion order = oldest first). */
function evictOldestCacheEntry(): void {
  const oldestCacheKey = entriesByCacheKey.keys().next().value
  if (oldestCacheKey !== undefined) entriesByCacheKey.delete(oldestCacheKey)
}

/**
 * Return the cached result for `cacheKey` when it exists and has not
 * expired; otherwise call `compute`, store and return its result.
 * Expired entries are overwritten by the fresh computation, and the store
 * never exceeds MAX_CACHE_ENTRIES (oldest evicted first).
 */
export function cachedResult<T>(cacheKey: string, compute: () => T, ttlMs: number = DEFAULT_CACHE_TTL_MS): T {
  const nowEpochMs = Date.now()
  const entry = entriesByCacheKey.get(cacheKey)
  if (entry !== undefined && entry.expiresAtEpochMs > nowEpochMs) {
    return entry.value as T
  }
  const value = compute()
  if (!entriesByCacheKey.has(cacheKey) && entriesByCacheKey.size >= MAX_CACHE_ENTRIES) {
    evictOldestCacheEntry()
  }
  entriesByCacheKey.set(cacheKey, { value, expiresAtEpochMs: nowEpochMs + ttlMs })
  return value
}

/** Drop every cached entry (used by tests and by a future "refresh" command). */
export function clearResultCache(): void {
  entriesByCacheKey.clear()
}

/** Number of stored entries, fresh or expired (diagnostics/tests). */
export function resultCacheSize(): number {
  return entriesByCacheKey.size
}
