import { describe, expect, test } from 'vitest';
import personasJson from '@/data/shopper_personas.json';
import type { LlmPersonaJudgment, Persona } from '@/lib/types';
import { GATE } from '@/lib/funnel';
import { jaccard, personaDemoFit, personaPriceFit, scorePersonas } from '@/lib/personas';
import { PERSONA_IDS, personaJudgments, profiles } from './fixtures/llm-dims';

const personas = personasJson as Persona[];
const byName = (name: string) => personas.find((p) => p.name === name)!;
const REC = ['pub_004', 'pub_005'];

function judge(id: string, fit: number, extra: Partial<LlmPersonaJudgment> = {}): LlmPersonaJudgment {
  return { persona_id: id, fit, conflicts: [], why: '', preferences_to_use: [], disinterests_to_avoid: [], offer_depth: 'none', publisher_ids: [], ...extra };
}

describe('code dims', () => {
  test('price fit tolerates high prices for low-sensitivity personas', () => {
    const price = { low: 200, high: 200, basis: 'stated' as const };
    expect(personaPriceFit(price, byName('The Affluent Classic'))).toBeGreaterThan(personaPriceFit(price, byName('The Value-Conscious Shopper')));
    expect(personaPriceFit({ low: 30, high: 30, basis: 'stated' }, byName('The Value-Conscious Shopper'))).toBe(1);
    expect(personaPriceFit(null, byName('The Gifter'))).toBe(0.7);
  });
  test('demo fit = age overlap × gender share', () => {
    const female = { ...profiles[10], buyer_age: { low: 50, high: 68 } };
    expect(personaDemoFit(female, byName('The Affluent Classic'))).toBeCloseTo(0.85);
    expect(personaDemoFit(female, byName('The Gifter'))).toBeCloseTo(0.5 * (11 / 19));
    expect(personaDemoFit(profiles[1], byName('The Gifter'))).toBe(1);
  });
  test('jaccard over affinities ∪ messaging', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
    expect(jaccard([], [])).toBe(0);
  });
});

describe('#10 handbags', () => {
  const out = scorePersonas(profiles[10], personas, personaJudgments[10], REC);
  const picked = out.filter((p) => p.picked);
  test('≥ 3 picked; Affluent Classic strong and first', () => {
    expect(picked.length).toBeGreaterThanOrEqual(3);
    expect(picked[0].persona_id).toBe('persona_005');
    expect(picked[0].label).toBe('strong');
  });
  test('Gifter demoted by its conflict and labelled stretch, conflict kept visible', () => {
    const gifter = out.find((p) => p.persona_id === 'persona_010')!;
    const classic = out.find((p) => p.persona_id === 'persona_005')!;
    expect(gifter.score).toBeLessThan(classic.score / 2 + 0.01);
    expect(gifter.picked).toBe(true);
    expect(gifter.label).toBe('stretch');
    expect(gifter.conflicts[0].input_quote).toBe('ships in 6 weeks');
  });
  test('publisher mapping = LLM suggestion ∩ recommended, falling back to all recommended', () => {
    const classic = out.find((p) => p.persona_id === 'persona_005')!;
    expect(classic.publisher_ids).toEqual(['pub_005', 'pub_004']);
    const genz = out.find((p) => p.persona_id === 'persona_003')!;
    expect(genz.publisher_ids).toEqual(REC);
  });
  test('score formula: gate(fit) × (0.5·fit/5 + 0.25·price + 0.25·demo), halved per conflict', () => {
    for (const p of out) {
      const base = 0.5 * (p.fit / 5) + 0.25 * p.price_fit + 0.25 * p.demo_fit;
      expect(p.score).toBeCloseTo(GATE[p.fit] * base * Math.pow(0.5, p.conflicts.length), 10);
    }
  });
  test('trap: a fit-1 persona with neutral code dims cannot outrank the conflict-halved Gifter', () => {
    const wellness = out.find((p) => p.persona_id === 'persona_001')!;
    const gifter = out.find((p) => p.persona_id === 'persona_010')!;
    expect(wellness.score).toBeLessThan(gifter.score);
    expect(wellness.picked).toBe(false);
  });
});

describe('pick rules', () => {
  test('mapping intersection drops a suggestion outside the recommended set', () => {
    const js = PERSONA_IDS.map((id, i) => judge(id, 5 - Math.min(i, 4), { publisher_ids: ['pub_001', 'pub_005'] }));
    const out = scorePersonas(profiles[1], personas, js, ['pub_005', 'pub_007']);
    expect(out[0].publisher_ids).toEqual(['pub_005']);
  });
  test('conflicts hard-exclude while ≥ 3 clean personas clear the floor', () => {
    const js = PERSONA_IDS.map((id, i) => judge(id, 5, i < 4 ? { conflicts: [{ field: 'x', persona_value: 'y', input_quote: 'z' }] } : {}));
    const out = scorePersonas(profiles[1], personas, js, REC);
    for (const p of out) if (p.conflicts.length) expect(p.picked).toBe(false);
    expect(out.filter((p) => p.picked).length).toBeGreaterThanOrEqual(3);
  });
  test('all ten conflicting → top 3 by score, all stretch', () => {
    const js = PERSONA_IDS.map((id, i) => judge(id, i % 4, { conflicts: [{ field: 'x', persona_value: 'y', input_quote: 'z' }] }));
    const out = scorePersonas(profiles[1], personas, js, REC);
    const picked = out.filter((p) => p.picked);
    expect(picked).toHaveLength(3);
    expect(picked.every((p) => p.label === 'stretch')).toBe(true);
    const top3 = [...out].sort((a, b) => b.score - a.score || a.persona_id.localeCompare(b.persona_id)).slice(0, 3).map((p) => p.persona_id);
    expect(picked.map((p) => p.persona_id).sort()).toEqual(top3.sort());
  });
  test('fewer than 3 clear the floor → still 3 picked, extras labelled stretch', () => {
    const js = PERSONA_IDS.map((id, i) => judge(id, i === 0 ? 5 : 0));
    const picked = scorePersonas(profiles[1], personas, js, REC).filter((p) => p.picked);
    expect(picked).toHaveLength(3);
    expect(picked.filter((p) => p.label === 'stretch')).toHaveLength(2);
  });
  test('max = 3 (CREATIVES_MAX fallback) yields exactly three picks', () => {
    const js = PERSONA_IDS.map((id) => judge(id, 5));
    expect(scorePersonas(profiles[1], personas, js, REC, { max: 3 }).filter((p) => p.picked)).toHaveLength(3);
  });
  test('default max is 5', () => {
    const js = PERSONA_IDS.map((id) => judge(id, 5));
    expect(scorePersonas(profiles[1], personas, js, REC).filter((p) => p.picked)).toHaveLength(5);
  });
  test('MMR spreads picks across near-identical wellness personas', () => {
    const clone = (id: string, name: string): Persona => ({ ...byName('The Wellness Optimizer'), id, name });
    const synthetic: Persona[] = [
      clone('w1', 'W1'), clone('w2', 'W2'), clone('w3', 'W3'), clone('w4', 'W4'), clone('w5', 'W5'),
      { ...byName('The Pet Parent'), id: 'd1' },
      { ...byName('The Gifter'), id: 'd2' },
    ];
    const js = synthetic.map((p) => judge(p.id, p.id.startsWith('w') ? 5 : 4));
    const picked = scorePersonas(profiles[1], synthetic, js, REC, { max: 3 }).filter((p) => p.picked).map((p) => p.persona_id);
    expect(picked).toHaveLength(3);
    expect(picked.filter((id) => id.startsWith('w')).length).toBeLessThan(3);
  });
  test('output keeps picked first in pick order, then the rest by score', () => {
    const out = scorePersonas(profiles[10], personas, personaJudgments[10], REC);
    const firstUnpicked = out.findIndex((p) => !p.picked);
    expect(out.slice(firstUnpicked).every((p) => !p.picked)).toBe(true);
  });
});
