import { describe, expect, test, vi } from 'vitest';
import { readEnv } from '@/lib/env';

const base = { OPENAI_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv;

describe('readEnv', () => {
  test('defaults when unset', () => {
    const e = readEnv({ ...base });
    expect(e.retrieveK).toBe(20);
    expect(e.spendCapUsd).toBe(25);
    expect(e.spendEpoch).toBe('v1');
    expect(e.isVercel).toBe(false);
  });

  test('clamps RETRIEVE_K into [3, catalog] and logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readEnv({ ...base, RETRIEVE_K: '0' }).retrieveK).toBe(3);
    expect(readEnv({ ...base, RETRIEVE_K: '500' }).retrieveK).toBe(20);
    expect(readEnv({ ...base, RETRIEVE_K: 'abc' }).retrieveK).toBe(20);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  test('accepts either Upstash env spelling', () => {
    expect(readEnv({ ...base, KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't' }).upstashUrl).toBe('https://kv');
    expect(readEnv({ ...base, UPSTASH_REDIS_REST_URL: 'https://up', UPSTASH_REDIS_REST_TOKEN: 't' }).upstashUrl).toBe('https://up');
  });

  test('cap 0 is allowed (emergency stop) and epoch is trimmed', () => {
    const e = readEnv({ ...base, SPEND_CAP_USD: '0', SPEND_CAP_EPOCH: ' dev ' });
    expect(e.spendCapUsd).toBe(0);
    expect(e.spendEpoch).toBe('dev');
  });
});
