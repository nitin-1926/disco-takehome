import { describe, expect, test } from 'vitest';
import { clientBucket, memoryStore, runWorstCaseUsd, spendHook, toMicro } from '@/lib/spend';

describe('spend hook on the memory store', () => {
  test('reserve then settle leaves the counter at the actual cost', async () => {
    const s = memoryStore();
    const h = spendHook(s, { key: 'k', capUsd: 1 });
    const r = await h.reserve(0.05, 'x');
    expect(r.ok).toBe(true);
    expect(await s.get('k')).toBe(toMicro(0.05));
    await h.settle((r as { id: string }).id, 0.012);
    expect(await s.get('k')).toBe(toMicro(0.012));
  });

  test('a refused reservation never touches the counter', async () => {
    const s = memoryStore();
    const h = spendHook(s, { key: 'k', capUsd: 0.1 });
    await h.reserve(0.08, 'a');
    const before = await s.get('k');
    expect(await h.reserve(0.05, 'b')).toEqual({ ok: false, reason: 'cap' });
    expect(await s.get('k')).toBe(before);
  });

  test('20 concurrent reservations with headroom for one: exactly one lands', async () => {
    const s = memoryStore();
    const h = spendHook(s, { key: 'k', capUsd: 0.06 });
    const rs = await Promise.all(Array.from({ length: 20 }, () => h.reserve(0.05, 'x')));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await s.get('k')).toBe(toMicro(0.05));
  });

  test('cap 0 is the emergency stop', async () => {
    const h = spendHook(memoryStore(), { key: 'k', capUsd: 0 });
    expect((await h.reserve(0.001, 'x')).ok).toBe(false);
  });

  test('a store failure refuses with reason store (fail closed)', async () => {
    const broken = { ...memoryStore(), reserve: async () => { throw new Error('down'); } };
    expect(await spendHook(broken, { key: 'k', capUsd: 10 }).reserve(0.01, 'x')).toEqual({ ok: false, reason: 'store' });
  });

  test('a run worst case covers the whole fan-out', () => {
    expect(runWorstCaseUsd()).toBeGreaterThan(0.1);
    expect(runWorstCaseUsd()).toBeLessThan(1);
  });
});

describe('lock and window', () => {
  test('lock is exclusive until released; release needs the token', async () => {
    const s = memoryStore();
    expect(await s.lock('l', 'a', 60)).toBe(true);
    expect(await s.lock('l', 'b', 60)).toBe(false);
    await s.unlock('l', 'b');
    expect(await s.lock('l', 'c', 60)).toBe(false);
    await s.unlock('l', 'a');
    expect(await s.lock('l', 'c', 60)).toBe(true);
  });

  test('an expired lock admits the next run', async () => {
    let now = 0;
    const s = memoryStore(() => now);
    await s.lock('l', 'a', 130);
    now = 131_000;
    expect(await s.lock('l', 'b', 130)).toBe(true);
  });

  test('window counts hits and resets after its TTL', async () => {
    let now = 0;
    const s = memoryStore(() => now);
    expect((await s.hit('w', 60)).count).toBe(1);
    expect((await s.hit('w', 60)).count).toBe(2);
    now = 61_000;
    expect((await s.hit('w', 60)).count).toBe(1);
  });
});

describe('clientBucket', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  test('local runs share one bucket', () => {
    expect(clientBucket(h({ 'x-forwarded-for': '1.2.3.4' }), false)).toBe('local');
  });
  test('a client-prefixed forwarded-for chain lands in the connection address bucket', () => {
    expect(clientBucket(h({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }), true)).toBe('9.9.9.9');
    expect(clientBucket(h({ 'x-forwarded-for': '9.9.9.9' }), true)).toBe('9.9.9.9');
    expect(clientBucket(h({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }), true)).toBe('9.9.9.9');
  });
  test('IPv6 is bucketed by /64', () => {
    expect(clientBucket(h({ 'x-real-ip': '2001:db8:1:2:aaaa::1' }), true)).toBe(clientBucket(h({ 'x-real-ip': '2001:db8:1:2:bbbb::9' }), true));
  });
});
