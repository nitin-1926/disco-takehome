import { describe, expect, test } from 'vitest';
import { containsSpan, finalizeProfile, runMode } from '@/lib/profile';
import type { UnderstandOutput } from '@/prompts/understand';

const base: UnderstandOutput = {
  primary_category: 'pet_food',
  subcategories: ['subscription'],
  product: 'premium dog food for senior dogs',
  price: { low: 60, high: 80, basis: 'assumed' },
  price_tier: 'premium',
  is_subscription: true,
  buyer_age: null,
  buyer_gender: 'unspecified',
  values: ['health', 'longevity'],
  tone: 'caring, expert',
  facts: [
    { id: 'f1', text: 'Grain-free' },
    { id: 'f2', text: 'clinically proven' },
  ],
  assumptions: [{ field: 'price', value: '$60-80', why: 'premium dog food subscription' }],
  triage: { clarity: 'clear', viability: 'strong', policy_banned: false, reason: 'Pet food sells on pet publishers.' },
  chips: [],
};
const input = 'We sell premium dog food for senior dogs. Grain-free, vet-formulated, subscription-based.';

describe('finalizeProfile', () => {
  test('keeps only verbatim facts and renumbers them', () => {
    const p = finalizeProfile(base, input);
    expect(p.facts).toEqual([{ id: 'f1', text: 'Grain-free' }]);
  });

  test('chips must quote a real span; none left → no_signal', () => {
    const vague: UnderstandOutput = {
      ...base,
      triage: { ...base.triage, clarity: 'vague' },
      chips: [
        { label: 'Wellness app', text: 'A meditation app.', quote: 'feel better' },
        { label: 'Invented', text: 'A gym.', quote: 'fitness studio' },
      ],
    };
    const p = finalizeProfile(vague, 'We help people feel better.');
    expect(p.chips.map((c) => c.label)).toEqual(['Wellness app']);
    expect(p.triage.clarity).toBe('vague');
    const none = finalizeProfile({ ...vague, chips: [vague.chips[1]] }, 'We help people feel better.');
    expect(none.triage.clarity).toBe('no_signal');
    expect(none.chips).toEqual([]);
  });

  test('chips are discarded when clarity is clear', () => {
    const p = finalizeProfile({ ...base, chips: [{ label: 'x', text: 'y', quote: 'dog food' }] }, input);
    expect(p.chips).toEqual([]);
  });

  test('policy ban needs both the model flag and a hard-category keyword', () => {
    const flagged = { ...base, triage: { ...base.triage, policy_banned: true } };
    expect(finalizeProfile(flagged, 'Non-alcoholic sparkling drink, a cocktail alternative').triage.policy_banned).toBe(false);
    expect(finalizeProfile(flagged, 'Premium nicotine pouches').triage.policy_banned).toBe(true);
    for (const input of ['Disposable vapes, fruit flavours', 'Handguns and rifles for home defense', 'Cannabis gummies, 10mg', 'E-cigarettes and pods', 'Prescriptions delivered in a day', 'Compounded semaglutide shots', 'Premium cigarettes']) {
      expect(finalizeProfile(flagged, input).triage.policy_banned, input).toBe(true);
    }
    expect(finalizeProfile(flagged, 'Chef knives forged in Seki').triage.policy_banned).toBe(false);
  });

  test('nonsense price or age ranges become null', () => {
    const p = finalizeProfile({ ...base, price: { low: 80, high: 20, basis: 'assumed' }, buyer_age: { low: 40, high: 20 } }, input);
    expect(p.price).toBeNull();
    expect(p.buyer_age).toBeNull();
  });

  test('runMode: full / score_only for clear×none / stop for banned, no_signal, vague', () => {
    expect(runMode(finalizeProfile(base, input)).mode).toBe('full');
    expect(runMode(finalizeProfile({ ...base, triage: { ...base.triage, viability: 'none' } }, input)).mode).toBe('score_only');
    expect(runMode(finalizeProfile({ ...base, triage: { ...base.triage, clarity: 'no_signal' } }, input)).mode).toBe('stop');
    expect(runMode(finalizeProfile({ ...base, triage: { ...base.triage, clarity: 'vague' }, chips: [{ label: 'a', text: 'b', quote: 'dog food' }] }, input)).mode).toBe('stop');
    expect(runMode(finalizeProfile({ ...base, triage: { ...base.triage, policy_banned: true } }, 'nicotine pouches')).mode).toBe('stop');
  });

  test('containsSpan is whitespace- and case-insensitive', () => {
    expect(containsSpan('Made  in\nPortugal', 'made in portugal')).toBe(true);
    expect(containsSpan('Made in Portugal', '')).toBe(false);
  });
});
