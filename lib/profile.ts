import type { AdvertiserProfile } from './types';
import type { UnderstandOutput } from '../prompts/understand';

// Code checks on the understand output. Pure, so the CLI, pipeline and tests share them.

// The categories the understand prompt bans (weapons, prescription drugs, nicotine and vaping, cannabis), with the
// plurals and everyday names people actually type. It only confirms the model's flag, so a broad word costs nothing
// unless the model also calls the input banned.
const POLICY_KEYWORDS =
  /\b(?:firearms?|(?:hand|shot)?guns?|rifles?|pistols?|revolvers?|ammo|ammunition|weapons?|prescriptions?|rx(?:-only)?|semaglutide|tirzepatide|ozempic|wegovy|glp-?1|nicotine|vapes?|vaping|vapou?rs?|e-?cigs?|e-?cigarettes?|e-?liquids?|cigarettes?|cigars?|tobacco|cannabis|marijuana|weed|thc|delta-?[89])\b/i;

export function containsSpan(input: string, quote: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const q = norm(quote);
  return q.length > 0 && norm(input).includes(q);
}

/** Apply the mechanical rules the prompt cannot be trusted with. */
export function finalizeProfile(raw: UnderstandOutput, input: string): AdvertiserProfile {
  // Chips must quote real input; otherwise they are inventions.
  const chips = raw.chips.filter((c) => containsSpan(input, c.quote)).slice(0, 3);
  let clarity = raw.triage.clarity;
  if (clarity === 'vague' && chips.length === 0) clarity = 'no_signal';
  if (clarity !== 'vague') chips.length = 0;

  // Facts must be verbatim spans too; drop the ones that are not.
  const facts = raw.facts.filter((f) => containsSpan(input, f.text)).map((f, i) => ({ id: `f${i + 1}`, text: f.text }));

  // Policy ban is the model's call, confirmed by a keyword list for the hard categories.
  const policy_banned = raw.triage.policy_banned && POLICY_KEYWORDS.test(input);

  const price = raw.price && raw.price.low > 0 && raw.price.high >= raw.price.low ? raw.price : null;

  return {
    input,
    primary_category: raw.primary_category,
    subcategories: raw.subcategories,
    product: raw.product,
    price,
    price_tier: raw.price_tier,
    is_subscription: raw.is_subscription,
    buyer_age: raw.buyer_age && raw.buyer_age.low > 0 && raw.buyer_age.high >= raw.buyer_age.low ? raw.buyer_age : null,
    buyer_gender: raw.buyer_gender,
    values: raw.values,
    tone: raw.tone,
    facts,
    assumptions: raw.assumptions,
    triage: { ...raw.triage, clarity, policy_banned },
    chips,
  };
}

export type RunMode = 'stop' | 'score_only' | 'full';

/**
 * What happens after Stage 1.
 * stop: nothing else runs (banned, no signal, or vague → chips).
 * score_only: clear but the catalog cannot serve it → score so the exclusions can be shown, then $0; no personas or creatives.
 * full: everything.
 */
export function runMode(profile: AdvertiserProfile): { mode: RunMode; why: string } {
  const t = profile.triage;
  if (t.policy_banned) return { mode: 'stop', why: 'Disco does not run this category.' };
  if (t.clarity === 'no_signal') return { mode: 'stop', why: 'No product or buyer can be named from the input.' };
  if (t.clarity === 'vague') return { mode: 'stop', why: 'Pick an interpretation to continue.' };
  if (t.viability === 'none') return { mode: 'score_only', why: 'No publisher in this catalog can serve this; showing why each was excluded.' };
  return { mode: 'full', why: '' };
}
