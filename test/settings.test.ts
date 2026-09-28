import { describe, expect, test } from 'vitest';
import { isCanonical, normalizeInput, normalizeSettings } from '@/lib/settings';

describe('normalizeSettings', () => {
  test('empty and omitted offer both normalise to the canonical shape', () => {
    const a = normalizeSettings({});
    const b = normalizeSettings({ offer: undefined, budgetUsd: undefined });
    expect(a).toEqual(b);
    expect(a.offer).toBeNull();
    expect(isCanonical(a)).toBe(true);
  });

  test('invalid numbers fall back to defaults; valid ones are marked user-set', () => {
    const s = normalizeSettings({ budgetUsd: 'NaN', durationDays: -3, conversionEvent: 'awareness' });
    expect(s.budgetUsd).toBe(10_000);
    expect(s.durationDays).toBe(30);
    expect(s.conversionEvent).toBe('purchase');
    const t = normalizeSettings({ budgetUsd: 1000, durationDays: 14, conversionEvent: 'signup' });
    expect(isCanonical(t)).toBe(false);
  });

  test('offer requires a known type; code is trimmed; an offer breaks canonical', () => {
    expect(normalizeSettings({ offer: { type: 'mystery', amount: 10 } }).offer).toBeNull();
    const s = normalizeSettings({ offer: { type: 'pct_off', amount: 20, code: '  WELCOME20 ' } });
    expect(s.offer).toEqual({ type: 'pct_off', amount: 20, code: 'WELCOME20' });
    expect(isCanonical(s)).toBe(false);
  });

  test('normalizeInput collapses whitespace only', () => {
    expect(normalizeInput('  We  sell\n dog   food ')).toBe('We sell dog food');
  });
});
