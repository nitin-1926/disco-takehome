import 'server-only';
import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { committedCache, type CommittedEntry } from './data';
import { env } from './env';
import { normalizeInput } from './settings';
import type { CacheMode, Source } from './types';

// LLM-output cache. Read order: committed map -> Redis -> miss. Code-derived values are never cached.

export type CacheEntry = CommittedEntry;

const REDIS_TTL_SECONDS = 7 * 24 * 3600;
const REDIS_TIMEOUT_MS = 4_000;

/** JSON with object keys sorted at every level, so equal values always hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface KeyParts {
  module: string;
  promptVersion: string;
  instructionsHash: string;
  model: string;
  reasoning: string;
  schemaName: string;
  args: unknown;
}

/** Every value that can change the answer is in the key (keychain learning). */
export function cacheKey(parts: KeyParts): string {
  return sha256(canonicalJson(parts));
}

let redis: Redis | null | undefined;
export function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const { upstashUrl, upstashToken } = env();
  // Bounded: a stalled store must fail (and fall back or 503) rather than hold a run past its wall.
  redis = upstashUrl && upstashToken ? new Redis({ url: upstashUrl, token: upstashToken, signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS), retry: { retries: 2 } }) : null;
  return redis;
}

/** Test seam. */
export function _setRedisForTests(client: Redis | null | undefined): void {
  redis = client;
}

export function committedGet(key: string): CacheEntry | undefined {
  return committedCache.entries[key];
}

export function isCommittedInput(input: string): boolean {
  // Own keys only: "constructor" or "toString" must not pass as a committed sample.
  return Object.hasOwn(committedCache.inputs, normalizeInput(input));
}

export async function cacheGet(key: string, mode: CacheMode): Promise<{ entry: CacheEntry; source: Source } | null> {
  if (!mode.read) return null;
  const hit = committedGet(key);
  if (hit) return { entry: hit, source: 'committed' };
  // A replay-only run is a committed sample: it never reads Redis, so it costs the store nothing.
  if (mode.replayOnly) return null;
  const r = getRedis();
  if (!r) return null;
  try {
    const entry = await r.get<CacheEntry>(`llm:${key}`);
    return entry ? { entry, source: 'redis' } : null;
  } catch (e) {
    console.warn('[cache] redis read failed', (e as Error).message);
    return null;
  }
}

/** Entries produced during this process that the eval's --write-cache flushes into the committed map. */
export const pendingCommitted = new Map<string, CacheEntry>();

export async function redisSet(key: string, entry: CacheEntry): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(`llm:${key}`, entry, { ex: REDIS_TTL_SECONDS });
  } catch (e) {
    console.warn('[cache] redis write failed', (e as Error).message);
  }
}
