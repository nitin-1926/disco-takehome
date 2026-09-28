// Campaign config assembly. Pure and browser-safe: no env, data, model or Date.now() reads; `meta` and `today` are passed in.
import { money } from './fit';
import { CPA_SHARE_BAND, CPA_SHARE_OF_PRICE, CVR_BAND, CVR_PRIOR, SIGNUP_CPA_USD, SUBSCRIPTION_LTV_MULT, cpcAlternative, effectiveCvr, priceMid, targetCpa } from './pricing';
import type { AdvertiserProfile, CampaignConfig, Creative, PersonaScore, Placement, Publisher, PublisherScore, Settings, Triage, Viability } from './types';

/** Budget factor per resolved viability (F6). The 0.4 is an assumption, recorded in assumptions[]. */
export const VIABILITY_FACTOR: Record<Viability, number> = { strong: 1, weak: 0.4, none: 0 };
export const EXPLORE_SHARE = 0.15;
/** Publishers a weak-fit test budget is spread over. */
export const WEAK_TEST_POOL = 3;
export const MIN_PLACEMENT_SHARE = 0.05;
export const MIN_EXPECTED_CONVERSIONS = 50;
/** Shift the flight to Nov 1 only when it is this close; a January plan should not wait ten months. */
export const SEASON_SHIFT_WINDOW_DAYS = 60;
const SEASON_NOTE = /nov[-–]dec/i;
const CONSTRAINT_NOTE = /skeptic|sensib|sensitiv|conservative|claims/i;

export interface BuildConfigInput {
  profile: AdvertiserProfile;
  /** Resolved triage (after resolveViability). */
  triage: Triage;
  settings: Settings;
  publisherScores: PublisherScore[];
  personaScores: PersonaScore[];
  creatives: Creative[];
  publishers: Publisher[];
  meta: CampaignConfig['meta'];
  /** YYYY-MM-DD. */
  today: string;
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const parseDay = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => formatDay(parseDay(day) + n * DAY_MS);

interface Candidate {
  score: PublisherScore;
  pool: 'exploit' | 'explore';
  pub: Publisher;
  share: number;
  cap: number;
  impressions: number;
  cvr: [number, number, number]; // low, mid, high
  allocation: number;
}

/** Share ∝ score inside each pool; 85/15 exploit/explore when an explore pool exists, else 100% exploit. */
function rawShares(exploit: PublisherScore[], explore: PublisherScore[]): Map<string, number> {
  const shares = new Map<string, number>();
  const exploitShare = explore.length ? 1 - EXPLORE_SHARE : 1;
  const spread = (pool: PublisherScore[], poolShare: number) => {
    const total = pool.reduce((n, s) => n + s.score, 0);
    for (const s of pool) shares.set(s.publisher_id, (poolShare * s.score) / total);
  };
  spread(exploit, exploitShare);
  if (explore.length) spread(explore, EXPLORE_SHARE);
  return shares;
}

/** Drop placements under 5% while at least two would remain. The freed share stays in its own pool (85/15 holds);
 * only an emptied pool hands its share to the other. Returns the survivors and the dropped. */
function dropSmall(items: Candidate[]): { kept: Candidate[]; dropped: Candidate[] } {
  let list = items;
  const dropped: Candidate[] = [];
  for (;;) {
    if (list.length < 3) return { kept: list, dropped };
    const min = list.reduce((m, c) => (c.share < m.share ? c : m));
    if (min.share >= MIN_PLACEMENT_SHARE) return { kept: list, dropped };
    dropped.push(min);
    list = list.filter((c) => c !== min);
    const pool = list.filter((c) => c.pool === min.pool);
    const target = pool.length ? pool : list;
    const have = target.reduce((n, c) => n + c.share, 0);
    for (const c of target) c.share *= (have + min.share) / have;
  }
}

/** Water-fill: capped placements freeze at their inventory cap, the excess flows to the rest ∝ share. Returns spendable total. */
function applyCaps(items: Candidate[], total: number): number {
  const fixed = new Set<Candidate>();
  for (const c of items) c.allocation = c.share * total;
  for (;;) {
    const over = items.filter((c) => !fixed.has(c) && c.allocation > c.cap);
    if (!over.length) break;
    for (const c of over) {
      c.allocation = c.cap;
      fixed.add(c);
    }
    const free = items.filter((c) => !fixed.has(c));
    const excess = total - items.reduce((n, c) => n + c.allocation, 0);
    if (!free.length) break;
    const freeShare = free.reduce((n, c) => n + c.share, 0);
    for (const c of free) c.allocation += (excess * c.share) / freeShare;
  }
  return items.reduce((n, c) => n + c.allocation, 0);
}

/** Round to cents; any residual lands on the largest placement so the sum is exact. */
function roundToCents(items: Candidate[], total: number): void {
  for (const c of items) c.allocation = round2(c.allocation);
  const delta = round2(total - items.reduce((n, c) => n + c.allocation, 0));
  if (delta !== 0 && items.length) {
    const largest = items.reduce((m, c) => (c.allocation > m.allocation ? c : m));
    largest.allocation = round2(largest.allocation + delta);
  }
}

export function buildConfig(input: BuildConfigInput): CampaignConfig {
  const { profile, triage, settings, publisherScores, personaScores, creatives, publishers, meta, today } = input;
  const warnings: string[] = [];
  const assumptions: CampaignConfig['assumptions'] = profile.assumptions.map((a) => ({ ...a, source: 'understand step (inferred from the input)' }));
  const pubById = new Map(publishers.map((p) => [p.id, p]));
  const days = settings.durationDays;

  // ---- budget and bid ----
  const factor = VIABILITY_FACTOR[triage.viability];
  let total = round2(settings.budgetUsd * factor);
  const { cpa, basis } = targetCpa(profile, settings.conversionEvent);
  const price = priceMid(profile);
  const cpc = cpcAlternative(profile);
  if (triage.viability === 'weak') warnings.push(`Weak fit: planning budget reduced to ${Math.round(factor * 100)}% of ${money(settings.budgetUsd)}; we do not recommend a full launch.`);
  if (triage.viability === 'none') warnings.push('No viable publisher fit in this catalog: budget set to $0, no placements.');

  // ---- placements ----
  const recommended = publisherScores.filter((s) => s.band === 'recommended');
  const weak = publisherScores.filter((s) => s.band === 'weak');
  // No recommended publisher: a test budget on the few best weak fits, not a sliver on every weak one.
  const exploit = recommended.length ? recommended : weak.slice(0, WEAK_TEST_POOL);
  const explore = recommended.length ? weak : [];
  let items: Candidate[] = [];
  let dropped: Candidate[] = [];
  if (total > 0 && exploit.length) {
    const shares = rawShares(exploit, explore);
    const exploreIds = new Set(explore.map((s) => s.publisher_id));
    items = [...exploit, ...explore].map((score) => {
      const pub = pubById.get(score.publisher_id)!;
      const impressions = (pub.monthly_impressions * days) / 30;
      const cvr = [CVR_BAND[0], CVR_PRIOR, CVR_BAND[1]].map((prior) => effectiveCvr(prior, score.score, pub.avg_order_value_usd, price.value)) as Candidate['cvr'];
      const pool = exploreIds.has(score.publisher_id) ? ('explore' as const) : ('exploit' as const);
      return { score, pool, pub, share: shares.get(score.publisher_id)!, cap: impressions * cvr[1] * cpa, impressions, cvr, allocation: 0 };
    });
    ({ kept: items, dropped } = dropSmall(items));
    const spendable = applyCaps(items, total);
    if (spendable < total - 0.005) {
      warnings.push(`Inventory caps limit spend to ${money(spendable)} of ${money(total)} over ${days} days; extend the flight or add publishers.`);
      total = round2(spendable);
    }
    roundToCents(items, total);
  } else if (total > 0) {
    warnings.push('No publisher cleared the weak-fit bar; nothing to allocate.');
    total = 0;
  }

  const placements: Placement[] = items.map((c, i) => {
    const conversions = c.allocation / cpa;
    const lo = Math.min(conversions, c.impressions * c.cvr[0]);
    const hi = Math.min(conversions, c.impressions * c.cvr[2]);
    return {
      publisher_id: c.pub.id,
      rank: i + 1,
      score: c.score.score,
      band: c.score.band,
      share: total > 0 ? c.allocation / total : 0,
      allocation_usd: c.allocation,
      impressions_range: [Math.round(Math.min(c.impressions, lo / c.cvr[2])), Math.round(Math.min(c.impressions, hi / c.cvr[0]))],
      conversions_range: [Math.floor(lo), Math.ceil(hi)],
      inventory_used_pct: Math.min(100, Math.round((conversions / c.cvr[1] / c.impressions) * 1000) / 10),
      cpa_usd: cpa,
      creative_ids: creatives.filter((cr) => cr.publisher_ids.includes(c.pub.id)).map((cr) => cr.id),
      why: `${c.score.band}: ${c.score.reasons.category}`,
    };
  });
  const expectedMid = placements.reduce((n, p) => n + p.allocation_usd / cpa, 0);
  const conversionsRange: [number, number] = [
    placements.reduce((n, p) => n + p.conversions_range[0], 0),
    placements.reduce((n, p) => n + p.conversions_range[1], 0),
  ];
  if (total > 0 && total < cpa) warnings.push(`Budget ${money(total)} is below one target CPA (${money(cpa)}): expect at most one conversion.`);
  else if (total > 0 && expectedMid < MIN_EXPECTED_CONVERSIONS) warnings.push(`Expected conversions (~${Math.round(expectedMid)}) below ${MIN_EXPECTED_CONVERSIONS}: too few to optimise against; raise budget or extend the flight.`);

  // ---- flight and seasonality ----
  let start = today;
  let seasonalityNote: string | null = null;
  const seasonal = items.map((c) => c.pub).find((p) => SEASON_NOTE.test(p.notes));
  if (seasonal) {
    const nov1 = `${today.slice(0, 4)}-11-01`;
    const daysUntil = (parseDay(nov1) - parseDay(today)) / DAY_MS;
    if (daysUntil > 0 && daysUntil <= SEASON_SHIFT_WINDOW_DAYS) {
      start = nov1;
      seasonalityNote = `Start moved to ${nov1}: ${seasonal.name} notes "${seasonal.notes}"`;
      assumptions.push({ field: 'flight.start', value: nov1, why: 'flight shifted to catch the gifting uplift', source: `publisher note (${seasonal.name})` });
    } else {
      seasonalityNote = `${seasonal.name} notes "${seasonal.notes}"; flight ${daysUntil > 0 ? 'starts before' : 'overlaps'} the uplift window.`;
    }
  }

  // ---- assumptions for every guessed number ----
  assumptions.push(
    { field: 'bidding.fixed_cpa_usd', value: money(cpa), why: basis, source: `TGM DTC benchmark: CPA ${CPA_SHARE_BAND.map((b) => `${b * 100}%`).join('-')} of first-order AOV (using ${CPA_SHARE_OF_PRICE * 100}%)` },
    { field: 'cvr_prior', value: `${CVR_PRIOR * 100}% (band ${CVR_BAND[0] * 100}-${CVR_BAND[1] * 100}%)`, why: 'post-checkout conversions per impression, decayed by fit and AOV/price', source: 'derived from Rokt publisher yield $0.30-0.80 per transaction, capped by 5.6% engagement' },
    { field: 'budget.viability_factor', value: String(factor), why: `viability ${triage.viability}: ${triage.reason}`, source: 'assumption' },
    { field: 'budget.explore_share', value: `${EXPLORE_SHARE * 100}% target`, why: 'explore budget buys publisher × persona outcome data that replaces the model prior', source: 'allocation thesis' },
  );
  if (profile.is_subscription || settings.conversionEvent === 'subscription') {
    assumptions.push({ field: 'subscription_ltv_mult', value: `${SUBSCRIPTION_LTV_MULT}x`, why: 'recurring revenue justifies a higher first-order CPA', source: 'assumption' });
  }
  if (settings.conversionEvent === 'signup') {
    assumptions.push({ field: 'signup_cpa_usd', value: money(SIGNUP_CPA_USD), why: 'flat lead-gen CPA for a signup', source: 'assumption' });
  }
  if (price.basis === 'tier_default') {
    assumptions.push({ field: 'price', value: money(price.value), why: `no price stated; ${profile.price_tier}-tier default used for CPA and ROAS`, source: 'assumption (pricing.ts TIER_PRICE_USD)' });
  }
  if (cpc) {
    assumptions.push({ field: 'bidding.cpc_alternative', value: `${money(cpc.min_usd)}-${money(cpc.max_usd)}`, why: 'advertiser competes on price; CPC = CPA × 2-5% click-to-purchase', source: 'assumption (Disco CPC model, public help center)' });
  }

  // ---- personas, exclusions, constraints ----
  const picked = personaScores.filter((p) => p.picked);
  const groupReason: Record<string, keyof PublisherScore['reasons']> = { 'not their category': 'category', 'audience mismatch': 'audience', 'price mismatch': 'price', 'tone mismatch': 'tone' };
  const placed = new Set(placements.map((p) => p.publisher_id));
  const droppedIds = new Set(dropped.map((c) => c.pub.id));
  const pooled = new Set([...exploit, ...explore].map((s) => s.publisher_id));
  const unplacedReason = (s: PublisherScore) =>
    droppedIds.has(s.publisher_id) ? 'below 5% share' : !pooled.has(s.publisher_id) && s.band === 'weak' ? `outside the ${WEAK_TEST_POOL} best weak fits` : 'no budget';

  return {
    meta,
    advertiser_profile: profile,
    triage,
    campaign: { name: `${profile.product} — ${settings.conversionEvent}`, objective: settings.conversionEvent, status: 'draft' },
    flight: { start, end: addDays(start, days - 1), days, seasonality_note: seasonalityNote },
    budget: {
      total_usd: total,
      daily_cap_usd: total > 0 ? round2(total / days) : 0,
      // Realised, not the target: inventory caps can move money between the pools.
      explore_share: total > 0 ? round3(items.filter((c) => c.pool === 'explore').reduce((n, c) => n + c.allocation, 0) / total) : 0,
      planning_estimate: true,
      viability_factor: factor,
    },
    bidding: { model: 'cpa_cpo', fixed_cpa_usd: cpa, cpa_range_usd: CPA_SHARE_BAND.map((b) => round2((cpa * b) / CPA_SHARE_OF_PRICE)) as [number, number], fixed_cpo_usd: 0, cpc_alternative: cpc, basis },
    targeting: {
      customer_type: 'new_only',
      primary_category: profile.primary_category,
      subcategories: profile.subcategories,
      personas: picked.map((p) => p.persona_id),
      buyer_age: profile.buyer_age,
      buyer_gender: profile.buyer_gender,
      income_tiers: [...new Set(items.map((c) => c.pub.audience.income_tier))],
      geo: 'US',
    },
    placements,
    creatives,
    personas: picked,
    exclusions: {
      publishers: publisherScores
        .filter((s) => s.band === 'excluded' || (!placed.has(s.publisher_id) && total > 0))
        .map((s) => ({
          id: s.publisher_id,
          reason_group: s.exclusion_group ?? unplacedReason(s),
          reason: s.exclusion_group ? s.reasons[groupReason[s.exclusion_group]] : `score ${Math.round(s.score * 100)}/100 (${s.band})`,
        })),
      personas: personaScores
        .filter((p) => !p.picked)
        .map((p) => ({
          id: p.persona_id,
          reason: p.conflicts.length
            ? `conflicts with input: "${p.conflicts[0].input_quote}" vs ${p.conflicts[0].field} "${p.conflicts[0].persona_value}"`
            : `score ${p.score.toFixed(2)} (${p.label}); not selected`,
        })),
    },
    constraints: items.filter((c) => CONSTRAINT_NOTE.test(c.pub.notes)).map((c) => `${c.pub.name}: ${c.pub.notes}`),
    measurement: {
      primary_kpi: 'cpa',
      target_cpa_usd: cpa,
      target_roas: round2(price.value / cpa),
      expected_conversions_range: conversionsRange,
      attribution: { click_days: 14, view_days: 14 },
    },
    launch_checklist: [
      'Landing page URL',
      'Brand logo (SVG or PNG)',
      'Product images',
      ...(settings.offer ? [`Promo code${settings.offer.code ? ` ${settings.offer.code}` : ''} live at checkout`] : []),
    ],
    warnings,
    assumptions,
  };
}
