import { describe, expect, test } from 'vitest';
import {
  CPA_SHARE_BAND, CPA_SHARE_OF_PRICE, CVR_BAND, CVR_PRIOR, ECPM_BAND, SIGNUP_CPA_USD, SUBSCRIPTION_LTV_MULT,
  cpcAlternative, effectiveCvr, impliedEcpm, priceMid, targetCpa,
} from '@/lib/pricing';
import { profiles } from './fixtures/llm-dims';

describe('constants', () => {
  test('values per F7', () => {
    expect(CPA_SHARE_OF_PRICE).toBe(0.3);
    expect(CPA_SHARE_BAND).toEqual([0.25, 0.4]);
    expect(SUBSCRIPTION_LTV_MULT).toBe(1.5);
    expect(SIGNUP_CPA_USD).toBe(8);
    expect(CVR_PRIOR).toBe(0.01);
    expect(CVR_BAND).toEqual([0.005, 0.02]);
    expect(ECPM_BAND).toEqual([20, 800]);
  });
});

describe('targetCpa', () => {
  test('purchase = 30% of the stated price', () => {
    const r = targetCpa(profiles[10], 'purchase');
    expect(r.cpa).toBe(360);
    expect(r.basis).toContain('30%');
    expect(r.basis).toContain('$1,200');
  });
  test('LTV multiplier applies to a subscription event or a subscription product; signup is the constant', () => {
    expect(targetCpa(profiles[1], 'subscription').cpa).toBeCloseTo(70 * 0.3 * 1.5);
    expect(targetCpa(profiles[1], 'purchase').cpa).toBeCloseTo(31.5); // #1 is subscription-based
    expect(targetCpa(profiles[4], 'purchase').cpa).toBeCloseTo(32.5 * 0.3);
    expect(targetCpa(profiles[4], 'subscription').cpa).toBeCloseTo(32.5 * 0.3 * 1.5, 1); // rounded to cents
    expect(targetCpa(profiles[1], 'signup')).toMatchObject({ cpa: 8 });
  });
  test('null price falls back to a tier default and says so', () => {
    const r = targetCpa({ ...profiles[1], price: null }, 'purchase');
    expect(r.cpa).toBeGreaterThan(0);
    expect(r.basis).toMatch(/tier/i);
    expect(priceMid({ ...profiles[1], price: null }).basis).toBe('tier_default');
  });
});

describe('effectiveCvr and eCPM', () => {
  test('prior × score × min(1, aov/price)', () => {
    expect(effectiveCvr(0.01, 0.8, 64, 70)).toBeCloseTo(0.01 * 0.8 * (64 / 70));
    expect(effectiveCvr(0.01, 0.8, 128, 70)).toBeCloseTo(0.008);
  });
  test('implied eCPM = cpa × cvr × 1000 with band flag', () => {
    expect(impliedEcpm(31.5, 0.009)).toEqual({ ecpm: 283.5, in_band: true });
    expect(impliedEcpm(360, 0.00001).in_band).toBe(false);
    expect(impliedEcpm(360, 0.01).in_band).toBe(false);
  });
});

describe('cpcAlternative', () => {
  test('offered when the advertiser is price-led', () => {
    const r = cpcAlternative(profiles[13]);
    expect(r).not.toBeNull();
    expect(r!.min_usd).toBeLessThan(r!.max_usd);
  });
  test('null otherwise', () => {
    expect(cpcAlternative(profiles[10])).toBeNull();
    expect(cpcAlternative(profiles[1])).toBeNull();
  });
});
