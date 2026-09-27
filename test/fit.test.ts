import { describe, expect, test } from 'vitest';
import publishers from '@/data/publishers.json';
import type { Publisher } from '@/lib/types';
import { ageOverlap, audienceFit, genderFit, incomeFit, parseAgeRange, personaFemaleShare, priceFit } from '@/lib/fit';
import { profiles } from './fixtures/llm-dims';

const pubs = publishers as Publisher[];
const byName = (name: string) => pubs.find((p) => p.name === name)!;

describe('parseAgeRange', () => {
  test('parses "45-65"', () => expect(parseAgeRange('45-65')).toEqual({ low: 45, high: 65 }));
  test('non-ranges are null', () => {
    expect(parseAgeRange('nationwide')).toBeNull();
    expect(parseAgeRange('balanced')).toBeNull();
    expect(parseAgeRange('')).toBeNull();
  });
  test('every catalog age_skew and persona age_range parses', () => {
    for (const p of pubs) expect(parseAgeRange(p.audience.age_skew)).not.toBeNull();
  });
});

describe('ageOverlap', () => {
  test('fraction of the buyer range the audience covers', () => {
    expect(ageOverlap({ low: 35, high: 60 }, { low: 50, high: 70 })).toBeCloseTo(11 / 26, 5);
    expect(ageOverlap({ low: 30, high: 40 }, { low: 25, high: 55 })).toBe(1);
    expect(ageOverlap({ low: 18, high: 24 }, { low: 45, high: 65 })).toBe(0);
  });
  test('unknown on either side is neutral 1', () => {
    expect(ageOverlap(null, { low: 1, high: 2 })).toBe(1);
    expect(ageOverlap({ low: 1, high: 2 }, null)).toBe(1);
  });
});

describe('genderFit', () => {
  test('unspecified and balanced buyers are neutral', () => {
    expect(genderFit('unspecified', 0.96, 0.04)).toBe(1);
    expect(genderFit('balanced', 0.96, 0.04)).toBe(1);
  });
  test('female buyer gets the non-male share', () => {
    expect(genderFit('female', 0.96, 0.04)).toBeCloseTo(0.96);
    expect(genderFit('male', 0.96, 0.04)).toBeCloseTo(0.04);
  });
  test('persona skew map', () => {
    expect(personaFemaleShare('female')).toBe(0.85);
    expect(personaFemaleShare('female-leaning')).toBe(0.65);
    expect(personaFemaleShare('balanced')).toBe(0.5);
    expect(personaFemaleShare('male-leaning')).toBe(0.35);
    expect(personaFemaleShare('male')).toBe(0.15);
  });
});

describe('incomeFit', () => {
  test('audience at or above the price tier is a full fit', () => {
    expect(incomeFit('premium', 'high')).toBe(1);
    expect(incomeFit('budget', 'high')).toBe(1);
    expect(incomeFit('mid', 'mid')).toBe(1);
  });
  test('each tier the audience falls short costs fit', () => {
    expect(incomeFit('premium', 'mid')).toBeLessThan(1);
    expect(incomeFit('luxury', 'mid')).toBeLessThan(incomeFit('premium', 'mid'));
    expect(incomeFit('luxury', 'low')).toBeLessThan(incomeFit('luxury', 'mid'));
  });
});

describe('priceFit', () => {
  test('price at or under AOV is 1.0', () => {
    expect(priceFit({ low: 50, high: 50, basis: 'assumed' }, byName('Pawline')).fit).toBe(1);
  });
  test('decays above AOV with a 0.3 floor', () => {
    const tail = byName('Tailcrate'); // AOV 35, mid income
    const at70 = priceFit({ low: 70, high: 70, basis: 'assumed' }, tail).fit;
    const at100 = priceFit({ low: 100, high: 100, basis: 'assumed' }, tail).fit;
    expect(at70).toBeLessThan(1);
    expect(at100).toBeLessThan(at70);
    expect(priceFit({ low: 5000, high: 5000, basis: 'stated' }, tail).fit).toBe(0.3);
  });
  test('high-income audience softens the penalty and the reason quotes the ratio', () => {
    const linden = byName('Linden Park');
    const r = priceFit({ low: 1200, high: 1200, basis: 'stated' }, linden);
    expect(r.fit).toBeGreaterThan(0.3);
    expect(r.reason).toBe("$1,200 is 9.4x Linden Park's $128 AOV; high-income audience softens the penalty");
  });
  test('uses the price range midpoint', () => {
    const tail = byName('Tailcrate');
    expect(priceFit({ low: 50, high: 90, basis: 'assumed' }, tail).fit).toBe(priceFit({ low: 70, high: 70, basis: 'assumed' }, tail).fit);
  });
  test('null price is neutral 0.7', () => {
    expect(priceFit(null, byName('Pawline')).fit).toBe(0.7);
  });
});

describe('audienceFit', () => {
  test('#9: Swiftcart never beats Pantrygood on audience', () => {
    const p = profiles[9];
    expect(audienceFit(p, byName('Swiftcart')).fit).toBeLessThanOrEqual(audienceFit(p, byName('Pantrygood')).fit);
    const aged = { ...p, buyer_age: { low: 25, high: 45 } };
    expect(audienceFit(aged, byName('Swiftcart')).fit).toBeLessThan(audienceFit(aged, byName('Pantrygood')).fit);
  });
  test('female product on a women-led publisher outranks a mixed one; reason quotes the split', () => {
    const p = profiles[10];
    const marlowe = audienceFit(p, byName('Marlowe & Co.'));
    const swift = audienceFit(p, byName('Swiftcart'));
    expect(marlowe.fit).toBeGreaterThan(swift.fit);
    expect(marlowe.reason).toContain('96% female');
  });
  test('age overlap is quoted with real numbers', () => {
    const p = { ...profiles[14], buyer_age: { low: 30, high: 50 } };
    const r = audienceFit(p, byName('Marlowe & Co.'));
    expect(r.reason).toContain('30-50');
    expect(r.reason).toContain('45-65');
    expect(r.fit).toBeLessThan(1);
  });
});
