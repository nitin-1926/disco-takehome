import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import publishers from '@/data/publishers.json';
import personasJson from '@/data/shopper_personas.json';
import type { CampaignConfig, Creative, Persona, Publisher, Settings, Triage } from '@/lib/types';
import { buildConfig } from '@/lib/config';
import { scorePublishers } from '@/lib/funnel';
import { scorePersonas } from '@/lib/personas';
import { normalizeSettings } from '@/lib/settings';
import { personaJudgments, profiles, publisherDims, type SampleId } from './fixtures/llm-dims';

const pubs = publishers as Publisher[];
const personas = personasJson as Persona[];
const meta: CampaignConfig['meta'] = { run_id: 'test', generated_at: '2026-09-28T00:00:00Z', pipeline_version: 'u2', models: { sol: 'gpt-6-sol' } };
const id = (name: string) => pubs.find((p) => p.name === name)!.id;

function build(sample: SampleId, settings: Settings = normalizeSettings(), over: { triage?: Partial<Triage>; today?: string; creatives?: Creative[] } = {}) {
  const profile = profiles[sample];
  const publisherScores = scorePublishers(profile, pubs, publisherDims[sample]);
  const recommended = publisherScores.filter((s) => s.band === 'recommended').map((s) => s.publisher_id);
  const personaScores = scorePersonas(profile, personas, personaJudgments[sample], recommended);
  const triage: Triage = { ...profile.triage, ...over.triage };
  return buildConfig({
    profile, triage, settings, publisherScores, personaScores, creatives: over.creatives ?? [], publishers: pubs, meta, today: over.today ?? '2026-09-28',
  });
}

const sum = (c: CampaignConfig) => Math.round(c.placements.reduce((n, p) => n + p.allocation_usd, 0) * 100) / 100;

describe('static: config.ts is pure and browser-safe', () => {
  test('imports none of env, data, models, server-only, node builtins', () => {
    const src = readFileSync(path.resolve(__dirname, '../lib/config.ts'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/env|data|models|server-only|^node:|^fs$|^path$|process/);
    }
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/new Date\(\)/);
  });
});

describe('#1 full assembly', () => {
  const c = build(1);
  test('allocations sum to total_usd to the cent; 85/15 exploit-explore across recommended + weak', () => {
    expect(sum(c)).toBe(c.budget.total_usd);
    expect(c.budget.total_usd).toBe(10_000);
    const rec = c.placements.filter((p) => p.band === 'recommended');
    const weak = c.placements.filter((p) => p.band === 'weak');
    expect(rec.length).toBeGreaterThanOrEqual(2);
    expect(weak.length).toBeGreaterThanOrEqual(1);
    expect(rec.reduce((n, p) => n + p.share, 0)).toBeCloseTo(0.85, 6);
    expect(c.budget.explore_share).toBe(0.15);
    expect(c.placements[0].publisher_id).toBe(id('Pawline'));
    expect(c.placements[0].allocation_usd).toBeGreaterThan(c.placements[1].allocation_usd);
  });
  test('every guessed number has an assumptions entry with a source', () => {
    const fields = c.assumptions.map((a) => a.field);
    for (const f of ['price', 'bidding.fixed_cpa_usd', 'cvr_prior', 'budget.viability_factor', 'budget.explore_share', 'subscription_ltv_mult']) {
      expect(fields).toContain(f);
    }
    for (const a of c.assumptions) expect(a.source.length).toBeGreaterThan(0);
  });
  test('measurement, bidding, targeting shapes', () => {
    expect(c.bidding.fixed_cpa_usd).toBeCloseTo(31.5);
    expect(c.bidding.fixed_cpo_usd).toBe(0);
    expect(c.targeting.customer_type).toBe('new_only');
    expect(c.measurement.target_cpa_usd).toBe(c.bidding.fixed_cpa_usd);
    expect(c.measurement.target_roas).toBeCloseTo(70 / 31.5, 2);
    expect(c.measurement.attribution).toEqual({ click_days: 14, view_days: 14 });
    expect(c.measurement.expected_conversions_range[0]).toBeLessThanOrEqual(c.measurement.expected_conversions_range[1]);
    expect(c.campaign.objective).toBe('purchase');
    expect(c.flight.days).toBe(30);
    expect(c.budget.daily_cap_usd).toBeCloseTo(10_000 / 30, 2);
    expect(c.targeting.personas.length).toBeGreaterThanOrEqual(3);
    expect(c.targeting.geo).toBe('US');
  });
  test('exclusions come from the scores and constraints from recommended publishers\' notes', () => {
    const daily = c.exclusions.publishers.find((e) => e.id === id('Daily Form'))!;
    expect(daily.reason_group).toBe('not their category');
    expect(c.placements.every((p) => p.band !== 'excluded')).toBe(true);
    expect(c.exclusions.personas.length + c.personas.length).toBe(personas.length);
  });
  test('launch checklist covers landing URL, logo, images; promo code only with an offer', () => {
    expect(c.launch_checklist.join(' ')).toMatch(/landing/i);
    expect(c.launch_checklist.join(' ')).toMatch(/logo/i);
    expect(c.launch_checklist.join(' ')).toMatch(/image/i);
    expect(c.launch_checklist.join(' ')).not.toMatch(/promo/i);
    const withOffer = build(1, normalizeSettings({ offer: { type: 'pct_off', amount: 10, code: 'SENIOR10' } }));
    expect(withOffer.launch_checklist.join(' ')).toMatch(/SENIOR10/);
  });
  test('creative ids attach to placements by publisher', () => {
    const cr: Creative = {
      id: 'c1', persona_id: 'persona_004', angle: 'a', heading: 'h', subheading: 's', cta: 'Shop Now', offer: null, disclosure: null, claims_used: [],
      publisher_ids: [id('Pawline')], constraints_respected: [], critic: null, revised_from: null, char_counts: { heading: 1, subheading: 1 }, grounding_flags: [], error: null,
    };
    const withCreative = build(1, normalizeSettings(), { creatives: [cr] });
    expect(withCreative.placements.find((p) => p.publisher_id === id('Pawline'))!.creative_ids).toEqual(['c1']);
    expect(withCreative.placements.find((p) => p.publisher_id === id('Ruffco'))!.creative_ids).toEqual([]);
  });
});

describe('#4 seasonality', () => {
  test('flight start shifts to Nov 1 citing Heartfoot when today is before Nov 1', () => {
    const c = build(4, normalizeSettings(), { today: '2026-09-28' });
    expect(c.flight.start).toBe('2026-11-01');
    expect(c.flight.seasonality_note).toContain('Heartfoot');
    expect(c.assumptions.some((a) => a.field === 'flight.start' && a.source.includes('Heartfoot'))).toBe(true);
  });
  test('no shift once inside the season or when Nov 1 is far away', () => {
    expect(build(4, normalizeSettings(), { today: '2026-11-15' }).flight.start).toBe('2026-11-15');
    expect(build(4, normalizeSettings(), { today: '2026-02-01' }).flight.start).toBe('2026-02-01');
  });
  test('#1 has no seasonality note', () => {
    expect(build(1).flight.seasonality_note).toBeNull();
  });
});

describe('viability and budgets', () => {
  test('weak → 40% budget with a warning', () => {
    const c = build(10);
    expect(c.budget.viability_factor).toBe(0.4);
    expect(c.budget.total_usd).toBe(4000);
    expect(sum(c)).toBe(4000);
    expect(c.warnings.join(' ')).toMatch(/weak/i);
  });
  test('none → total 0, empty placements, warning', () => {
    const c = build(10, normalizeSettings(), { triage: { viability: 'none' } });
    expect(c.budget.total_usd).toBe(0);
    expect(c.placements).toEqual([]);
    expect(c.budget.daily_cap_usd).toBe(0);
    expect(c.exclusions.publishers.length).toBeGreaterThan(0);
  });
  test('budget $200 vs CPA $360 → placements kept, conversions within [0,1], warning', () => {
    const c = build(10, normalizeSettings({ budgetUsd: 200 }), { triage: { viability: 'strong' } });
    expect(c.bidding.fixed_cpa_usd).toBe(360);
    expect(c.placements.length).toBeGreaterThanOrEqual(2);
    expect(sum(c)).toBe(200);
    for (const p of c.placements) {
      expect(p.conversions_range[0]).toBeGreaterThanOrEqual(0);
      expect(p.conversions_range[1]).toBeLessThanOrEqual(1);
    }
    expect(c.warnings.join(' ')).toMatch(/below one target CPA|fewer than 50|below 50/i);
  });
  test('$500k → inventory cap binds and shares redistribute; sum still exact', () => {
    const c = build(4, normalizeSettings({ budgetUsd: 500_000 }));
    const heart = c.placements.find((p) => p.publisher_id === id('Heartfoot'))!;
    expect(heart.inventory_used_pct).toBe(100);
    expect(heart.share).toBeLessThan(0.85);
    expect(c.placements.filter((p) => p.band === 'weak').reduce((n, p) => n + p.share, 0)).toBeGreaterThan(0.15);
    expect(sum(c)).toBe(c.budget.total_usd);
    expect(c.placements.reduce((n, p) => n + p.share, 0)).toBeCloseTo(1, 6);
    expect(heart.conversions_range[0]).toBeLessThan(heart.conversions_range[1]);
  });
  test('caps binding over several rounds never strand budget: a cap warning only when every placement is full', () => {
    const samples: SampleId[] = [1, 4, 9, 13, 14];
    for (const sample of samples) {
      for (const budgetUsd of [50_000, 250_000, 500_000, 3_000_000]) {
        for (const durationDays of [7, 30]) {
          const c = build(sample, normalizeSettings({ budgetUsd, durationDays }));
          const capped = c.warnings.some((w) => w.startsWith('Inventory caps'));
          for (const p of c.placements) expect(p.allocation_usd).toBeGreaterThanOrEqual(0);
          if (capped) for (const p of c.placements) expect(p.inventory_used_pct).toBeGreaterThanOrEqual(99.9);
          else expect(c.budget.total_usd).toBe(budgetUsd * c.budget.viability_factor);
          expect(sum(c)).toBe(c.budget.total_usd);
        }
      }
    }
  });
  test('the 5% floor keeps each pool at its share: explore stays 15% when no cap binds', () => {
    for (const sample of [1, 4, 9, 13, 14] as SampleId[]) {
      const c = build(sample);
      if (c.warnings.some((w) => w.startsWith('Inventory caps'))) continue;
      const weak = c.placements.filter((p) => p.band === 'weak').reduce((n, p) => n + p.allocation_usd, 0);
      expect(c.budget.explore_share).toBe(weak > 0 ? 0.15 : 0);
    }
  });
  test('shares under 5% are dropped and redistributed only while ≥ 2 placements remain', () => {
    const c = build(4);
    expect(c.placements.length).toBeGreaterThanOrEqual(2);
    for (const p of c.placements) expect(p.share).toBeGreaterThanOrEqual(0.05);
    expect(sum(c)).toBe(c.budget.total_usd);
  });
  test('#6 with no recommended publisher still places on the best weak fits', () => {
    const c = build(6);
    expect(c.placements.length).toBeGreaterThanOrEqual(1);
    expect(c.budget.explore_share).toBe(0);
    expect(sum(c)).toBe(c.budget.total_usd);
  });
  test('unplaced publishers say why: outside the weak test pool, never "no budget" or "below 5%" by default', () => {
    const profile = profiles[6];
    // Six weak fits and no recommended one: three get the test budget, three are outside the pool.
    const publisherScores = scorePublishers(profile, pubs, publisherDims[6]).map((s, i) => (i < 6 ? { ...s, band: 'weak' as const, exclusion_group: null, score: 0.5 - i * 0.01 } : s));
    const c = buildConfig({ profile, triage: profile.triage, settings: normalizeSettings(), publisherScores, personaScores: [], creatives: [], publishers: pubs, meta, today: '2026-09-28' });
    expect(c.placements).toHaveLength(3);
    expect(c.exclusions.publishers.filter((e) => e.reason_group === 'outside the 3 best weak fits')).toHaveLength(3);
  });
  test('a starting bid range brackets the fixed CPA', () => {
    const c = build(1);
    const [lo, hi] = c.bidding.cpa_range_usd;
    expect(lo).toBeLessThan(c.bidding.fixed_cpa_usd);
    expect(hi).toBeGreaterThan(c.bidding.fixed_cpa_usd);
  });
  test('#13 price-led advertiser gets a CPC alternative and its assumption', () => {
    const c = build(13);
    expect(c.bidding.cpc_alternative).not.toBeNull();
    expect(c.assumptions.some((a) => a.field === 'bidding.cpc_alternative')).toBe(true);
  });
  test('sums are exact across many budgets (rounding fixed on the largest placement)', () => {
    for (const b of [333, 999.99, 12_345.67, 77_777, 1_000_003]) {
      const c = build(1, normalizeSettings({ budgetUsd: b }));
      expect(sum(c)).toBe(c.budget.total_usd);
    }
  });
});

describe('weak-fit test budget', () => {
  test('with nothing recommended, the test budget goes to the three best weak fits only', () => {
    const profile = profiles[6];
    const scores = scorePublishers(profile, pubs, publisherDims[6]).map((s) => (s.band === 'recommended' ? { ...s, band: 'weak' as const } : s));
    const weak = scores.filter((s) => s.band === 'weak');
    const cfg = buildConfig({ profile, triage: { ...profile.triage, viability: 'weak' }, settings: normalizeSettings(), publisherScores: scores, personaScores: [], creatives: [], publishers: pubs, meta, today: '2026-09-28' });
    expect(cfg.placements.length).toBeLessThanOrEqual(3);
    expect(cfg.placements.map((p) => p.publisher_id)).toEqual(weak.slice(0, cfg.placements.length).map((s) => s.publisher_id));
    expect(sum(cfg)).toBeCloseTo(cfg.budget.total_usd, 2);
  });
});
