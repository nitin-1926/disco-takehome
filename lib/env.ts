import 'server-only';

// Single import site for environment. Everything is parsed once, clamped, and logged when corrected.

const CATALOG_SIZE = 20;

function num(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}=${JSON.stringify(raw)} is not a number; using ${fallback}`);
    return fallback;
  }
  const lo = opts.min ?? -Infinity;
  const hi = opts.max ?? Infinity;
  if (n < lo || n > hi) {
    const clamped = Math.min(hi, Math.max(lo, n));
    console.warn(`[env] ${name}=${n} out of [${lo}, ${hi}]; clamped to ${clamped}`);
    return clamped;
  }
  return n;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env) {
  const prev = process.env;
  // Allow tests to pass a custom env object without mutating the real one.
  if (source !== process.env) process.env = source;
  try {
    return {
      openaiKey: process.env.OPENAI_API_KEY ?? '',
      isVercel: process.env.VERCEL === '1' || process.env.VERCEL === 'true',
      retrieveK: num('RETRIEVE_K', CATALOG_SIZE, { min: 3, max: CATALOG_SIZE }),
      spendCapUsd: num('SPEND_CAP_USD', 25, { min: 0 }),
      spendCapDailyUsd: num('SPEND_CAP_DAILY_USD', 10, { min: 0 }),
      spendEpoch: process.env.SPEND_CAP_EPOCH?.trim() || 'v1',
      rateLimitRuns: num('RATE_LIMIT_RUNS', 20, { min: 1 }),
      rateLimitWindowMin: num('RATE_LIMIT_WINDOW_MIN', 60, { min: 1 }),
      upstashUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '',
      upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '',
    };
  } finally {
    if (source !== prev) process.env = prev;
  }
}

export type Env = ReturnType<typeof readEnv>;

let cached: Env | null = null;
export function env(): Env {
  return (cached ??= readEnv());
}
