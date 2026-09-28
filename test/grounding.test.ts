import { describe, expect, test } from 'vitest';
import type { Creative, Fact, Offer } from '@/lib/types';
import { checkLimits, groundCreative, regexFlags, sameHeading, validateClaims } from '@/lib/grounding';

const facts: Fact[] = [
  { id: 'f1', text: 'Custom-fit leather handbags, Italian-made, handcrafted in Florence' },
  { id: 'f2', text: 'Minimum order ships in 6 weeks' },
  { id: 'f3', text: 'Average price point $1,200' },
];

function creative(over: Partial<Creative> = {}): Creative {
  return {
    id: 'c1', persona_id: 'persona_005', angle: 'craft', heading: 'Handcrafted in Florence', subheading: 'Custom-fit leather, made to your measurements.',
    cta: 'Shop Now', offer: null, disclosure: null, claims_used: ['f1'], publisher_ids: [], constraints_respected: [], critic: null, revised_from: null,
    char_counts: { heading: 0, subheading: 0 }, grounding_flags: [], error: null, ...over,
  };
}

describe('validateClaims', () => {
  test('every claims_used id must exist', () => {
    expect(validateClaims(creative({ claims_used: ['f1', 'f2'] }), facts)).toEqual([]);
    expect(validateClaims(creative({ claims_used: ['f9'] }), facts)[0]).toContain('f9');
  });
  test('"offer" is a valid claim only when an offer exists (the creative prompt asks for it)', () => {
    const offer: Offer = { type: 'pct_off', amount: 15, code: null };
    expect(validateClaims(creative({ claims_used: ['f1', 'offer'] }), facts, offer)).toEqual([]);
    expect(validateClaims(creative({ claims_used: ['f1', 'offer'] }), facts, null)[0]).toContain('offer');
  });
});

describe('regexFlags', () => {
  test('flags "clinically proven" and "20% off" absent from facts and offer', () => {
    const flags = regexFlags('Clinically proven leather. 20% off today.', facts, null);
    expect(flags.some((f) => /clinically/i.test(f))).toBe(true);
    expect(flags.some((f) => /proven/i.test(f))).toBe(true);
    expect(flags.some((f) => /20%/.test(f))).toBe(true);
    expect(flags.some((f) => /\boff\b/i.test(f))).toBe(true);
  });
  test('passes them when present in facts or offer', () => {
    const offer: Offer = { type: 'pct_off', amount: 20, code: 'FLORENCE20' };
    const f = [...facts, { id: 'f4', text: 'clinically proven' }];
    expect(regexFlags('Clinically proven. 20% off with FLORENCE20.', f, offer)).toEqual([]);
  });
  test('a thousands-grouped number is one number; promo code digits are not a claim', () => {
    const f: Fact[] = [{ id: 'f1', text: 'Trusted by 10,000 dog owners' }];
    expect(regexFlags('Join 10,000 dog owners.', f, null)).toEqual([]);
    expect(regexFlags('Join 12,000 dog owners.', f, null).some((x) => x.includes('12,000'))).toBe(true);
    expect(regexFlags('20% off with code WELCOME15.', f, { type: 'pct_off', amount: 20, code: 'WELCOME15' })).toEqual([]);
  });
  test('friction words, exclamation marks and emoji break the copy rules', () => {
    expect(regexFlags('Sign up today!', facts, null).filter((f) => f.includes('copy rules'))).toHaveLength(2);
    expect(regexFlags('Treat yourself 🎉', facts, null).some((f) => f.includes('copy rules'))).toBe(true);
    expect(regexFlags('Handcrafted in Florence', facts, null)).toEqual([]);
  });
  test('numbers in facts pass; numbers not in facts flag; dollar amounts normalised', () => {
    expect(regexFlags('Ships in 6 weeks. From $1200.', facts, null)).toEqual([]);
    expect(regexFlags('Ships in 3 weeks.', facts, null).some((f) => f.includes('3'))).toBe(true);
    expect(regexFlags('Only $899', facts, null).some((f) => f.includes('$899'))).toBe(true);
  });
  test('discount words need an offer of the matching kind', () => {
    expect(regexFlags('Free shipping on every order', facts, null)).not.toEqual([]);
    expect(regexFlags('Free shipping on every order', facts, { type: 'free_shipping', amount: null, code: null })).toEqual([]);
    expect(regexFlags('Save big', facts, { type: 'free_shipping', amount: null, code: null })).not.toEqual([]);
    expect(regexFlags('BOGO this week', facts, { type: 'bogo', amount: null, code: null })).toEqual([]);
  });
  test('claim words: guaranteed, #1, best', () => {
    const flags = regexFlags('The #1 guaranteed best bag', facts, null);
    expect(flags.length).toBe(3);
  });
  test('"off" counts only in a price context', () => {
    expect(regexFlags('Take senior dog food off your to-do list', facts, null)).toEqual([]);
    expect(regexFlags('$10 off your first order', facts, null).some((f) => f.includes('discount word'))).toBe(true);
    expect(regexFlags('Get it off your first order', facts, null).some((f) => f.includes('discount word'))).toBe(true);
  });
  test('"grain-free" is not a discount word', () => {
    expect(regexFlags('Grain-free, vet-formulated', [{ id: 'f', text: 'Grain-free, vet-formulated' }], null)).toEqual([]);
  });
});

describe('sameHeading', () => {
  test('catches repeats and near-repeats, not headlines that merely share a word or two', () => {
    expect(sameHeading('One less thing to remember', 'One less thing to remember')).toBe(true);
    expect(sameHeading('A gift that feels considered', 'Give a gift that feels considered')).toBe(true);
    expect(sameHeading('A more considered bedroom', 'A more considered wind-down')).toBe(false);
    expect(sameHeading('Keep your routine consistent', 'Keep your routine, cut the cost')).toBe(false);
  });
});

describe('checkLimits', () => {
  test('51-char heading flagged; 50 passes', () => {
    expect(checkLimits(creative({ heading: 'x'.repeat(51) }))).toHaveLength(1);
    expect(checkLimits(creative({ heading: 'x'.repeat(50) }))).toHaveLength(0);
  });
  test('subheading > 175 and unknown CTA flagged', () => {
    expect(checkLimits(creative({ subheading: 'y'.repeat(176) }))).toHaveLength(1);
    expect(checkLimits(creative({ cta: 'Buy now' as Creative['cta'] }))).toHaveLength(1);
  });
});

describe('groundCreative', () => {
  test('clean creative passes', () => {
    expect(groundCreative(creative(), facts, null)).toEqual({ ok: true, flags: [] });
  });
  test('collects flags from claims, regex and limits', () => {
    const r = groundCreative(creative({ heading: 'Clinically proven', claims_used: ['nope'], subheading: 'z'.repeat(180) }), facts, null);
    expect(r.ok).toBe(false);
    expect(r.flags.length).toBeGreaterThanOrEqual(3);
  });
  test('disclosure text is checked too', () => {
    expect(groundCreative(creative({ disclosure: '30% off ends Sunday' }), facts, null).ok).toBe(false);
  });
});
