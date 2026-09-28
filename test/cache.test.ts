import { describe, expect, test } from 'vitest';
import { _setRedisForTests, cacheGet, cacheKey, canonicalJson, isCommittedInput } from '@/lib/cache';

const base = {
  module: 'understand',
  promptVersion: '1',
  instructionsHash: 'abc',
  model: 'gpt-6-sol',
  reasoning: 'low',
  schemaName: 'profile',
  args: { input: 'dog food', settings: { offer: null } },
};

describe('cacheKey', () => {
  test('is stable across key order and repeated calls', () => {
    const a = cacheKey(base);
    const b = cacheKey({ ...base, args: { settings: { offer: null }, input: 'dog food' } });
    expect(a).toBe(b);
    expect(cacheKey(base)).toBe(a);
  });

  test('changes when any answer-affecting part changes', () => {
    const a = cacheKey(base);
    expect(cacheKey({ ...base, promptVersion: '2' })).not.toBe(a);
    expect(cacheKey({ ...base, instructionsHash: 'def' })).not.toBe(a);
    expect(cacheKey({ ...base, model: 'gpt-6-luna' })).not.toBe(a);
    expect(cacheKey({ ...base, reasoning: 'none' })).not.toBe(a);
    expect(cacheKey({ ...base, schemaName: 'profile_v2' })).not.toBe(a);
    expect(cacheKey({ ...base, args: { ...base.args, settings: { offer: { type: 'pct_off', amount: 10, code: null } } } })).not.toBe(a);
  });

  test('canonicalJson sorts nested keys and keeps arrays ordered', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 0 } })).toBe('{"a":{"c":0,"d":[2,1]},"b":1}');
  });
});

describe('committed samples and replay-only reads', () => {
  test('only own keys count as a committed sample (no prototype names)', async () => {
    const { committedCache } = await import('@/lib/data');
    const sample = Object.keys(committedCache.inputs)[0];
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(isCommittedInput(name)).toBe(false);
    expect(isCommittedInput(`  ${sample}  `)).toBe(true);
  });
  test('replay-only never reads Redis; a normal read does', async () => {
    let gets = 0;
    _setRedisForTests({ get: async () => (gets++, null) } as unknown as Parameters<typeof _setRedisForTests>[0]);
    try {
      expect(await cacheGet('nope', { read: true, replayOnly: true, writeCommitted: false })).toBeNull();
      expect(gets).toBe(0);
      await cacheGet('nope', { read: true, replayOnly: false, writeCommitted: false });
      expect(gets).toBe(1);
    } finally {
      _setRedisForTests(undefined);
    }
  });
});
