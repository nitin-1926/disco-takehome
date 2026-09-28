import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { buildConfig } from '@/lib/config';
import { personas, publishers } from '@/lib/data';
import { scorePublishers } from '@/lib/funnel';
import { scorePersonas } from '@/lib/personas';
import { normalizeSettings } from '@/lib/settings';
import type { Creative } from '@/lib/types';
import { expectationChecks, invariants, writeGuard } from '@/eval/checks';
import { EXPECTATIONS, resolveNames } from '@/eval/expectations';
import { personaJudgments, profiles, publisherDims } from './fixtures/llm-dims';

// A valid #1 run assembled from the fixtures, then broken one way at a time.

const catalog = { publisherIds: publishers.map((p) => p.id), personaIds: personas.map((p) => p.id) };
const settings = normalizeSettings();

function validRun() {
  const profile = profiles[1];
  const scores = scorePublishers(profile, publishers, publisherDims[1]);
  const picks = scorePersonas(profile, personas, personaJudgments[1], scores.filter((s) => s.band === 'recommended').map((s) => s.publisher_id));
  const creatives: Creative[] = picks
    .filter((p) => p.picked)
    .map((p, i) => ({
      id: `c${i + 1}`, persona_id: p.persona_id, angle: 'a', heading: 'Care for the dog who grew up with you', subheading: 'with grain-free, vet-formulated food.',
      cta: 'Shop Now', offer: null, disclosure: null, claims_used: ['f3'], publisher_ids: [], constraints_respected: [],
      critic: { pass: true, checks: [], unverified: false }, revised_from: null, char_counts: { heading: 37, subheading: 37 }, grounding_flags: [], error: null,
    }));
  const config = buildConfig({ profile, triage: profile.triage, settings, publisherScores: scores, personaScores: picks, creatives, publishers, meta: { run_id: 't', generated_at: 'x', pipeline_version: 'x' }, today: '2026-09-28' });
  return { mode: 'full', profile, triage: profile.triage, publishers: scores, personas: picks, creatives, config };
}
const inv = (r: ReturnType<typeof validRun>) => invariants(r, catalog, { expectVerified: true, budgetUsd: settings.budgetUsd }).filter((c) => !c.pass).map((c) => c.name);

describe('eval invariants', () => {
  test('a valid run passes every invariant', () => {
    expect(inv(validRun())).toEqual([]);
  });
  test('allocation off by one cent fails', () => {
    const r = validRun();
    r.config.placements[0].allocation_usd += 0.01;
    expect(inv(r)).toContain('allocations sum to total');
  });
  test('51-char heading fails', () => {
    const r = validRun();
    r.creatives[0].heading = 'x'.repeat(51);
    expect(inv(r)).toContain('c1 heading ≤ 50');
  });
  test('claim id not in facts fails', () => {
    const r = validRun();
    r.creatives[0].claims_used = ['f9'];
    expect(inv(r)).toContain('c1 claims traceable');
  });
  test('viability none with a total above $0 fails', () => {
    const r = validRun();
    r.triage = { ...r.triage, viability: 'none' };
    expect(inv(r)).toContain('none ⇒ $0 and no placements');
  });
  test('unverified creative fails when verification is expected', () => {
    const r = validRun();
    r.creatives[0].critic = { pass: false, checks: [], unverified: true };
    expect(inv(r)).toContain('c1 critic verified');
  });
});

describe('expectations', () => {
  test('the #1 fixture run meets the #1 expectation', () => {
    const e = resolveNames().find((x) => x.sample === 1)!;
    expect(expectationChecks(e, validRun()).filter((c) => !c.pass)).toEqual([]);
  });
  test('an unknown publisher name fails fast at load, naming the row', () => {
    expect(() => resolveNames([{ ...EXPECTATIONS[0], recommended: ['Nowhere Co.'] }])).toThrow(/sample #1 recommended names "Nowhere Co\."/);
  });
  test('every drafted expectation resolves', () => {
    expect(resolveNames()).toHaveLength(15);
  });
});

describe('write-cache guard', () => {
  test('refuses on errors, unverified cards, or a dropped committed input', () => {
    const prev = { 'old input': '#1' };
    expect(writeGuard([{ label: '#1', errors: [], unverified: false }], prev, new Set(['old input']))).toEqual([]);
    expect(writeGuard([{ label: '#1', errors: ['critic:timeout'], unverified: false }], prev, new Set(['old input']))).toHaveLength(1);
    expect(writeGuard([{ label: '#1', errors: [], unverified: true }], prev, new Set(['old input']))).toHaveLength(1);
    expect(writeGuard([{ label: '#1', errors: [], unverified: false }], prev, new Set(['new input']))[0]).toMatch(/drop 1/);
  });
  test('a chip follow-up the sample no longer offers may drop; a sample may not', () => {
    const prev = { 'sample text': '#8', 'old chip text': '#8 chip: Old reading' };
    expect(writeGuard([], prev, new Set(['sample text', 'new chip text']))).toEqual([]);
    expect(writeGuard([], prev, new Set(['new chip text']))[0]).toMatch(/drop 1.*#8$/);
  });
  test('--write-cache with --bakeoff is refused before any work', () => {
    let code = 0;
    try {
      execFileSync('npx', ['tsx', '--conditions=react-server', 'scripts/eval.ts', '--write-cache', '--bakeoff'], { stdio: 'pipe', env: { ...process.env, OPENAI_API_KEY: '' } });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  }, 30_000);
});
