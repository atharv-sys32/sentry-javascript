import { GLOBAL_OBJ } from '@sentry/core';
import type { CloudflareClient, CloudflareOptions } from './client';

const GLOBAL_CLIENT_CACHE_KEY = '__SENTRY_CLOUDFLARE_CLIENTS__' as const;

/**
 * Upper bound on cached clients per isolate.
 *
 * Entries are keyed by DSN plus an options fingerprint, so a worker that passes options
 * containing a per-invocation value (a request id in `initialScope`, say) would otherwise
 * add an entry per request and never release one. At the cap the oldest entry is dropped,
 * which degrades to the uncached behavior of building a client per invocation instead of
 * growing without bound.
 */
const MAX_CACHED_CLIENTS = 10;

/**
 * The global client cache. Lives on globalThis so a cached client survives across
 * invocations within the same isolate.
 *
 * Keyed by DSN *and* an options fingerprint: a later `init()` with materially different
 * options must not receive a client configured for a different setup, and two configs
 * sharing a DSN in one isolate should be able to coexist rather than evict each other.
 */
export function getGlobalClientCache(): Map<string, CloudflareClient> {
  const globalObj = GLOBAL_OBJ as typeof GLOBAL_OBJ & {
    [GLOBAL_CLIENT_CACHE_KEY]?: Map<string, CloudflareClient>;
  };
  if (!globalObj[GLOBAL_CLIENT_CACHE_KEY]) {
    globalObj[GLOBAL_CLIENT_CACHE_KEY] = new Map();
  }
  return globalObj[GLOBAL_CLIENT_CACHE_KEY];
}

/**
 * Produces a stable fingerprint for the user-supplied options, or `undefined` if they
 * can't be fingerprinted — in which case the caller must skip the cache rather than risk
 * handing back a client built for a different config.
 *
 * `init()` captures this before it resolves defaults, so only what the caller passed is
 * reflected; resolved default integrations (function-valued and rebuilt per call) never
 * leak in.
 *
 * Functions are dropped, so two calls passing semantically identical options with fresh
 * closures share a client. The tradeoff is that options differing *only* in a function
 * (`beforeSend`, `tracesSampler`, a custom `transport`) are indistinguishable and will
 * share a client too; pass a distinct DSN if you need them kept apart.
 */
export function fingerprintOptions(options: CloudflareOptions): string | undefined {
  // `ctx` is per-invocation by definition and is stripped from options before the client
  // is built, so it must not take part in the fingerprint.
  const { ctx: _ctx, ...rest } = options;

  // Cycles are reachable from plausible options (`initialScope` holding a Scope, whose
  // client's options point back at it), and `JSON.stringify` throws on those. Track
  // visited objects so a cycle becomes a marker instead of an exception.
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(rest, (_key, value) => {
      if (typeof value === 'function') {
        return undefined;
      }
      if (value instanceof RegExp) {
        // Would otherwise serialize to `{}`, making every regex look alike — so two
        // different `durableObjectSqlSpanAllowlist` patterns would share a client.
        return `[RegExp ${value.source}/${value.flags}]`;
      }
      if (typeof value === 'bigint') {
        return `[BigInt ${value.toString()}]`;
      }
      if (typeof value !== 'object' || value === null) {
        return value;
      }
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
      if (Array.isArray(value)) {
        return value;
      }
      // Sort keys so options that differ only in property order fingerprint the same.
      // Without this, a caller building options conditionally could alternate orders and
      // evict its own cache entry on every invocation.
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          sorted[key] = (value as Record<string, unknown>)[key];
          return sorted;
        }, {});
    });
  } catch {
    return undefined;
  }
}

function cacheKey(dsn: string, optionsFingerprint: string): string {
  return `${dsn}|${optionsFingerprint}`;
}

/**
 * Looks up a cached client for the given DSN and options fingerprint.
 */
export function getCachedClient(dsn: string, optionsFingerprint: string): CloudflareClient | undefined {
  return getGlobalClientCache().get(cacheKey(dsn, optionsFingerprint));
}

/**
 * Stores a client in the global cache, keyed by DSN and the user-supplied options
 * fingerprint that produced it.
 */
export function cacheClient(dsn: string, optionsFingerprint: string, client: CloudflareClient): void {
  const cache = getGlobalClientCache();
  const key = cacheKey(dsn, optionsFingerprint);

  // Re-inserting moves the key to the end, so eviction below drops the least recently
  // stored entry rather than this one.
  cache.delete(key);
  cache.set(key, client);

  while (cache.size > MAX_CACHED_CLIENTS) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
}

/**
 * @hidden Only for testing - clears the global client cache.
 * This ensures tests that use different DSNs/options don't interfere with each other.
 */
export function _clearGlobalClientCache(): void {
  getGlobalClientCache().clear();
}
