import { beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { RunContext } from '@/lib/types';

// ---- mocks (hoisted) ----
const gen = vi.hoisted(() => vi.fn());
class MockNoObject extends Error {
  text?: string;
  constructor(message: string, text?: string) {
    super(message);
    this.text = text;
  }
  static isInstance(e: unknown): e is MockNoObject {
    return e instanceof MockNoObject;
  }
}
vi.mock('ai', () => ({
  generateText: gen,
  Output: { object: (x: unknown) => x },
  NoObjectGeneratedError: MockNoObject,
}));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => (id: string) => ({ id }) }));

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class { get = redis.get; set = redis.set; } }));

process.env.OPENAI_API_KEY = 'sk-test';
process.env.UPSTASH_REDIS_REST_URL = 'https://x';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

const { callLLM, LlmError } = await import('@/lib/llm');
const { _setRedisForTests, pendingCommitted } = await import('@/lib/cache');
const { costUsd } = await import('@/lib/models');

const schema = z.object({ answer: z.string() });
const mod = {
  id: 'test-mod',
  promptVersion: '1',
  step: 'understand' as const,
  instructions: 'You are a test.',
  build: (a: { q: string; offer?: unknown }) => `Q: ${a.q}`,
  schema,
  schemaName: 'answer',
};

function ctx(over: Partial<RunContext> = {}): RunContext & { deferred: Array<() => Promise<void>>; events: unknown[] } {
  const deferred: Array<() => Promise<void>> = [];
  const events: unknown[] = [];
  return {
    run_id: 'r1',
    sink: (e) => events.push(e),
    wallAt: Date.now() + 29_000,
    startedAt: Date.now(),
    cacheMode: { read: true, replayOnly: false, writeCommitted: false },
    spend: null,
    defer: (t) => deferred.push(t),
    deferred,
    events,
    ...over,
  };
}

const okResult = (answer = 'ok') => ({
  output: { answer },
  usage: { inputTokens: 1000, outputTokens: 200, inputTokenDetails: { cacheReadTokens: 400 }, outputTokenDetails: { reasoningTokens: 50 } },
});

beforeEach(() => {
  gen.mockReset();
  redis.get.mockReset();
  redis.set.mockReset();
  redis.get.mockResolvedValue(null);
  pendingCommitted.clear();
  _setRedisForTests(new (class { get = redis.get; set = redis.set; })() as never);
});

describe('callLLM', () => {
  test('live call: validated output, cost from usage, one deferred redis write, no spend when hook absent', async () => {
    gen.mockResolvedValue(okResult());
    const c = ctx();
    const r = await callLLM(mod, { q: 'x' }, c);
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.source).toBe('live');
    expect(r.record.costUsd).toBeCloseTo(costUsd('gpt-6-sol', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 50 }), 10);
    expect(c.deferred).toHaveLength(1);
    await Promise.all(c.deferred.map((t) => t()));
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  test('cost formula: cached tokens at the cached rate', () => {
    // 600 uncached × $2 + 400 cached × $0.2 + 200 out × $10, per 1M
    expect(costUsd('gpt-6-sol', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 0 })).toBeCloseTo((600 * 2 + 400 * 0.2 + 200 * 10) / 1e6, 12);
  });

  test('redis hit skips the provider and records no spend', async () => {
    redis.get.mockResolvedValue({ output: { answer: 'cached' }, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 }, costUsd: 0.001, model: 'gpt-6-sol', promptVersion: '1', storedAt: 'x' });
    const spend = { reserve: vi.fn(), settle: vi.fn() };
    const r = await callLLM(mod, { q: 'x' }, ctx({ spend }));
    expect(r.source).toBe('redis');
    expect(gen).not.toHaveBeenCalled();
    expect(spend.reserve).not.toHaveBeenCalled();
  });

  test('replay-only double miss raises cache_miss without touching provider or spend', async () => {
    const spend = { reserve: vi.fn(), settle: vi.fn() };
    await expect(callLLM(mod, { q: 'x' }, ctx({ cacheMode: { read: true, replayOnly: true, writeCommitted: false }, spend }))).rejects.toMatchObject({ code: 'cache_miss' });
    expect(gen).not.toHaveBeenCalled();
    expect(spend.reserve).not.toHaveBeenCalled();
  });

  test('schema failure once → one repair call on luna, output returned', async () => {
    gen.mockRejectedValueOnce(new MockNoObject('bad json', '{"answer": 1}')).mockResolvedValueOnce(okResult('fixed'));
    const r = await callLLM(mod, { q: 'x' }, ctx());
    expect(r.output).toEqual({ answer: 'fixed' });
    expect(gen).toHaveBeenCalledTimes(2);
    expect((gen.mock.calls[1][0] as { model: { id: string } }).model.id).toBe('gpt-6-luna');
  });

  test('schema failure twice → schema_invalid with both raws, nothing cached, reservation settled', async () => {
    gen.mockRejectedValueOnce(new MockNoObject('bad', 'raw1')).mockRejectedValueOnce(new MockNoObject('bad again', 'raw2'));
    const spend = { reserve: vi.fn().mockResolvedValue({ ok: true, id: 'res1' }), settle: vi.fn() };
    const c = ctx({ spend });
    const err = await callLLM(mod, { q: 'x' }, c).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('schema_invalid');
    expect(err.raws).toEqual(['raw1', 'raw2']);
    await Promise.all(c.deferred.map((t) => t()));
    expect(spend.settle).toHaveBeenCalledWith('res1', expect.any(Number));
    expect(redis.set).not.toHaveBeenCalled();
  });

  test('spend refused → spend_refused, provider never called', async () => {
    const spend = { reserve: vi.fn().mockResolvedValue({ ok: false, reason: 'cap' }), settle: vi.fn() };
    await expect(callLLM(mod, { q: 'x' }, ctx({ spend }))).rejects.toMatchObject({ code: 'spend_refused' });
    expect(gen).not.toHaveBeenCalled();
  });

  test('aborted before the call → aborted, no reservation', async () => {
    const ac = new AbortController();
    ac.abort();
    const spend = { reserve: vi.fn(), settle: vi.fn() };
    await expect(callLLM(mod, { q: 'x' }, ctx({ signal: ac.signal, spend }))).rejects.toMatchObject({ code: 'aborted' });
    expect(spend.reserve).not.toHaveBeenCalled();
  });

  test('provider abort after the call started → reservation retained (settled to partial cost, not refunded)', async () => {
    const e = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    gen.mockRejectedValue(e);
    const spend = { reserve: vi.fn().mockResolvedValue({ ok: true, id: 'res2' }), settle: vi.fn() };
    const c = ctx({ spend });
    await expect(callLLM(mod, { q: 'x' }, c)).rejects.toMatchObject({ code: 'aborted' });
    expect(spend.reserve).toHaveBeenCalledTimes(1);
    await Promise.all(c.deferred.map((t) => t()));
    // Unknown consumption: the worst-case reservation stays on the counter, never settled down.
    expect(spend.settle).not.toHaveBeenCalled();
  });

  test('repair tokens are priced at the repair model, not the writer', async () => {
    const usage = { inputTokens: 1000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } };
    gen.mockRejectedValueOnce(new MockNoObject('bad', '{}')).mockResolvedValueOnce({ output: { answer: 'fixed' }, usage });
    const r = await callLLM(mod, { q: 'x' }, ctx());
    expect(r.record.costUsd).toBeCloseTo(costUsd('gpt-6-luna', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0 }), 12);
  });

  test('validate rejects once → one retry naming the problem; the rejected answer is never cached', async () => {
    gen.mockResolvedValueOnce(okResult('bad')).mockResolvedValueOnce(okResult('good'));
    const c = ctx({ cacheMode: { read: true, replayOnly: false, writeCommitted: true } });
    const r = await callLLM(mod, { q: 'x' }, c, { validate: (o) => (o.answer === 'bad' ? 'missing id pub_001' : null) });
    expect(r.output).toEqual({ answer: 'good' });
    expect(gen).toHaveBeenCalledTimes(2);
    expect((gen.mock.calls[1][0] as { prompt: string }).prompt).toContain('missing id pub_001');
    expect(pendingCommitted.get(r.key)?.output).toEqual({ answer: 'good' });
    expect(r.record.costUsd).toBeCloseTo(2 * costUsd('gpt-6-sol', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 50 }), 12);
  });

  test('validate rejects twice → schema_invalid, nothing cached', async () => {
    gen.mockResolvedValue(okResult('bad'));
    const c = ctx();
    await expect(callLLM(mod, { q: 'x' }, c, { validate: () => 'still wrong' })).rejects.toMatchObject({ code: 'schema_invalid' });
    expect(gen).toHaveBeenCalledTimes(2);
    await Promise.all(c.deferred.map((t) => t()));
    expect(redis.set).not.toHaveBeenCalled();
  });

  test('a cached entry that fails validate is treated as a miss', async () => {
    redis.get.mockResolvedValue({ output: { answer: 'bad' }, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 }, costUsd: 0.001, model: 'gpt-6-sol', promptVersion: '1', storedAt: 'x' });
    gen.mockResolvedValue(okResult('good'));
    const r = await callLLM(mod, { q: 'x' }, ctx(), { validate: (o) => (o.answer === 'bad' ? 'bad' : null) });
    expect(r.source).toBe('live');
    expect(r.output).toEqual({ answer: 'good' });
  });

  test('writeCommitted collects the entry for the eval to flush', async () => {
    gen.mockResolvedValue(okResult());
    const r = await callLLM(mod, { q: 'x' }, ctx({ cacheMode: { read: true, replayOnly: false, writeCommitted: true } }));
    expect(pendingCommitted.get(r.key)?.output).toEqual({ answer: 'ok' });
  });

  test('writeCommitted also carries forward a cache hit (the rewritten file stays complete)', async () => {
    const entry = { output: { answer: 'cached' }, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 }, costUsd: 0.001, model: 'gpt-6-sol', promptVersion: '1', storedAt: 'x' };
    redis.get.mockResolvedValue(entry);
    const r = await callLLM(mod, { q: 'x' }, ctx({ cacheMode: { read: true, replayOnly: false, writeCommitted: true } }));
    expect(gen).not.toHaveBeenCalled();
    expect(pendingCommitted.get(r.key)).toEqual(entry);
  });

  test('same args → same key; different offer → different key', async () => {
    gen.mockResolvedValue(okResult());
    const a = await callLLM(mod, { q: 'x', offer: null }, ctx());
    const b = await callLLM(mod, { q: 'x', offer: null }, ctx());
    const c = await callLLM(mod, { q: 'x', offer: { type: 'pct_off' } }, ctx());
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
  });
});
