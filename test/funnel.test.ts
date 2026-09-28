import { describe, expect, test } from 'vitest';
import publishers from '@/data/publishers.json';
import type { AdvertiserProfile, Publisher, PublisherScore } from '@/lib/types';
import { GATE, THRESHOLDS, WEIGHTS, effectiveWeights, groupExclusions, resolveViability, scorePublishers, consistentComparatives } from '@/lib/funnel';
import { profiles, publisherDims } from './fixtures/llm-dims';

const pubs = publishers as Publisher[];
const id = (name: string) => pubs.find((p) => p.name === name)!.id;
const find = (scores: PublisherScore[], name: string) => scores.find((s) => s.publisher_id === id(name))!;
const withPrice = (p: AdvertiserProfile, usd: number): AdvertiserProfile => ({ ...p, price: { low: usd, high: usd, basis: 'assumed' } });

describe('constants', () => {
  test('gate and weights match F4/F5', () => {
    expect(GATE).toEqual({ 0: 0, 1: 0.2, 2: 0.5, 3: 0.8, 4: 0.9, 5: 1 });
    expect(WEIGHTS).toEqual({ tone: 0.4, audience: 0.3, price: 0.3 });
    expect(THRESHOLDS.recommended).toBe(0.55);
    expect(THRESHOLDS.weak).toBe(0.35);
  });
  test('an exact category outranks an adjacent one when everything else ties', () => {
    const dims = publisherDims[1].filter((d) => d.publisher_id === 'pub_007');
    const at = (category_fit: number) => scorePublishers(profiles[1], pubs, dims.map((d) => ({ ...d, category_fit })))[0].score;
    expect(at(5)).toBeGreaterThan(at(4));
    expect(at(4)).toBeGreaterThan(at(3));
  });
  test('a pairwise reason that contradicts the final order is dropped', () => {
    const scores = scorePublishers(profiles[1], pubs, publisherDims[1]);
    const [a, b] = scores.map((s) => s.publisher_id);
    const kept = consistentComparatives([{ higher: a, lower: b, why: 'agrees' }, { higher: b, lower: a, why: 'contradicts' }], scores);
    expect(kept.map((c) => c.why)).toEqual(['agrees']);
  });
  test('assumed price halves the price weight and renormalises', () => {
    const w = effectiveWeights(WEIGHTS, 'assumed');
    expect(w.tone + w.audience + w.price).toBeCloseTo(1, 10);
    expect(w.price).toBeCloseTo(0.15 / 0.85, 10);
    expect(effectiveWeights(WEIGHTS, 'stated')).toEqual(WEIGHTS);
  });
});

describe('#1 senior dog food', () => {
  test.each([50, 75, 100])('Pawline > Ruffco > Tailcrate at assumed price $%i', (usd) => {
    const scores = scorePublishers(withPrice(profiles[1], usd), pubs, publisherDims[1]);
    const order = scores.map((s) => s.publisher_id);
    const pos = (name: string) => order.indexOf(id(name));
    expect(pos('Pawline')).toBeLessThan(pos('Ruffco'));
    expect(pos('Ruffco')).toBeLessThan(pos('Tailcrate'));
    expect(find(scores, 'Pawline').band).toBe('recommended');
    expect(find(scores, 'Ruffco').band).toBe('recommended');
    expect(find(scores, 'Tailcrate').band).not.toBe('excluded');
  });
  test('Daily Form excluded under "not their category" at category_fit 0', () => {
    const s = find(scorePublishers(profiles[1], pubs, publisherDims[1]), 'Daily Form');
    expect(s.category_fit).toBe(0);
    expect(s.gate).toBe(0);
    expect(s.score).toBe(0);
    expect(s.band).toBe('excluded');
    expect(s.exclusion_group).toBe('not their category');
  });
  test('sorted desc with id tiebreak; recommended never carries an exclusion group', () => {
    const scores = scorePublishers(profiles[1], pubs, publisherDims[1]);
    for (let i = 1; i < scores.length; i++) {
      const a = scores[i - 1], b = scores[i];
      expect(a.score > b.score || (a.score === b.score && a.publisher_id < b.publisher_id)).toBe(true);
    }
    for (const s of scores) if (s.band !== 'excluded') expect(s.exclusion_group).toBeNull();
  });
  test('retrieval similarity passes through', () => {
    const scores = scorePublishers(profiles[1], pubs, publisherDims[1], { pub_007: 0.83 });
    expect(find(scores, 'Pawline').retrieval_similarity).toBe(0.83);
    expect(find(scores, 'Ruffco').retrieval_similarity).toBeNull();
  });
});

describe('#10 luxury handbags', () => {
  const scores = scorePublishers(profiles[10], pubs, publisherDims[10]);
  test('no publisher is hard-excluded on price alone; ≥ 3 weak or better', () => {
    const kept = scores.filter((s) => s.band !== 'excluded');
    expect(kept.length).toBeGreaterThanOrEqual(3);
    for (const s of scores) expect(s.price_fit).toBeGreaterThanOrEqual(0.3);
  });
  test("Linden Park's price reason quotes 9.4x", () => {
    expect(find(scores, 'Linden Park').reasons.price).toContain('9.4x');
  });
});

describe('#6 and #9 gate survivors', () => {
  test('#6: Cloudfoot survives', () => {
    const s = find(scorePublishers(profiles[6], pubs, publisherDims[6]), 'Cloudfoot');
    expect(s.band).not.toBe('excluded');
  });
  test('#9: Swiftcart audience_fit ≤ Pantrygood audience_fit; Cloudfoot and Stride & Stem survive', () => {
    const scores = scorePublishers(profiles[9], pubs, publisherDims[9]);
    expect(find(scores, 'Swiftcart').audience_fit).toBeLessThanOrEqual(find(scores, 'Pantrygood').audience_fit);
    expect(find(scores, 'Cloudfoot').band).not.toBe('excluded');
    expect(find(scores, 'Stride & Stem').band).not.toBe('excluded');
    expect(find(scores, 'Pantrygood').band).toBe('recommended');
  });
});

describe('near miss and grouping', () => {
  test('near_miss marks non-recommended within 0.1 of the cut', () => {
    const scores = scorePublishers(profiles[6], pubs, publisherDims[6]);
    for (const s of scores) expect(s.near_miss).toBe(s.band !== 'recommended' && s.score >= THRESHOLDS.recommended - 0.1);
    expect(scores.some((s) => s.near_miss)).toBe(true);
  });
  test('groupExclusions counts by lowest dimension', () => {
    const scores = scorePublishers(profiles[1], pubs, publisherDims[1]);
    const groups = groupExclusions(scores);
    const cat = groups.find((g) => g.group === 'not their category')!;
    expect(cat.count).toBe(cat.ids.length);
    expect(cat.ids).toContain(id('Daily Form'));
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(scores.filter((s) => s.band === 'excluded').length);
  });
  test('weights override changes scores (eval grid search hook)', () => {
    const a = scorePublishers(profiles[1], pubs, publisherDims[1]);
    const b = scorePublishers(profiles[1], pubs, publisherDims[1], undefined, { tone: 0.2, audience: 0.4, price: 0.4 });
    expect(find(a, 'Pawline').score).not.toBe(find(b, 'Pawline').score);
  });
});

describe('resolveViability', () => {
  const strongScores = scorePublishers(profiles[1], pubs, publisherDims[1]);
  const noneRecommended = strongScores.map((s) => ({ ...s, score: Math.min(s.score, 0.5), band: s.band === 'recommended' ? ('weak' as const) : s.band }));
  test('strong with zero recommended → weak', () => {
    expect(resolveViability('strong', noneRecommended)).toMatchObject({ viability: 'weak', flagged: false });
  });
  test('strong with recommended stays strong', () => {
    expect(resolveViability('strong', strongScores)).toMatchObject({ viability: 'strong', flagged: false, message: null });
  });
  test('none with a publisher ≥ 0.55 → weak and flagged, naming the publisher', () => {
    const r = resolveViability('none', strongScores);
    expect(r.viability).toBe('weak');
    expect(r.flagged).toBe(true);
    expect(r.message).toContain(id('Pawline'));
  });
  test('none with nothing ≥ 0.55 stays none; weak passes through', () => {
    expect(resolveViability('none', noneRecommended).viability).toBe('none');
    expect(resolveViability('weak', strongScores).viability).toBe('weak');
  });
});

describe('red flags cap a publisher at weak (F28)', () => {
  // A strong-tone, same-category publisher with a stated price 9x its order value.
  const handbag: AdvertiserProfile = { ...profiles[10], price: { low: 1200, high: 1200, basis: 'stated' } };
  const dims = [{ publisher_id: id('Linden Park'), category_fit: 4, tone_fit: 5, reason: 'classic apparel' }];

  test('stated price far above the AOV holds a high score at weak, naming the flag', () => {
    const s = scorePublishers(handbag, pubs, dims)[0];
    expect(s.score).toBeGreaterThanOrEqual(THRESHOLDS.recommended);
    expect(s.band).toBe('weak');
    expect(s.capped_by).toMatch(/price/);
  });

  test('an assumed price is a guess and never caps the band', () => {
    const s = scorePublishers({ ...handbag, price: { low: 1200, high: 1200, basis: 'assumed' } }, pubs, dims)[0];
    expect(s.band).toBe('recommended');
    expect(s.capped_by).toBeNull();
  });

  test('tone below 3 caps at weak: the audience resists this positioning', () => {
    const s = scorePublishers(profiles[1], pubs, [{ publisher_id: id('Pawline'), category_fit: 5, tone_fit: 2, reason: 'x' }])[0];
    expect(s.score).toBeGreaterThanOrEqual(THRESHOLDS.recommended);
    expect(s.band).toBe('weak');
    expect(s.capped_by).toBe('tone fit 2/5');
  });

  test('an audience that is not the buyer caps at weak: a men\'s product on a 96%-women publisher', () => {
    const mens: AdvertiserProfile = { ...profiles[1], buyer_gender: 'male', buyer_basis: 'stated', price: { low: 100, high: 100, basis: 'stated' } };
    const s = scorePublishers(mens, pubs, [{ publisher_id: id('Marlowe & Co.'), category_fit: 4, tone_fit: 5, reason: 'x' }])[0];
    expect(s.audience_fit).toBeLessThan(THRESHOLDS.audience_min);
    expect(s.band).not.toBe('recommended');
    expect(s.capped_by ?? s.exclusion_group).toMatch(/shoppers are not who you sell to|audience/);
  });

  test('no red flag → recommended as before', () => {
    const s = scorePublishers(profiles[1], pubs, [{ publisher_id: id('Pawline'), category_fit: 5, tone_fit: 5, reason: 'x' }])[0];
    expect(s.band).toBe('recommended');
    expect(s.capped_by).toBeNull();
  });
});
