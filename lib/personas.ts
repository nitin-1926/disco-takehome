// Persona scoring and pick (F2): code dims + LLM fit/conflicts → floor, conflict demotion, MMR, stretch labels, publisher mapping. Pure.
import { AGE_SOFT_FLOOR, ageOverlap, genderFit, parseAgeRange, personaFemaleShare, priceMidpoint, PRICE_FIT_NEUTRAL } from './fit';
import { GATE } from './funnel';
import type { AdvertiserProfile, LlmPersonaJudgment, Persona, PersonaLabel, PersonaScore } from './types';

export const PERSONA_FLOOR = 0.4;
export const MMR_LAMBDA = 0.3;
export const PICK_MIN = 3;
export const PICK_MAX_DEFAULT = 5;
export const CONFLICT_FACTOR = 0.5;
/** How far above typical AOV a persona tolerates, by price_sensitivity (2 = twice their AOV still a full fit). */
const PRICE_TOLERANCE: Record<string, number> = { low: 2, 'low-medium': 1.5, medium: 1, 'medium-high': 0.8, high: 0.6 };
const PERSONA_PRICE_FLOOR = 0.2;

export interface PersonaPickOpts {
  floor?: number;
  lambda?: number;
  /** CREATIVES_MAX; the live path may lower it to 3. */
  max?: number;
}

export function personaPriceFit(price: AdvertiserProfile['price'], persona: Persona): number {
  if (!price) return PRICE_FIT_NEUTRAL;
  const ratio = priceMidpoint(price) / persona.typical_aov_usd / (PRICE_TOLERANCE[persona.price_sensitivity] ?? 1);
  return ratio <= 1 ? 1 : Math.max(PERSONA_PRICE_FLOOR, 1 / ratio);
}

export function personaDemoFit(profile: AdvertiserProfile, persona: Persona): number {
  const female = personaFemaleShare(persona.gender_skew);
  // Same soft floor as publishers: a persona's age_range is a skew, and the buyer age is often an estimate.
  const age = AGE_SOFT_FLOOR + (1 - AGE_SOFT_FLOOR) * ageOverlap(profile.buyer_age, parseAgeRange(persona.age_range));
  return age * genderFit(profile.buyer_gender, female, 1 - female);
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

function label(score: number, conflicts: number, floor: number): PersonaLabel {
  if (conflicts > 0 || score < floor) return 'stretch';
  if (score >= 0.7) return 'strong';
  if (score >= 0.55) return 'moderate';
  return 'weak';
}

const byScore = (a: { score: number; persona_id: string }, b: { score: number; persona_id: string }) =>
  b.score - a.score || a.persona_id.localeCompare(b.persona_id);

export function scorePersonas(
  profile: AdvertiserProfile,
  personas: Persona[],
  judgments: LlmPersonaJudgment[],
  recommendedPublisherIds: string[],
  opts: PersonaPickOpts = {},
): PersonaScore[] {
  const floor = opts.floor ?? PERSONA_FLOOR;
  const lambda = opts.lambda ?? MMR_LAMBDA;
  const max = opts.max ?? PICK_MAX_DEFAULT;
  const recommended = new Set(recommendedPublisherIds);
  const byId = new Map(personas.map((p) => [p.id, p]));

  const scored: PersonaScore[] = [];
  for (const j of judgments) {
    const persona = byId.get(j.persona_id);
    if (!persona) continue;
    const price_fit = personaPriceFit(profile.price, persona);
    const demo_fit = personaDemoFit(profile, persona);
    const mapped = j.publisher_ids.filter((id) => recommended.has(id));
    // A persona that shops on none of the eligible publishers has nowhere natural to run: demoted like a conflict, so
    // the campaign is personas × publishers rather than personas beside publishers.
    const publisher_match = mapped.length > 0 || recommended.size === 0; // no eligible set known: nothing to miss
    const demotions = j.conflicts.length + (publisher_match ? 0 : 1);
    // Same gate as publishers (F4): neutral code dims alone must not lift a persona the model rated 0-2 above the floor.
    const score = (GATE[j.fit] ?? 0) * (0.5 * (j.fit / 5) + 0.25 * price_fit + 0.25 * demo_fit) * Math.pow(CONFLICT_FACTOR, demotions);
    scored.push({
      ...j,
      publisher_ids: publisher_match ? mapped : [...recommendedPublisherIds],
      price_fit,
      demo_fit,
      score,
      label: label(score, demotions, floor),
      picked: false,
      publisher_match,
    });
  }

  // Conflicts hard-exclude only while ≥ 3 clean personas clear the floor; otherwise demoted conflicts stay eligible.
  const aboveFloor = scored.filter((s) => s.score >= floor);
  const clean = aboveFloor.filter((s) => s.conflicts.length === 0 && s.publisher_match);
  const pool = clean.length >= PICK_MIN ? clean : aboveFloor;

  // MMR: score − λ · max Jaccard(affinities ∪ messaging) to anything already picked.
  const features = (id: string) => {
    const p = byId.get(id)!;
    return [...p.category_affinities, ...p.messaging_preferences];
  };
  const picked: PersonaScore[] = [];
  const rest = [...pool].sort(byScore);
  while (picked.length < max && rest.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    rest.forEach((s, i) => {
      const sim = picked.reduce((m, p) => Math.max(m, jaccard(features(s.persona_id), features(p.persona_id))), 0);
      const val = s.score - lambda * sim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    });
    picked.push(...rest.splice(bestIdx, 1));
  }
  // Fewer than 3 cleared the floor: fill with the next best by score, labelled stretch by the floor rule.
  const need = Math.min(PICK_MIN, scored.length);
  if (picked.length < need) {
    const pickedIds = new Set(picked.map((p) => p.persona_id));
    for (const s of [...scored].sort(byScore)) {
      if (picked.length >= need) break;
      if (!pickedIds.has(s.persona_id)) picked.push(s);
    }
  }

  for (const p of picked) p.picked = true;
  const pickedIds = new Set(picked.map((p) => p.persona_id));
  return [...picked, ...scored.filter((s) => !pickedIds.has(s.persona_id)).sort(byScore)];
}
