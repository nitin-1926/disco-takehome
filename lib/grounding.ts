// Regex grounding before the critic (F3, R7): claims_used ids, numbers/%/$ against facts, discount and claim words, Disco limits. Pure.
import { CTA_PRESETS, type Creative, type Fact, type Offer } from './types';

export const LIMITS = { heading: 50, subheading: 175 } as const;

const DISCOUNT_WORDS: { re: RegExp; allowedFor: Offer['type'][] }[] = [
  { re: /\bfree shipping\b/gi, allowedFor: ['free_shipping'] },
  { re: /\bbogo\b/gi, allowedFor: ['bogo'] },
  // "off" only in a price context ("20% off", "$10 off", "off your first order"); "off your to-do list" is not a discount.
  { re: /(?:\d\s?%|\$\s?\d[\d,.]*)\s*off\b|\boff\s+(?:your\s+)?(?:first\s+)?(?:order|purchase)\b/gi, allowedFor: ['pct_off', 'fixed_off', 'bogo', 'free_gift'] },
  { re: /\b(discount|save)\b/gi, allowedFor: ['pct_off', 'fixed_off', 'bogo', 'free_gift'] },
];
const CLAIM_WORDS = /\b(clinically|proven|guaranteed|best)\b|#1/gi;
/** Disco's copy rules that need no reading: friction words, exclamation marks, emoji. */
const COPY_RULES = /\b(apply|sign up|register|learn more)\b|!|\p{Extended_Pictographic}/giu;
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/g;
const PERCENT = /\d+(?:\.\d+)?\s?%/g;
// Thousands-grouped numbers first ("10,000" is one number, not "10").
const BARE_NUMBER = /(?<![\d.,$#])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d.,]*%)/g;

const toNumber = (s: string) => Number(s.replace(/[$,%\s]/g, ''));

type Grounded = Pick<Creative, 'heading' | 'subheading' | 'cta' | 'claims_used' | 'disclosure'>;

/** Fact ids, plus "offer" when there is one (the creative prompt asks the model to cite it that way). */
export function validateClaims(creative: Pick<Creative, 'claims_used'>, facts: Fact[], offer: Offer | null = null): string[] {
  const ids = new Set(facts.map((f) => f.id));
  if (offer) ids.add('offer');
  return creative.claims_used.filter((id) => !ids.has(id)).map((id) => `claims_used references unknown fact "${id}"`);
}

/** Numbers, percentages, dollar amounts, discount words and claim words that neither the facts nor the offer justify. */
export function regexFlags(rawText: string, facts: Fact[], offer: Offer | null): string[] {
  const flags: string[] = [];
  // The promo code is quoted verbatim; its digits ("WELCOME15") are not a claim.
  const text = offer?.code ? rawText.split(offer.code).join(' ') : rawText;
  const factText = facts.map((f) => f.text).join('\n').toLowerCase();
  const knownNumbers = new Set<number>();
  for (const m of factText.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) knownNumbers.add(toNumber(m));
  if (offer?.amount != null) knownNumbers.add(offer.amount);

  for (const re of [MONEY, PERCENT, BARE_NUMBER]) {
    for (const m of text.match(re) ?? []) {
      if (!knownNumbers.has(toNumber(m))) flags.push(`number "${m.trim()}" not in facts or offer`);
    }
  }
  for (const { re, allowedFor } of DISCOUNT_WORDS) {
    for (const m of text.match(re) ?? []) {
      const justified = (offer && allowedFor.includes(offer.type)) || factText.includes(m.toLowerCase());
      if (!justified) flags.push(`discount word "${m}" without a matching offer`);
    }
  }
  for (const m of text.match(CLAIM_WORDS) ?? []) {
    if (!factText.includes(m.toLowerCase())) flags.push(`claim word "${m}" not in facts`);
  }
  for (const m of text.match(COPY_RULES) ?? []) flags.push(`"${m}" breaks Disco's copy rules`);
  return flags;
}

export function checkLimits(creative: Pick<Creative, 'heading' | 'subheading' | 'cta'>): string[] {
  const flags: string[] = [];
  if (creative.heading.length > LIMITS.heading) flags.push(`heading is ${creative.heading.length} chars (max ${LIMITS.heading})`);
  if (creative.subheading.length > LIMITS.subheading) flags.push(`subheading is ${creative.subheading.length} chars (max ${LIMITS.subheading})`);
  if (!(CTA_PRESETS as readonly string[]).includes(creative.cta)) flags.push(`cta "${creative.cta}" is not a Disco preset`);
  return flags;
}

export function groundCreative(creative: Grounded, facts: Fact[], offer: Offer | null): { ok: boolean; flags: string[] } {
  const text = [creative.heading, creative.subheading, creative.disclosure ?? ''].join('\n');
  const flags = [...validateClaims(creative, facts, offer), ...regexFlags(text, facts, offer), ...checkLimits(creative)];
  return { ok: flags.length === 0, flags };
}

/** Two headlines that say the same thing ("A gift that feels considered" / "Give a gift that feels considered"):
 * word-set overlap of 75% or more. Cards are written one per call, so no single call can see its siblings. */
export function sameHeading(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= 0.75;
}

