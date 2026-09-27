import { describe, expect, test } from 'vitest';
import { cacheKey, canonicalJson } from '@/lib/cache';

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
