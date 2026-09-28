import 'server-only';
import { randomUUID } from 'node:crypto';
import { getRedis } from './cache';
import { env } from './env';
import { CREATIVES_MAX, worstCaseUsd, type StepName } from './models';
import type { SpendHook } from './types';

// Spend cap, per-client limiter, in-flight lock and run ledger (F20, F23). Money is kept in integer micro-dollars
// so the counter never drifts. Reservation is one server-side script: read, compare with the cap, increment only on
// success, so a refused reservation never touches the counter. Settlement adjusts to the actual cost afterwards.
// Two counters move together: the epoch total (the hard money ceiling) and today's (UTC) counter with its own cap, so a
// bad day (or reservations held by cancelled runs) pauses live runs until midnight rather than for good.

export interface SpendStore {
  /** Atomic: increment every key by `micro` only if each stays ≤ its cap. Keys after the first expire after ttlSec. */
  reserve(keys: string[], micro: number, capsMicro: number[], ttlSec: number): Promise<boolean>;
  /** Adjust the first key, and each later key only while it still exists (a settle after midnight leaves a new day alone). */
  adjust(keys: string[], deltaMicro: number): Promise<void>;
  get(key: string): Promise<number>;
  /** SET NX with TTL; true when acquired. */
  lock(key: string, token: string, ttlSec: number): Promise<boolean>;
  /** Delete only if the token still matches (a lock that expired and was re-taken is left alone). */
  unlock(key: string, token: string): Promise<void>;
  /** Fixed-window hit counter; returns the count including this hit and the seconds left in the window. */
  hit(key: string, windowSec: number): Promise<{ count: number; ttl: number }>;
  ledger(key: string, row: unknown): Promise<void>;
  ping(): Promise<boolean>;
}

// ---- Upstash (REST) ----

const RESERVE = `for i = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') + tonumber(ARGV[1]) > tonumber(ARGV[i + 2]) then return 0 end
end
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[1])
  if i > 1 then redis.call('EXPIRE', KEYS[i], ARGV[2]) end
end
return 1`;
const ADJUST = `redis.call('INCRBY', KEYS[1], ARGV[1])
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], ARGV[1]) end
end
return 1`;
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const HIT = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('TTL', KEYS[1])}`;

function upstashStore(): SpendStore | null {
  const r = getRedis();
  if (!r) return null;
  return {
    reserve: async (keys, micro, caps, ttl) => (await r.eval(RESERVE, keys, [String(micro), String(ttl), ...caps.map(String)])) === 1,
    adjust: async (keys, delta) => {
      if (delta !== 0) await r.eval(ADJUST, keys, [String(delta)]);
    },
    get: async (key) => Number((await r.get<number | string>(key)) ?? 0),
    lock: async (key, token, ttl) => (await r.set(key, token, { nx: true, ex: ttl })) === 'OK',
    unlock: async (key, token) => {
      await r.eval(UNLOCK, [key], [token]);
    },
    hit: async (key, windowSec) => {
      const [count, ttl] = (await r.eval(HIT, [key], [String(windowSec)])) as [number, number];
      return { count, ttl };
    },
    ledger: async (key, row) => {
      await r.lpush(key, JSON.stringify(row));
      await r.ltrim(key, 0, 999);
    },
    ping: async () => {
      await r.incr('health:probe');
      return true;
    },
  };
}

// ---- In-memory (local development only; never used on Vercel) ----

export function memoryStore(now: () => number = Date.now): SpendStore {
  const counters = new Map<string, number>();
  const locks = new Map<string, { token: string; until: number }>();
  const windows = new Map<string, { count: number; until: number }>();
  const ledgers = new Map<string, unknown[]>();
  return {
    reserve: async (keys, micro, caps) => {
      if (keys.some((k, i) => (counters.get(k) ?? 0) + micro > caps[i])) return false;
      for (const k of keys) counters.set(k, (counters.get(k) ?? 0) + micro);
      return true;
    },
    adjust: async (keys, delta) => {
      keys.forEach((k, i) => {
        if (i === 0 || counters.has(k)) counters.set(k, (counters.get(k) ?? 0) + delta);
      });
    },
    get: async (key) => counters.get(key) ?? 0,
    lock: async (key, token, ttl) => {
      const l = locks.get(key);
      if (l && l.until > now()) return false;
      locks.set(key, { token, until: now() + ttl * 1000 });
      return true;
    },
    unlock: async (key, token) => {
      if (locks.get(key)?.token === token) locks.delete(key);
    },
    hit: async (key, windowSec) => {
      const w = windows.get(key);
      const cur = w && w.until > now() ? w : { count: 0, until: now() + windowSec * 1000 };
      cur.count++;
      windows.set(key, cur);
      return { count: cur.count, ttl: Math.ceil((cur.until - now()) / 1000) };
    },
    ledger: async (key, row) => {
      ledgers.set(key, [row, ...(ledgers.get(key) ?? [])].slice(0, 1000));
    },
    ping: async () => true,
  };
}

let store: SpendStore | null | undefined;
let memory: SpendStore | null = null;
/** Upstash when configured; in-memory only off Vercel (fail closed on Vercel: null → live runs 503). */
export function spendStore(): SpendStore | null {
  if (store !== undefined) return store;
  store = upstashStore();
  if (!store && !env().isVercel) {
    console.warn('[spend] no Upstash env; using the in-memory store (local development only)');
    store = memory ??= memoryStore();
  }
  return store;
}
export function _setStoreForTests(s: SpendStore | null | undefined): void {
  store = s;
  healthy = null;
}

let healthy: { ok: boolean; at: number; rttMs: number } | null = null;
/** Round trip of the last health probe from this instance (the ledger records it). */
export const lastProbeRttMs = () => healthy?.rttMs ?? null;
const HEALTH_TTL_MS = 60_000;
/** A failed probe is retried soon: one blip must not refuse live runs on this instance for a full minute. */
const HEALTH_FAIL_TTL_MS = 5_000;
/** Startup increment probe, cached per instance. */
export async function storeHealthy(s: SpendStore | null = spendStore()): Promise<boolean> {
  if (!s) return false;
  if (healthy && Date.now() - healthy.at < (healthy.ok ? HEALTH_TTL_MS : HEALTH_FAIL_TTL_MS)) return healthy.ok;
  let ok = false;
  const t0 = Date.now();
  try {
    ok = await s.ping();
  } catch (e) {
    console.error('[spend] store probe failed', (e as Error).message);
  }
  healthy = { ok, at: Date.now(), rttMs: Date.now() - t0 };
  return ok;
}

// ---- Keys and money ----

export const toMicro = (usd: number) => Math.round(usd * 1_000_000);
export const spendKey = (epoch = env().spendEpoch) => `spend:${epoch}`;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const dailySpendKey = (now = Date.now(), epoch = env().spendEpoch) => `spend:${epoch}:${utcDay(now)}`;
export const ledgerKey = (epoch = env().spendEpoch) => `ledger:${epoch}`;
/** A day key outlives its day so a late settle still finds it. */
const DAILY_TTL_SEC = 2 * 86_400;
export function secondsToUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

/** Worst case for one live run: every call at its full cap (courtesy pre-check only; the real gate is per call). */
export function runWorstCaseUsd(): number {
  const once: StepName[] = ['understand', 'score_publishers'];
  const perCard: StepName[] = ['creative', 'critic', 'revise'];
  return once.reduce((n, s) => n + worstCaseUsd(s), 0) + 10 * worstCaseUsd('score_personas') + CREATIVES_MAX * perCard.reduce((n, s) => n + worstCaseUsd(s), 0);
}

/** The hook callLLM uses: reserve the step's worst case against both caps before the call, settle to the actual cost after. */
export function spendHook(
  s: SpendStore,
  opts: { key?: string; capUsd?: number; dailyCapUsd?: number; now?: () => number } = {},
): SpendHook & { reservedMicro: () => number } {
  const now = opts.now ?? Date.now;
  const key = opts.key ?? spendKey();
  const caps = [toMicro(opts.capUsd ?? env().spendCapUsd), toMicro(opts.dailyCapUsd ?? env().spendCapDailyUsd)];
  const reserved = new Map<string, { micro: number; keys: string[] }>();
  let total = 0;
  return {
    async reserve(estimateUsd) {
      const micro = Math.max(1, Math.ceil(estimateUsd * 1_000_000));
      // The day key is fixed at reservation time, so its settle adjusts the same day.
      const keys = [key, `${key}:${utcDay(now())}`];
      try {
        if (!(await s.reserve(keys, micro, caps, DAILY_TTL_SEC))) return { ok: false, reason: 'cap' };
      } catch (e) {
        console.error('[spend] reserve failed', (e as Error).message);
        return { ok: false, reason: 'store' };
      }
      const id = randomUUID();
      reserved.set(id, { micro, keys });
      total += micro;
      return { ok: true, id };
    },
    async settle(id, actualUsd) {
      const r = reserved.get(id);
      if (r === undefined) return;
      reserved.delete(id);
      const delta = toMicro(actualUsd) - r.micro;
      total += delta;
      try {
        await s.adjust(r.keys, delta);
      } catch (e) {
        console.error('[spend] settle failed; reservation stays on the counter', (e as Error).message);
      }
    },
    reservedMicro: () => total,
  };
}

// ---- Limiter identity ----

/**
 * Bucket for the limiter. On Vercel the platform sets x-real-ip / x-forwarded-for from the connection; a client-sent
 * chain is prefixed, so the last hop is the trustworthy one. IPv6 is bucketed by /64. Locally one constant bucket.
 */
export function clientBucket(headers: Headers, isVercel = env().isVercel): string {
  if (!isVercel) return 'local';
  const xff = headers.get('x-forwarded-for')?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
  const ip = headers.get('x-real-ip')?.trim() || xff.at(-1) || 'unknown';
  if (ip.includes(':')) return `v6:${ipv6Groups(ip).slice(0, 4).join(':')}`;
  return ip;
}

/** Eight 16-bit groups of an IPv6 address, '::' expanded and leading zeros dropped (so one /64 is one bucket). */
function ipv6Groups(ip: string): string[] {
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return groups.map((g) => (g.replace(/^0+(?=.)/, '') || '0').toLowerCase());
}
