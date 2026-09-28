import { describe, expect, test } from 'vitest';
import { personaJudgments, profiles } from './fixtures/llm-dims';
import { creativeArgs, creativeModule, reviseModule } from '@/prompts/creative';
import { criticModule } from '@/prompts/critic';
import { personaScoringArgs, scorePersonaModule } from '@/prompts/score-personas';
import { personas } from '@/lib/data';
import { publisherScoringArgs, scorePublishersModule } from '@/prompts/score-publishers';
import { understandModule } from '@/prompts/understand';

// Builder invariants that keep cache keys stable and the advertiser text out of the cached prefix.

const p1 = profiles[1];
const judgment = personaJudgments[1].find((j) => j.persona_id === 'persona_004')!;
const persona = { ...judgment, price_fit: 1, demo_fit: 1, score: 0.9, label: 'strong' as const, picked: true, name: 'The Pet Parent', description: 'd' };

describe('prompt builders', () => {
  test('candidate order does not change scoring args (same key whatever retrieval order)', () => {
    expect(publisherScoringArgs(p1.input, ['pub_003', 'pub_001', 'pub_002'])).toEqual(publisherScoringArgs(p1.input, ['pub_001', 'pub_002', 'pub_003']));
    expect(personaScoringArgs(p1.input, personas[0], ['pub_003', 'pub_001'])).toEqual(personaScoringArgs(p1.input, personas[0], ['pub_001', 'pub_003']));
  });

  test('scoring and persona args carry no offer, weights or recommended set', () => {
    for (const args of [publisherScoringArgs(p1.input, ['pub_001']), personaScoringArgs(p1.input, personas[0], ['pub_001'])]) {
      const json = JSON.stringify(args);
      expect(json).not.toMatch(/offer|weight|recommended|score"/);
    }
  });

  test('advertiser text never enters the stable instructions; it is delimited in the variable suffix', () => {
    for (const mod of [understandModule, scorePublishersModule, scorePersonaModule, creativeModule, criticModule]) {
      expect(mod.instructions).not.toContain('senior dogs');
    }
    expect(understandModule.build({ input: p1.input })).toContain(p1.input);
    expect(scorePublishersModule.build(publisherScoringArgs(p1.input, ['pub_001']))).toMatch(/<<<[\s\S]*>>>/);
  });

  test('creative args ignore the persona score and mapping (weight-invariant), carry the offer, switch to revise mode', () => {
    const a = creativeArgs(p1, persona, null);
    const b = creativeArgs(p1, { ...persona, score: 0.1, publisher_ids: ['pub_999'] }, null);
    expect(a).toEqual(b);
    expect(a.mode).toBe('write');
    const offer = { type: 'pct_off' as const, amount: 20, code: 'SENIOR20' };
    expect(creativeModule.build(creativeArgs(p1, persona, offer))).toContain('SENIOR20');
    const r = creativeArgs(p1, persona, null, { heading: 'h', subheading: 's', failures: ['grounded: drop "healthier"'] });
    expect(r.mode).toBe('revise');
    expect(reviseModule.build(r)).toContain('drop "healthier"');
    expect(reviseModule.id).not.toBe(creativeModule.id);
  });

  test('scoring prefixes are long enough for provider prompt caching (≥ 1,024 tokens ≈ 4,096 chars)', () => {
    expect(scorePublishersModule.instructions.length).toBeGreaterThan(4096);
    expect(scorePersonaModule.instructions.length).toBeGreaterThan(4096);
  });
});
