import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunContext } from '@/lib/types';

// The HTTP surface with the pipeline mocked: gates, replay vs live, spend reserve/settle, lock release, abort, ledger.

const h = vi.hoisted(() => ({
  env: {
    openaiKey: 'sk-test',
    isVercel: false,
    retrieveK: 20,
    spendCapUsd: 25,
    spendCapDailyUsd: 10,
    spendEpoch: 'test',
    rateLimitRuns: 20,
    rateLimitWindowMin: 60,
    upstashUrl: '',
    upstashToken: '',
  },
  after: [] as Array<() => Promise<void>>,
  impl: null as null | ((input: string, settings: unknown, ctx: RunContext) => Promise<unknown>),
}));

vi.mock('@/lib/env', () => ({ env: () => h.env, readEnv: () => h.env }));
vi.mock('next/server', () => ({ after: (cb: () => Promise<void>) => h.after.push(cb) }));
vi.mock('@/lib/pipeline', () => ({ RUN_WALL_MS: 29_000, runPipeline: (i: string, s: unknown, c: RunContext) => h.impl!(i, s, c) }));
vi.mock('@/lib/cache', async (orig) => ({ ...(await orig<typeof import('@/lib/cache')>()), isCommittedInput: (i: string) => i === 'Sample input.' }));

const { POST } = await import('@/app/api/run/route');
const spend = await import('@/lib/spend');

let store: ReturnType<typeof spend.memoryStore>;
let touched: string[];

function spyStore() {
  const s = spend.memoryStore();
  touched = [];
  return new Proxy(s, {
    get(target, prop: string) {
      const v = target[prop as keyof typeof target];
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        touched.push(prop);
        return (v as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as typeof s;
}

const defaultImpl = async (_i: string, _s: unknown, ctx: RunContext) => {
  ctx.sink({ type: 'stage', stage: 'understand', status: 'started' });
  if (ctx.spend) {
    const r = await ctx.spend.reserve(0.05);
    if (r.ok) ctx.defer(() => ctx.spend!.settle(r.id, 0.01));
  }
  const summary = { run_id: ctx.run_id, cost_live_usd: ctx.spend ? 0.01 : 0, cost_replayed_usd: 0, calls: [], total_ms: 1, cold: false, skipped: [], errors: [] };
  ctx.sink({ type: 'done', summary });
  return { summary };
};

function req(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

async function drainAfter() {
  while (h.after.length) await h.after.shift()!();
}

beforeEach(() => {
  Object.assign(h.env, { openaiKey: 'sk-test', isVercel: false, spendCapUsd: 25, spendCapDailyUsd: 10, rateLimitRuns: 20 });
  h.after.length = 0;
  h.impl = defaultImpl;
  store = spyStore();
  spend._setStoreForTests(store);
});

describe('POST /api/run', () => {
  test('committed sample with canonical settings → replay-only stream, store never touched', async () => {
    let mode: RunContext['cacheMode'] | null = null;
    h.impl = async (i, s, ctx) => {
      mode = ctx.cacheMode;
      return defaultImpl(i, s, ctx);
    };
    const res = await POST(req({ input: 'Sample input.' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text.startsWith(':')).toBe(true); // padding first
    expect(text).toMatch(/id: 1\nevent: stage/);
    expect(text).toMatch(/event: done/);
    await drainAfter();
    expect(mode).toEqual({ read: true, replayOnly: true, writeCommitted: false });
    expect(touched).toEqual([]);
  });

  test('live run → reserve then settle to the actual cost, lock released, ledger row written', async () => {
    const res = await POST(req({ input: 'We sell handmade mugs.' }));
    expect(res.status).toBe(200);
    await res.text();
    await drainAfter();
    expect(await store.get('spend:test')).toBe(spend.toMicro(0.01));
    expect(await store.lock('inflight:local', 'next', 60)).toBe(true);
    expect(touched).toContain('ledger');
  });

  test('committed input with a changed offer is live and gated', async () => {
    const res = await POST(req({ input: 'Sample input.', settings: { offer: { type: 'pct_off', amount: 10 } } }));
    await res.text();
    expect(touched).toContain('hit');
  });

  test.each([
    ['input over 500 chars', { input: 'x'.repeat(501) }],
    ['budget not a number', { input: 'We sell mugs.', settings: { budgetUsd: 'abc' } }],
    ['unknown key', { input: 'We sell mugs.', extra: 1 }],
    ['empty input', { input: '   ' }],
  ])('%s → 400 JSON before any stream', async (_n, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_request');
    expect(touched).toEqual([]);
  });

  test('invalid JSON → 400', async () => {
    expect((await POST(req('{nope'))).status).toBe(400);
  });

  test('cross-site fetch metadata or missing origin → 403; non-JSON → 415; oversized → 413', async () => {
    expect((await POST(req({ input: 'x' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    const noMeta = new Request('http://localhost/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"x"}' });
    expect((await POST(noMeta)).status).toBe(403);
    const sameHost = new Request('http://localhost/api/run', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, body: '{"input":"We sell mugs."}' });
    expect((await POST(sameHost)).status).toBe(200);
    expect((await POST(req({ input: 'x' }, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await POST(req({ input: 'x' }, { 'content-length': '100000' }))).status).toBe(413);
  });

  test('cap headroom insufficient → 429 spend_cap, lock released', async () => {
    h.env.spendCapUsd = 0.05;
    const res = await POST(req({ input: 'We sell mugs.' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('spend_cap');
    expect(await store.lock('inflight:local', 'next', 60)).toBe(true);
  });

  test('over the window → 429 rate_limited with retry-after', async () => {
    h.env.rateLimitRuns = 1;
    await (await POST(req({ input: 'We sell mugs.' }))).text();
    await drainAfter();
    const res = await POST(req({ input: 'We sell mugs.' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // A refusal releases the lock it took.
    expect(await store.lock('inflight:local', 'next', 60)).toBe(true);
  });

  test('a run already in flight → 429 in_progress, and it does not use up a window run', async () => {
    h.env.rateLimitRuns = 1;
    await store.lock('inflight:local', 'someone', 60);
    const res = await POST(req({ input: 'We sell mugs.' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('in_progress');
    await store.unlock('inflight:local', 'someone');
    expect((await POST(req({ input: 'We sell mugs.' }))).status).toBe(200);
  });

  test('daily cap headroom insufficient → 429 daily_cap with retry-after to UTC midnight', async () => {
    h.env.spendCapDailyUsd = 0.05;
    const res = await POST(req({ input: 'We sell mugs.' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('daily_cap');
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(86_400);
  });

  test('a pipeline that throws still ends the stream with done, and the ledger marks it crashed', async () => {
    h.impl = async () => {
      throw new Error('boom');
    };
    const text = await (await POST(req({ input: 'We sell mugs.' }))).text();
    expect(text).toMatch(/event: error/);
    expect(text).toMatch(/event: done/);
    await drainAfter();
    expect(await store.lock('inflight:local', 'next', 60)).toBe(true);
  });

  test('key missing → 503 for live, replay still 200', async () => {
    h.env.openaiKey = '';
    expect((await POST(req({ input: 'We sell mugs.' }))).status).toBe(503);
    expect((await POST(req({ input: 'Sample input.' }))).status).toBe(200);
  });

  test('store unavailable on Vercel → 503 for live, replay still 200', async () => {
    h.env.isVercel = true;
    spend._setStoreForTests(null);
    const res = await POST(req({ input: 'We sell mugs.' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('store_unavailable');
    expect((await POST(req({ input: 'Sample input.' }))).status).toBe(200);
  });

  test('client abort mid-stream → pipeline signal aborted, lock released, ledger marks it aborted', async () => {
    const ac = new AbortController();
    let sawAbort = false;
    h.impl = async (_i, _s, ctx) => {
      ctx.sink({ type: 'stage', stage: 'understand', status: 'started' });
      await ctx.spend!.reserve(0.05);
      await new Promise<void>((resolve) => ctx.signal!.addEventListener('abort', () => resolve(), { once: true }));
      sawAbort = true;
      return { summary: { run_id: ctx.run_id, cost_live_usd: 0, cost_replayed_usd: 0, calls: [], total_ms: 1, cold: false, skipped: [], errors: [{ stage: 'understand', code: 'aborted' }] } };
    };
    const res = await POST(req({ input: 'We sell mugs.' }, {}, ac.signal));
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(sawAbort).toBe(true));
    await drainAfter();
    expect(await store.lock('inflight:local', 'next', 60)).toBe(true);
    // The reservation stays whole: nothing settled it down.
    expect(await store.get('spend:test')).toBe(spend.toMicro(0.05));
  });
});
