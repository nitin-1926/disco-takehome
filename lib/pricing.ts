// CPA-first pricing with eCPM derived (decisions #9, F7, F21). Every constant is an estimate; sources beside each. Pure.
import { money, priceMidpoint } from './fit';
import type { AdvertiserProfile, ConversionEvent } from './types';

/** Target CPA as a share of first-order price. TGM DTC benchmark: healthy CPA is 25-40% of first-order AOV. */
export const CPA_SHARE_OF_PRICE = 0.3;
export const CPA_SHARE_BAND: [number, number] = [0.25, 0.4];
/** Subscription first orders carry LTV, so a higher CPA is tolerable. Assumption. */
export const SUBSCRIPTION_LTV_MULT = 1.5;
/** Flat CPA for an email/account signup. Assumption (lead-gen range $5-15). */
export const SIGNUP_CPA_USD = 8;
/**
 * Post-checkout conversions per impression, prior and band.
 * Derived: Rokt reports publisher yield of $0.30-0.80 per transaction ≈ CVR × CPA × publisher share; with CPA ≈ $20-40
 * and a ~50% share that solves to 0.5-2%; capped by Rokt's 5.6% engagement rate. Decayed by fit and AOV/price.
 */
export const CVR_PRIOR = 0.01;
export const CVR_BAND: [number, number] = [0.005, 0.02];
/** Fallback price midpoint by tier when the profile has no price at all. Assumption. */
export const TIER_PRICE_USD: Record<AdvertiserProfile['price_tier'], number> = { budget: 25, mid: 60, premium: 150, luxury: 500 };
/** CPC = CPA × click-to-purchase rate; 2-5% post-checkout click-to-purchase. Assumption. */
export const CLICK_TO_PURCHASE_BAND: [number, number] = [0.02, 0.05];

const PRICE_LED = /\b(price|value|cheap|afford\w*|cost|budget|deal)\b/i;

export function priceMid(profile: AdvertiserProfile): { value: number; basis: 'stated' | 'assumed' | 'tier_default' } {
  if (profile.price) return { value: priceMidpoint(profile.price), basis: profile.price.basis };
  return { value: TIER_PRICE_USD[profile.price_tier], basis: 'tier_default' };
}

export function targetCpa(profile: AdvertiserProfile, event: ConversionEvent): { cpa: number; basis: string } {
  if (event === 'signup') return { cpa: SIGNUP_CPA_USD, basis: `signup constant ${money(SIGNUP_CPA_USD)} (assumption)` };
  const price = priceMid(profile);
  const priceWhy = price.basis === 'tier_default' ? `${profile.price_tier}-tier default price ${money(price.value)}` : `${price.basis} price ${money(price.value)}`;
  const ltv = event === 'subscription' || profile.is_subscription;
  const cpa = price.value * CPA_SHARE_OF_PRICE * (ltv ? SUBSCRIPTION_LTV_MULT : 1);
  return {
    cpa: Math.round(cpa * 100) / 100,
    basis: `${Math.round(CPA_SHARE_OF_PRICE * 100)}% of ${priceWhy}${ltv ? ` × ${SUBSCRIPTION_LTV_MULT} subscription LTV` : ''}`,
  };
}

/** Prior decayed by fit and by how far the price sits above the publisher's AOV. */
export function effectiveCvr(prior: number, score: number, aov: number, price: number): number {
  return prior * score * Math.min(1, aov / price);
}

/** Suggested when the advertiser competes on price (R2). */
export function cpcAlternative(profile: AdvertiserProfile): { min_usd: number; max_usd: number; optimization_target: 'roas' | 'cpa' } | null {
  const priceLed = profile.price_tier === 'budget' || PRICE_LED.test([...profile.values, profile.tone].join(' '));
  if (!priceLed) return null;
  const { cpa } = targetCpa(profile, 'purchase');
  return {
    min_usd: Math.round(cpa * CLICK_TO_PURCHASE_BAND[0] * 100) / 100,
    max_usd: Math.round(cpa * CLICK_TO_PURCHASE_BAND[1] * 100) / 100,
    optimization_target: 'cpa',
  };
}
