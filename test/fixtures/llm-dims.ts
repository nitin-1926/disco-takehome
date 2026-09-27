// PROVISIONAL hand-written LLM outputs for the U2 trap tests.
// These stand in for Sol's category/tone dims and persona judgments until U5 re-verifies them
// against the committed cache. Numbers are plausible, not measured.
import type { AdvertiserProfile, LlmPersonaJudgment, LlmPublisherDims, PersonaConflict, Triage } from '@/lib/types';

export type SampleId = 1 | 4 | 6 | 9 | 10 | 13 | 14;

export const PUBLISHER_IDS = Array.from({ length: 20 }, (_, i) => `pub_${String(i + 1).padStart(3, '0')}`);
export const PERSONA_IDS = Array.from({ length: 10 }, (_, i) => `persona_${String(i + 1).padStart(3, '0')}`);

const clearStrong: Triage = { clarity: 'clear', viability: 'strong', policy_banned: false, reason: 'clear product, catalog has direct fits' };
const clearWeak: Triage = { clarity: 'clear', viability: 'weak', policy_banned: false, reason: 'clear product, catalog has only adjacent fits' };

function profile(p: Partial<AdvertiserProfile> & Pick<AdvertiserProfile, 'input' | 'primary_category' | 'product' | 'price' | 'price_tier'>): AdvertiserProfile {
  return {
    subcategories: [],
    is_subscription: false,
    buyer_age: null,
    buyer_gender: 'unspecified',
    origin: null,
    target_geo: 'US',
    values: [],
    tone: '',
    facts: [],
    assumptions: [],
    triage: clearStrong,
    chips: [],
    language: 'en',
    ...p,
  };
}

export const profiles: Record<SampleId, AdvertiserProfile> = {
  1: profile({
    input: 'We sell premium dog food for senior dogs, targeting owners who care about joint health and longevity. Grain-free, vet-formulated, subscription-based.',
    primary_category: 'pet',
    subcategories: ['pet_food', 'subscription'],
    product: 'premium grain-free senior dog food, subscription',
    price: { low: 60, high: 80, basis: 'assumed' },
    price_tier: 'premium',
    is_subscription: true,
    buyer_gender: 'balanced',
    values: ['joint health', 'longevity', 'vet-formulated', 'grain-free'],
    tone: 'premium, caring, science-informed',
    facts: [
      { id: 'f1', text: 'premium dog food for senior dogs' },
      { id: 'f2', text: 'joint health and longevity' },
      { id: 'f3', text: 'Grain-free, vet-formulated, subscription-based' },
    ],
    assumptions: [{ field: 'price', value: '$60-80 per bag', why: 'typical premium subscription dog food; no price stated' }],
  }),
  4: profile({
    input: 'Small-batch candles poured by hand in Vermont. Natural soy wax, no synthetic fragrances. Mostly bought as gifts.',
    primary_category: 'home',
    subcategories: ['home_decor', 'gifting', 'small_batch'],
    product: 'hand-poured soy candles',
    price: { low: 25, high: 40, basis: 'assumed' },
    price_tier: 'mid',
    origin: 'Vermont',
    values: ['handmade', 'natural soy wax', 'no synthetic fragrances', 'gifting'],
    tone: 'warm, artisanal',
    facts: [
      { id: 'f1', text: 'poured by hand in Vermont' },
      { id: 'f2', text: 'Natural soy wax, no synthetic fragrances' },
      { id: 'f3', text: 'Mostly bought as gifts' },
    ],
    assumptions: [{ field: 'price', value: '$25-40', why: 'small-batch soy candle price range; no price stated' }],
  }),
  6: profile({
    input: 'Technical outerwear for serious backcountry skiers. Our shells are what patrollers wear. Starts at $650, goes up from there.',
    primary_category: 'apparel',
    subcategories: ['outerwear', 'activewear', 'technical'],
    product: 'technical ski shells',
    price: { low: 650, high: 900, basis: 'stated' },
    price_tier: 'premium',
    values: ['technical performance', 'durability', 'worn by patrollers'],
    tone: 'serious, technical',
    facts: [
      { id: 'f1', text: 'Technical outerwear for serious backcountry skiers' },
      { id: 'f2', text: 'Our shells are what patrollers wear' },
      { id: 'f3', text: 'Starts at $650' },
    ],
    triage: clearWeak,
  }),
  9: profile({
    input: 'Refillable, concentrated cleaning products. Skip the single-use plastic bottles. Works as well as the big brands. We want to show up where people who already care about sustainability are checking out.',
    primary_category: 'household',
    subcategories: ['household', 'refillable', 'sustainable'],
    product: 'refillable concentrated cleaning products',
    price: { low: 25, high: 45, basis: 'assumed' },
    price_tier: 'mid',
    values: ['sustainability', 'refillable', 'plastic-free', 'works as well as the big brands'],
    tone: 'practical, values-driven',
    facts: [
      { id: 'f1', text: 'Refillable, concentrated cleaning products' },
      { id: 'f2', text: 'Skip the single-use plastic bottles' },
      { id: 'f3', text: 'Works as well as the big brands' },
    ],
    assumptions: [{ field: 'price', value: '$25-45 starter kit', why: 'refill-kit price range; no price stated' }],
  }),
  10: profile({
    input: 'Custom-fit leather handbags, Italian-made, handcrafted in Florence. Minimum order ships in 6 weeks. Average price point $1,200.',
    primary_category: 'apparel',
    subcategories: ['accessories', 'luxury', 'women'],
    product: 'custom-fit Italian leather handbags',
    price: { low: 1200, high: 1200, basis: 'stated' },
    price_tier: 'luxury',
    buyer_gender: 'female',
    origin: 'Italy',
    values: ['craftsmanship', 'custom-fit', 'Italian-made'],
    tone: 'refined, understated luxury',
    facts: [
      { id: 'f1', text: 'Custom-fit leather handbags, Italian-made, handcrafted in Florence' },
      { id: 'f2', text: 'Minimum order ships in 6 weeks' },
      { id: 'f3', text: 'Average price point $1,200' },
    ],
    triage: clearWeak,
  }),
  13: profile({
    input: 'Workout supplements: pre-workout, creatine, protein. We compete on price, not on marketing. Same formulations as the expensive brands for half the cost.',
    primary_category: 'wellness_dtc',
    subcategories: ['supplements', 'fitness'],
    product: 'workout supplements (pre-workout, creatine, protein)',
    price: { low: 25, high: 40, basis: 'assumed' },
    price_tier: 'budget',
    values: ['price', 'value', 'same formulations as expensive brands'],
    tone: 'blunt, no-nonsense',
    facts: [
      { id: 'f1', text: 'pre-workout, creatine, protein' },
      { id: 'f2', text: 'We compete on price, not on marketing' },
      { id: 'f3', text: 'Same formulations as the expensive brands for half the cost' },
    ],
    assumptions: [{ field: 'price', value: '$25-40 per tub', why: 'half the cost of premium supplement brands; no price stated' }],
  }),
  14: profile({
    input: 'Bedding. Linen. Actually-breathable stuff made in Portugal. Our customers are mostly people who got tired of the Brooklinen/Parachute aesthetic and want something a little more grown-up.',
    primary_category: 'home',
    subcategories: ['bedding', 'home_textiles'],
    product: 'linen bedding made in Portugal',
    price: { low: 180, high: 320, basis: 'assumed' },
    price_tier: 'premium',
    origin: 'Portugal',
    values: ['breathable linen', 'grown-up design', 'made in Portugal'],
    tone: 'dry, confident, grown-up',
    facts: [
      { id: 'f1', text: 'Linen. Actually-breathable stuff made in Portugal' },
      { id: 'f2', text: 'tired of the Brooklinen/Parachute aesthetic' },
    ],
    assumptions: [{ field: 'price', value: '$180-320 per set', why: 'European linen bedding price range; no price stated' }],
  }),
};

// ---- Publisher dims: [category_fit, tone_fit, reason]; unlisted publishers get [0, 1, 'unrelated category'] ----

type Dim = [number, number, string];

function dims(listed: Record<string, Dim>): LlmPublisherDims[] {
  return PUBLISHER_IDS.map((id) => {
    const [category_fit, tone_fit, reason] = listed[id] ?? [0, 1, 'unrelated category'];
    return { publisher_id: id, category_fit, tone_fit, reason };
  });
}

export const publisherDims: Record<SampleId, LlmPublisherDims[]> = {
  1: dims({
    pub_007: [5, 5, 'premium subscription pet food is exactly Pawline'],
    pub_009: [5, 3, 'pet food core, but broad mass-market voice'],
    pub_018: [3, 2, 'pet supplies and treats; playful voice vs premium senior health'],
    pub_012: [0, 2, 'human vitamins, not pet'],
    pub_008: [1, 4, 'clean-ingredient shoppers, but groceries not pet'],
    pub_015: [1, 2, 'family households, but meal kits not pet'],
    pub_002: [0, 2, 'activewear'],
  }),
  4: dims({
    pub_010: [3, 4, 'gifting subcategory; social-good audience matches small-batch'],
    pub_014: [2, 4, 'gifting and new-home buyers, sustainability-motivated; cookware not candles'],
    pub_011: [2, 3, 'home textiles adjacent to home decor'],
    pub_003: [2, 3, 'spa and self-care adjacent'],
    pub_008: [1, 4, 'natural-ingredient shoppers, but groceries'],
    pub_013: [1, 3, 'aesthetic-driven, but beauty'],
    pub_004: [1, 3, 'affluent gifters, but apparel'],
    pub_005: [1, 3, 'affluent, but apparel'],
  }),
  6: dims({
    pub_017: [3, 3, 'activewear and sustainable shoes; urban professionals, not backcountry'],
    pub_002: [3, 2, 'activewear, but women-led fitness voice'],
    pub_016: [2, 2, 'sustainable shoes, professional women'],
    pub_010: [2, 2, 'basics and socks, gifting'],
    pub_003: [1, 2, 'fitness services'],
  }),
  9: dims({
    pub_001: [3, 1, 'household subcategory, but impulse late-night traffic vs values-driven purchase'],
    pub_008: [3, 5, 'values-driven shoppers responsive to sustainability claims; household adjacent'],
    pub_017: [2, 4, 'sustainability messaging resonates; shoes not household'],
    pub_016: [2, 4, 'sustainability claims resonate; shoes not household'],
    pub_014: [2, 4, 'sustainability-motivated kitchen buyers; adjacent home'],
    pub_015: [1, 2, 'convenience households, but meal kits'],
    pub_006: [0, 2, 'apparel'],
  }),
  10: dims({
    pub_004: [3, 4, 'affluent mid-life women, quality messaging; apparel not accessories'],
    pub_005: [3, 4, 'conservative affluent women, highest AOV apparel; adjacent to handbags'],
    pub_016: [3, 3, 'professional women, sustainable shoes; adjacent'],
    pub_006: [2, 2, 'women apparel, but inclusive-sizing value voice'],
    pub_014: [1, 3, 'gifting life events, but kitchen'],
    pub_011: [1, 3, 'design-conscious, but bedding'],
    pub_002: [1, 1, 'activewear'],
    pub_013: [1, 2, 'beauty, Gen Z'],
  }),
  13: dims({
    pub_012: [4, 1, 'supplements core; science-forward audience skeptical of price-led pitch'],
    pub_003: [3, 2, 'fitness services, personal training'],
    pub_002: [3, 3, 'fitness-engaged shoppers'],
    pub_020: [2, 2, 'functional beverages adjacent'],
    pub_001: [1, 3, 'convenience, impulse'],
  }),
  14: dims({
    pub_011: [5, 4, 'bedding is the core subcategory; design-conscious buyers'],
    pub_004: [2, 4, 'grown-up affluent women; apparel not home'],
    pub_005: [2, 3, 'affluent classic; apparel not home'],
    pub_014: [2, 4, 'non-toxic home, new-home life events'],
    pub_016: [1, 3, 'professional women'],
    pub_003: [1, 2, 'self-care'],
  }),
};

// ---- Persona judgments: [fit, why, conflicts?, publisher_ids?] ----

type J = { fit: number; why: string; conflicts?: PersonaConflict[]; publisher_ids?: string[]; prefs?: string[]; avoid?: string[]; offer?: string };

function judgments(listed: Record<string, J>): LlmPersonaJudgment[] {
  return PERSONA_IDS.map((id) => {
    const j = listed[id] ?? { fit: 0, why: 'no affinity' };
    return {
      persona_id: id,
      fit: j.fit,
      conflicts: j.conflicts ?? [],
      why: j.why,
      preferences_to_use: j.prefs ?? [],
      disinterests_to_avoid: j.avoid ?? [],
      offer_depth: j.offer ?? 'none',
      publisher_ids: j.publisher_ids ?? [],
    };
  });
}

const conflict = (field: string, persona_value: string, input_quote: string): PersonaConflict => ({ field, persona_value, input_quote });

export const personaJudgments: Record<SampleId, LlmPersonaJudgment[]> = {
  1: judgments({
    persona_004: { fit: 5, why: 'reads pet-food labels, pays for health', publisher_ids: ['pub_007', 'pub_009'], prefs: ['vet-recommended', 'ingredient transparency'] },
    persona_002: { fit: 3, why: 'loves subscriptions, pet_food affinity', publisher_ids: ['pub_009'], prefs: ['time-saving'] },
    persona_001: { fit: 2, why: 'evidence-backed, but human wellness' },
    persona_005: { fit: 2, why: 'quality over trends; older owners of senior dogs' },
    persona_008: { fit: 1, why: 'premium positioning', conflicts: [conflict('disinterested_in', 'vague premium positioning', 'premium dog food')] },
    persona_007: { fit: 2, why: 'subscription user' },
  }),
  4: judgments({
    persona_010: { fit: 5, why: 'mostly bought as gifts', publisher_ids: ['pub_010', 'pub_014'], prefs: ['giftable', 'premium presentation'] },
    persona_003: { fit: 4, why: 'small_batch affinity, aesthetic-forward', publisher_ids: ['pub_013'] },
    persona_006: { fit: 4, why: 'natural soy wax, no synthetics', publisher_ids: ['pub_014'] },
    persona_005: { fit: 3, why: 'craftsmanship, understated' },
    persona_001: { fit: 2, why: 'no-synthetics angle' },
    persona_008: { fit: 2, why: 'gift value' },
  }),
  6: judgments({
    persona_009: { fit: 5, why: 'performance apparel, technical fabrics', publisher_ids: ['pub_017', 'pub_002'] },
    persona_006: { fit: 3, why: 'durability over disposability' },
    persona_005: { fit: 2, why: 'quality and longevity, but not skiers' },
    persona_010: { fit: 3, why: 'high-ticket gift for a skier' },
    persona_008: { fit: 0, why: 'price', conflicts: [conflict('price_sensitivity', 'high', 'Starts at $650')] },
  }),
  9: judgments({
    persona_006: { fit: 5, why: 'refillable_products affinity, skeptical of greenwashing; specific claims needed', publisher_ids: ['pub_008', 'pub_017', 'pub_016'] },
    persona_002: { fit: 4, why: 'household, bulk, subscriptions', publisher_ids: ['pub_008'] },
    persona_008: { fit: 3, why: 'works as well as the big brands = value prop' },
    persona_007: { fit: 3, why: 'refill subscription' },
    persona_001: { fit: 2, why: 'clean home' },
  }),
  10: judgments({
    persona_005: { fit: 5, why: 'craftsmanship, heritage, high AOV', publisher_ids: ['pub_005', 'pub_004'], prefs: ['craftsmanship', 'heritage', 'understated'], avoid: ['trendy language'] },
    persona_010: { fit: 5, why: 'impressive high-AOV gift', publisher_ids: ['pub_004'], conflicts: [conflict('messaging_preferences', 'last-minute shipping', 'ships in 6 weeks')] },
    persona_003: { fit: 2, why: 'identity-expressive, aspirational; price far above typical' },
    persona_006: { fit: 1, why: 'craft supply chain, but no sustainability claim' },
    persona_001: { fit: 1, why: 'premium buyer, off-category' },
    persona_002: { fit: 1, why: 'luxury', conflicts: [conflict('disinterested_in', 'luxury positioning', 'Average price point $1,200')] },
    persona_007: { fit: 0, why: 'delayed fulfillment', conflicts: [conflict('disinterested_in', 'delayed fulfillment', 'ships in 6 weeks')] },
    persona_008: { fit: 0, why: 'luxury-only', conflicts: [conflict('disinterested_in', 'luxury-only messaging', 'Average price point $1,200')] },
  }),
  13: judgments({
    persona_009: { fit: 5, why: 'supplements, performance', publisher_ids: ['pub_012', 'pub_002', 'pub_003'] },
    persona_008: { fit: 5, why: 'compete on price, clear value', publisher_ids: ['pub_002'] },
    persona_001: { fit: 3, why: 'supplements, but wants evidence not price', prefs: ['ingredient transparency'] },
    persona_007: { fit: 2, why: 'easy repeat purchase' },
  }),
  14: judgments({
    persona_005: { fit: 5, why: 'quality, understated, grown-up', publisher_ids: ['pub_011', 'pub_004'] },
    persona_006: { fit: 4, why: 'linen, made in Portugal' , publisher_ids: ['pub_011'] },
    persona_010: { fit: 3, why: 'home_goods gift' },
    persona_001: { fit: 3, why: 'sleep optimisation' },
    persona_003: { fit: 2, why: 'aesthetic, but anti-trend positioning' },
  }),
};
