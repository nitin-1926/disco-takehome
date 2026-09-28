// Shared shapes for the whole pipeline. Pure types, no imports, safe in browser and server code.

// ---- Catalog (mirrors data/*.json) ----

export interface Publisher {
  id: string;
  name: string;
  category: string;
  subcategories: string[];
  monthly_impressions: number;
  avg_order_value_usd: number;
  audience: {
    age_skew: string;
    gender_split: { female: number; male: number; other: number };
    top_geos: string[];
    income_tier: 'low' | 'mid' | 'mid-high' | 'high' | string;
  };
  notes: string;
}

export interface Persona {
  id: string;
  name: string;
  age_range: string;
  gender_skew: string;
  description: string;
  category_affinities: string[];
  price_sensitivity: string;
  messaging_preferences: string[];
  disinterested_in: string[];
  typical_aov_usd: number;
}

// ---- Settings (normalized once, shared by route, CLI, eval, UI) ----

export type ConversionEvent = 'purchase' | 'signup' | 'subscription';
export type OfferType = 'pct_off' | 'fixed_off' | 'bogo' | 'free_shipping' | 'free_gift';

export interface Offer {
  type: OfferType;
  amount: number | null;
  code: string | null;
}

export interface Settings {
  budgetUsd: number;
  durationDays: number;
  conversionEvent: ConversionEvent;
  offer: Offer | null;
  /** Which fields the user set explicitly (everything else is a default). */
}

// ---- Stage 1: profile + triage ----

export type Clarity = 'clear' | 'vague' | 'no_signal';
export type Viability = 'strong' | 'weak' | 'none';

export interface Triage {
  clarity: Clarity;
  viability: Viability;
  policy_banned: boolean;
  reason: string;
}

export interface Fact {
  id: string;
  /** Verbatim span from the advertiser input. */
  text: string;
}

export interface Assumption {
  field: string;
  value: string;
  why: string;
}

export interface InterpretationChip {
  label: string;
  /** Full replacement input when the chip is clicked. */
  text: string;
  /** Span of the original input this interpretation is based on. Must exist in the input. */
  quote: string;
}

export interface AdvertiserProfile {
  input: string;
  primary_category: string;
  subcategories: string[];
  product: string;
  price: { low: number; high: number; basis: 'stated' | 'assumed' } | null;
  price_tier: 'budget' | 'mid' | 'premium' | 'luxury';
  is_subscription: boolean;
  buyer_age: { low: number; high: number } | null;
  buyer_gender: 'female' | 'male' | 'balanced' | 'unspecified';
  /** stated = the input names or implies who buys; assumed = the model's estimate from the product (same idea as price.basis). */
  buyer_basis: 'stated' | 'assumed';
  values: string[];
  tone: string;
  facts: Fact[];
  assumptions: Assumption[];
  triage: Triage;
  chips: InterpretationChip[];
}

// ---- Stage 3: publishers ----

export type Band = 'recommended' | 'weak' | 'excluded';

export interface LlmPublisherDims {
  publisher_id: string;
  category_fit: number; // 0-5 integer
  tone_fit: number; // 0-5 integer
  reason: string;
}

export interface PublisherScore {
  publisher_id: string;
  category_fit: number;
  tone_fit: number;
  audience_fit: number; // 0-1
  price_fit: number; // 0-1
  gate: number;
  score: number; // 0-1
  band: Band;
  reasons: { category: string; tone: string; audience: string; price: string };
  /** Lowest dimension that placed an excluded publisher, e.g. "not their category". */
  exclusion_group: string | null;
  near_miss: boolean;
  /** Scored high enough to recommend but held at weak by a red flag (F28); names the flag. */
  capped_by: string | null;
  retrieval_similarity: number | null;
}

// ---- Stage 4: personas ----

export interface PersonaConflict {
  field: string;
  persona_value: string;
  input_quote: string;
}

export interface LlmPersonaJudgment {
  persona_id: string;
  fit: number; // 0-5 integer
  conflicts: PersonaConflict[];
  why: string;
  preferences_to_use: string[];
  disinterests_to_avoid: string[];
  offer_depth: string;
  publisher_ids: string[];
}

export type PersonaLabel = 'strong' | 'moderate' | 'weak' | 'stretch';

export interface PersonaScore extends LlmPersonaJudgment {
  price_fit: number;
  demo_fit: number;
  score: number;
  label: PersonaLabel;
  picked: boolean;
  /** False when this persona shops on none of the placement-eligible publishers: its ad has nowhere natural to run. */
  publisher_match: boolean;
}

// ---- Stage 5: creative + critic ----

export const CTA_PRESETS = ['Yes, please', 'Shop Now', 'Claim Offer', 'Get Deal', 'Redeem Now'] as const;
export type Cta = (typeof CTA_PRESETS)[number];

export interface CriticCheck {
  criterion: string;
  pass: boolean;
  fix: string | null;
}

export interface CriticVerdict {
  pass: boolean;
  checks: CriticCheck[];
  /** True when the critic could not run (failed, skipped at the wall). */
  unverified: boolean;
}

export interface Creative {
  id: string;
  persona_id: string;
  angle: string;
  heading: string;
  subheading: string;
  cta: Cta;
  offer: Offer | null;
  disclosure: string | null;
  claims_used: string[];
  publisher_ids: string[];
  constraints_respected: string[];
  critic: CriticVerdict | null;
  revised_from: { heading: string; subheading: string } | null;
  char_counts: { heading: number; subheading: number };
  /** Code grounding flags (unknown claim ids, numbers or discount words not in facts/offer, limits). Empty = clean. */
  grounding_flags: string[];
  /** Set when this persona's creative call failed; card shows the error state. */
  error: string | null;
}

// ---- Stage 6: campaign config ----

export interface Placement {
  publisher_id: string;
  /** exploit: a recommended publisher; explore: a weak fit whose budget buys outcome data. */
  role: 'exploit' | 'explore';
  allocation_usd: number;
  share: number;
  /** Fixed CPA: allocation / CPA, if the publisher's inventory can deliver it. */
  expected_conversions: number;
  /** Share of the publisher's flight inventory those conversions need (delivery risk near 100). */
  inventory_used_pct: number;
  creative_ids: string[];
}

/** The ad as the ad server needs it; reasoning and critic verdicts stay with the run. */
export type ConfigCreative = Pick<Creative, 'id' | 'persona_id' | 'heading' | 'subheading' | 'cta' | 'offer' | 'disclosure'>;

export interface CampaignConfig {
  meta: { run_id: string; generated_at: string; pipeline_version: string };
  campaign: { name: string; objective: ConversionEvent; status: 'draft'; customer_type: 'new_only' };
  flight: { start: string; end: string; days: number; seasonality_note: string | null };
  budget: { total_usd: number; daily_cap_usd: number; explore_share: number; viability_factor: number };
  bidding: {
    model: 'fixed_cpa';
    cpa_usd: number;
    /** Starting bid range: the same price basis at the benchmark's low and high CPA share. */
    cpa_range_usd: [number, number];
    cpc_alternative: { min_usd: number; max_usd: number; optimization_target: 'roas' | 'cpa' } | null;
    basis: string;
  };
  targeting: {
    category: string;
    subcategories: string[];
    personas: string[];
    age: { low: number; high: number } | null;
    gender: string;
    geo: 'US';
  };
  placements: Placement[];
  creatives: ConfigCreative[];
  exclusions: { publishers: { id: string; reason: string }[] };
  measurement: { kpi: 'cpa'; target_cpa_usd: number; expected_conversions: number; attribution_days: number };
  warnings: string[];
  assumptions: (Assumption & { source: string })[];
}


// ---- Run events + context ----

export type Stage =
  | 'understand'
  | 'score_publishers'
  | 'score_personas'
  | 'creative'
  | 'critic'
  | 'revise'
  | 'config';

export type StageStatus = 'started' | 'done' | 'skipped';
export type Source = 'committed' | 'redis' | 'live' | 'code';

/** Refusals the route returns as JSON before any stream byte. */
export type GateError = 'bad_request' | 'forbidden' | 'unsupported_media_type' | 'too_large' | 'key_missing' | 'store_unavailable' | 'rate_limited' | 'in_progress' | 'spend_cap' | 'daily_cap';

export type ErrorCode =
  | 'cache_miss'
  | 'spend_refused'
  | 'store_error'
  | 'schema_invalid'
  | 'timeout'
  | 'aborted'
  | 'provider_error'
  | 'wall_exceeded'
  | 'dependency_failed';

export interface StageEvent {
  type: 'stage';
  stage: Stage;
  status: StageStatus;
  source?: Source;
  ms?: number;
  payload?: unknown;
}

export interface ErrorEvent {
  type: 'error';
  stage: Stage;
  code: ErrorCode;
  message: string;
}

export interface CallRecord {
  module: string;
  model: string;
  source: Source;
  ms: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface RunSummary {
  run_id: string;
  cost_live_usd: number;
  cost_replayed_usd: number;
  calls: CallRecord[];
  total_ms: number;
  cold: boolean;
  skipped: Stage[];
  errors: { stage: Stage; code: ErrorCode }[];
}

export interface DoneEvent {
  type: 'done';
  summary: RunSummary;
}

export type RunEvent = StageEvent | ErrorEvent | DoneEvent;

export interface CacheMode {
  read: boolean;
  /** Canonical sample: a double miss is an error, never a provider call. */
  replayOnly: boolean;
  writeCommitted: boolean;
}

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: 'cap' | 'store' };

export interface SpendHook {
  reserve(estimateUsd: number): Promise<ReserveResult>;
  settle(id: string, actualUsd: number): Promise<void>;
}

export interface RunContext {
  run_id: string;
  sink: (event: RunEvent) => void;
  signal?: AbortSignal;
  /** Absolute time (ms since epoch) after which optional stages are abandoned. */
  wallAt: number;
  startedAt: number;
  cacheMode: CacheMode;
  spend: SpendHook | null;
  /** Deferred work (settles, cache writes, released side calls). Route backs it with after(); CLI/eval collect and await. */
  defer: (task: () => Promise<void>) => void;
}
