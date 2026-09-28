// Publisher funnel arithmetic (F4/F5/F6): gate × weights, bands, exclusion grouping, viability resolution. Pure.
import { audienceFit, priceFit } from './fit';
import type { AdvertiserProfile, Band, LlmPublisherDims, Publisher, PublisherScore, Viability } from './types';

export interface Weights {
  tone: number;
  audience: number;
  price: number;
}

/** Fixed after the grid search: 94% of weight and threshold sets pass every tuning check, so these are not load-bearing. */
export const WEIGHTS: Weights = { tone: 0.4, audience: 0.3, price: 0.3 };
/** Assumed price counts half (F5): the number is a guess, so its dimension should not decide a rank. */
export const ASSUMED_PRICE_WEIGHT_FACTOR = 0.5;
/** Category gate by LLM category_fit (F4). */
export const GATE: Record<number, number> = { 0: 0, 1: 0.2, 2: 0.5, 3: 0.8, 4: 1, 5: 1 };
export interface Thresholds {
  recommended: number;
  weak: number;
  /** Red flags (F28): any one caps a publisher at weak, however high its weighted score. */
  category_min: number;
  tone_min: number;
  /** Applies to stated prices only: price_fit 0.5 ≈ price within 2x the publisher's AOV (3x for high-income audiences). */
  price_min: number;
  near_miss: number;
}
export const THRESHOLDS: Thresholds = { recommended: 0.55, weak: 0.35, category_min: 3, tone_min: 3, price_min: 0.5, near_miss: 0.1 };

const GROUPS = { category: 'not their category', audience: 'audience mismatch', price: 'price mismatch', tone: 'tone mismatch' } as const;

export function effectiveWeights(base: Weights, priceBasis: 'stated' | 'assumed' | null): Weights {
  if (priceBasis === 'stated') return base;
  const price = base.price * ASSUMED_PRICE_WEIGHT_FACTOR;
  const total = base.tone + base.audience + price;
  return { tone: base.tone / total, audience: base.audience / total, price: price / total };
}

/** The red flag that keeps a publisher out of the recommended band, if any. */
function redFlag(categoryFit: number, toneFit: number, priceFit: number, priceStated: boolean, t: Thresholds): string | null {
  if (categoryFit < t.category_min) return `category fit ${categoryFit}/5`;
  if (toneFit < t.tone_min) return `tone fit ${toneFit}/5`;
  if (priceStated && priceFit < t.price_min) return 'price far above this audience\'s order value';
  return null;
}

function band(score: number, flag: string | null, t: Thresholds): Band {
  if (score >= t.recommended && !flag) return 'recommended';
  if (score >= t.weak) return 'weak';
  return 'excluded';
}

function lowestDimension(dims: { category: number; audience: number; price: number; tone: number }): string {
  let best: keyof typeof GROUPS = 'category';
  for (const k of Object.keys(GROUPS) as (keyof typeof GROUPS)[]) if (dims[k] < dims[best]) best = k;
  return GROUPS[best];
}

/** Publishers without an LLM dim entry are skipped; the caller validates completeness. */
export function scorePublishers(
  profile: AdvertiserProfile,
  publishers: Publisher[],
  llmDims: LlmPublisherDims[],
  similarity?: Record<string, number>,
  weights: Weights = WEIGHTS,
  thresholds: Thresholds = THRESHOLDS,
): PublisherScore[] {
  const w = effectiveWeights(weights, profile.price?.basis ?? null);
  const dimsById = new Map(llmDims.map((d) => [d.publisher_id, d]));
  const scores: PublisherScore[] = [];
  for (const pub of publishers) {
    const dims = dimsById.get(pub.id);
    if (!dims) continue;
    const audience = audienceFit(profile, pub);
    const price = priceFit(profile.price, pub);
    const gate = GATE[dims.category_fit] ?? 0;
    const tone = dims.tone_fit / 5;
    const score = gate * (w.tone * tone + w.audience * audience.fit + w.price * price.fit);
    const flag = redFlag(dims.category_fit, dims.tone_fit, price.fit, profile.price?.basis === 'stated', thresholds);
    const b = band(score, flag, thresholds);
    scores.push({
      publisher_id: pub.id,
      category_fit: dims.category_fit,
      tone_fit: dims.tone_fit,
      audience_fit: audience.fit,
      price_fit: price.fit,
      gate,
      score,
      band: b,
      reasons: { category: dims.reason, tone: `tone fit ${dims.tone_fit}/5`, audience: audience.reason, price: price.reason },
      exclusion_group:
        b === 'excluded' ? lowestDimension({ category: dims.category_fit / 5, audience: audience.fit, price: price.fit, tone }) : null,
      near_miss: b !== 'recommended' && score >= thresholds.recommended - thresholds.near_miss,
      capped_by: b === 'weak' && score >= thresholds.recommended ? flag : null,
      retrieval_similarity: similarity?.[pub.id] ?? null,
    });
  }
  return scores.sort((a, b) => b.score - a.score || a.publisher_id.localeCompare(b.publisher_id));
}

export function groupExclusions(scores: PublisherScore[]): { group: string; count: number; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const s of scores) {
    if (s.band !== 'excluded' || !s.exclusion_group) continue;
    groups.set(s.exclusion_group, [...(groups.get(s.exclusion_group) ?? []), s.publisher_id]);
  }
  return [...groups].map(([group, ids]) => ({ group, count: ids.length, ids })).sort((a, b) => b.count - a.count);
}

/** Cross-check the LLM verdict against the scores (F23): strong needs a recommended publisher; none is overruled by a ≥ 0.55 fit. */
export function resolveViability(
  llm: Viability,
  scores: PublisherScore[],
  thresholds: Thresholds = THRESHOLDS,
): { viability: Viability; flagged: boolean; message: string | null } {
  const recommended = scores.filter((s) => s.band === 'recommended');
  if (llm === 'strong' && recommended.length === 0) {
    return { viability: 'weak', flagged: false, message: 'No publisher clears the recommended bar; treating fit as weak.' };
  }
  if (llm === 'none') {
    const strong = scores.filter((s) => s.score >= thresholds.recommended);
    if (strong.length > 0) {
      return {
        viability: 'weak',
        flagged: true,
        message: `Model judged no viable fit, but ${strong.length} publisher(s) score ≥ ${thresholds.recommended} (${strong.map((s) => s.publisher_id).join(', ')}); shown as weak fits.`,
      };
    }
  }
  return { viability: llm, flagged: false, message: null };
}
