// Code-scored structured dimensions (decisions #5, R7): age, gender, income, price. Pure; reasons quote real numbers.
import type { AdvertiserProfile, Publisher } from './types';

export interface AgeRange {
  low: number;
  high: number;
}

type Price = AdvertiserProfile['price'];

export const PRICE_FIT_FLOOR = 0.3;
export const PRICE_FIT_NEUTRAL = 0.7;
/** High-income audiences recover this share of the gap between the floor fit and 1. */
const HIGH_INCOME_SOFTEN = 0.25;
/** age_skew is a skew, not a bound: zero overlap still leaves some buyers. */
export const AGE_SOFT_FLOOR = 0.4;

const PRICE_TIER_IDX: Record<AdvertiserProfile['price_tier'], number> = { budget: 0, mid: 1, premium: 2, luxury: 3 };
const INCOME_IDX: Record<string, number> = { low: 0, mid: 1, 'mid-high': 2, high: 3 };
/** Fit by how many tiers the price sits above the audience's income tier. */
const INCOME_GAP_FIT = [1, 0.7, 0.4, 0.2];
/** Female share implied by a persona gender_skew label. */
const PERSONA_FEMALE_SHARE: Record<string, number> = { female: 0.85, 'female-leaning': 0.65, balanced: 0.5, 'male-leaning': 0.35, male: 0.15 };

export const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
export const priceMidpoint = (p: NonNullable<Price>) => (p.low + p.high) / 2;

/** "45-65" → {45, 65}; anything else ("nationwide", "balanced") → null. */
export function parseAgeRange(s: string): AgeRange | null {
  const m = /^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  const low = Number(m[1]);
  const high = Number(m[2]);
  return high >= low ? { low, high } : null;
}

/** Fraction of the buyer age range (inclusive years) that the audience range covers. Unknown either side → 1. */
export function ageOverlap(buyer: AgeRange | null, audience: AgeRange | null): number {
  if (!buyer || !audience) return 1;
  const lo = Math.max(buyer.low, audience.low);
  const hi = Math.min(buyer.high, audience.high);
  if (hi < lo) return 0;
  return (hi - lo + 1) / (buyer.high - buyer.low + 1);
}

/** Share of an audience that matches the buyer gender. Balanced or unspecified buyers match everyone. */
export function genderFit(buyer: AdvertiserProfile['buyer_gender'], female: number, male: number): number {
  if (buyer === 'female') return 1 - male;
  if (buyer === 'male') return 1 - female;
  return 1;
}

export function personaFemaleShare(skew: string): number {
  return PERSONA_FEMALE_SHARE[skew] ?? 0.5;
}

export function incomeFit(tier: AdvertiserProfile['price_tier'], income: string): number {
  const i = INCOME_IDX[income];
  if (i === undefined) return PRICE_FIT_NEUTRAL;
  const gap = PRICE_TIER_IDX[tier] - i;
  return gap <= 0 ? 1 : INCOME_GAP_FIT[Math.min(gap, INCOME_GAP_FIT.length - 1)];
}

export function audienceFit(profile: AdvertiserProfile, pub: Publisher): { fit: number; reason: string } {
  const { audience } = pub;
  const overlap = ageOverlap(profile.buyer_age, parseAgeRange(audience.age_skew));
  const age = AGE_SOFT_FLOOR + (1 - AGE_SOFT_FLOOR) * overlap;
  const gender = genderFit(profile.buyer_gender, audience.gender_split.female, audience.gender_split.male);
  const income = incomeFit(profile.price_tier, audience.income_tier);
  // Plain words, only the parts that cost something: this line is what an advertiser reads under an exclusion.
  const parts = [
    profile.buyer_age && overlap < 1
      ? `their shoppers are ${audience.age_skew}, your buyers ${profile.buyer_age.low}-${profile.buyer_age.high} (${Math.round(overlap * 100)}% overlap)`
      : null,
    profile.buyer_gender === 'female' || profile.buyer_gender === 'male' ? `${Math.round(gender * 100)}% of their shoppers are ${profile.buyer_gender === 'female' ? 'women' : 'men'}` : null,
    income < 1 ? `${audience.income_tier}-income shoppers for a ${profile.price_tier}-priced product` : null,
  ].filter((x): x is string => x !== null);
  const reason = parts.length
    ? parts.join('; ').replace(/^./, (c) => c.toUpperCase())
    : `Their shoppers (${audience.age_skew}, ${audience.income_tier} income) match on age, gender and income`;
  return { fit: age * gender * income, reason };
}

/** Asymmetric: at or under AOV is a full fit; above decays as 1/ratio to a floor, softened for high-income audiences. */
export function priceFit(price: Price, pub: Publisher): { fit: number; reason: string } {
  if (!price) return { fit: PRICE_FIT_NEUTRAL, reason: 'No price given, so price is scored as neutral' };
  const mid = priceMidpoint(price);
  const aov = pub.avg_order_value_usd;
  const ratio = mid / aov;
  if (ratio <= 1) return { fit: 1, reason: `Your ${money(mid)} order is within what ${pub.name}'s shoppers usually spend (${money(aov)})` };
  let fit = Math.max(PRICE_FIT_FLOOR, 1 / ratio);
  const high = pub.audience.income_tier === 'high';
  if (high) fit += (1 - fit) * HIGH_INCOME_SOFTEN;
  const reason = `Your ${money(mid)} order is ${ratio.toFixed(1)}x what ${pub.name}'s shoppers usually spend (${money(aov)})${high ? '; a high-income audience softens that' : ''}`;
  return { fit, reason };
}
