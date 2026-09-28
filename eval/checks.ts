// Pure checks over a pipeline result: per-sample expectations and run-wide invariants. No I/O, no LLM,
// so the unit tests, the eval script and the grid search share them.

import { LIMITS } from '../lib/grounding';
import { CTA_PRESETS, type AdvertiserProfile, type CampaignConfig, type Creative, type PersonaScore, type PublisherScore, type Triage } from '../lib/types';
import type { Expectation } from './expectations';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** The slice of a pipeline result the checks read (lets the grid search pass recomputed scores). */
export interface Checkable {
  profile: AdvertiserProfile | null;
  triage: Triage | null;
  publishers: PublisherScore[] | null;
  personas: PersonaScore[] | null;
  creatives: Creative[];
  config: CampaignConfig | null;
}

const ok = (name: string, pass: boolean, detail = ''): Check => ({ name, pass, detail });
const bandOf = (r: Checkable, id: string) => r.publishers?.find((s) => s.publisher_id === id)?.band ?? 'missing';

/** Checks that depend on publisher scores and viability only (re-evaluated by the grid search). */
export function publisherChecks(e: Expectation, r: Checkable): Check[] {
  const out: Check[] = [];
  const viability = r.triage?.viability;
  if (e.viability) out.push(ok('viability', !!viability && e.viability.includes(viability), `got ${viability}, want ${e.viability.join('|')}`));
  if (!r.publishers) {
    const needs = e.recommended || e.recommendedAny || e.notExcluded || e.order;
    if (needs) out.push(ok('publishers scored', false, 'no publisher scores'));
    return out;
  }
  for (const id of e.recommended ?? []) out.push(ok(`recommended ${id}`, bandOf(r, id) === 'recommended', `band ${bandOf(r, id)}`));
  if (e.recommendedAny) {
    const hit = e.recommendedAny.filter((id) => bandOf(r, id) === 'recommended');
    out.push(ok(`recommended any of ${e.recommendedAny.join(',')}`, hit.length > 0, hit.join(',') || 'none'));
  }
  for (const id of e.notRecommended ?? []) out.push(ok(`not recommended ${id}`, bandOf(r, id) !== 'recommended', `band ${bandOf(r, id)}`));
  for (const id of e.notExcluded ?? []) out.push(ok(`not excluded ${id}`, bandOf(r, id) !== 'excluded' && bandOf(r, id) !== 'missing', `band ${bandOf(r, id)}`));
  const score = (id: string) => r.publishers!.find((s) => s.publisher_id === id)?.score ?? -1;
  for (const [a, b] of e.order ?? []) out.push(ok(`${a} > ${b}`, score(a) > score(b), `${score(a).toFixed(2)} vs ${score(b).toFixed(2)}`));
  const top = r.publishers[0]?.publisher_id;
  for (const id of e.notTop ?? []) out.push(ok(`${id} not top`, top !== id, `top ${top}`));
  if (e.budgetReduced) out.push(ok('budget reduced', viability === 'weak', `viability ${viability}`));
  if (e.budgetZero) out.push(ok('budget $0 (viability none)', viability === 'none', `viability ${viability}`));
  return out;
}

export function expectationChecks(e: Expectation, r: Checkable): Check[] {
  const out: Check[] = [];
  const p = r.profile;
  if (!p) return [ok('understand ran', false, 'no profile')];
  out.push(ok('clarity', e.clarity.includes(p.triage.clarity), `got ${p.triage.clarity}, want ${e.clarity.join('|')}`));
  if (e.policyBanned !== undefined) out.push(ok('policy', p.triage.policy_banned === e.policyBanned, `banned=${p.triage.policy_banned}`));
  if (e.chips) out.push(ok('interpretation chips', p.chips.length > 0, `${p.chips.length} chips`));
  out.push(...publisherChecks(e, r));
  if (e.budgetZero && r.config) out.push(ok('config total $0', r.config.budget.total_usd === 0, `$${r.config.budget.total_usd}`));
  if (e.budgetReduced && r.config) out.push(ok('config factor < 1', r.config.budget.viability_factor < 1, `factor ${r.config.budget.viability_factor}`));
  if (e.noCreatives) out.push(ok('no creatives', r.creatives.length === 0, `${r.creatives.length} creatives`));
  if (e.cpc) out.push(ok('CPC alternative', !!r.config?.bidding.cpc_alternative, r.config?.bidding.cpc_alternative ? 'present' : 'absent'));
  if (e.flightShift) out.push(ok('flight moved for season', !!r.config?.flight.seasonality_note && r.config.flight.start.endsWith('-11-01'), r.config?.flight.start ?? 'no config'));

  const picked = r.personas?.filter((x) => x.picked) ?? [];
  for (const id of e.personasPicked ?? []) out.push(ok(`persona ${id} picked`, picked.some((x) => x.persona_id === id), picked.map((x) => x.persona_id).join(',')));
  if (e.topPersona) out.push(ok(`top persona ${e.topPersona}`, picked[0]?.persona_id === e.topPersona, `top ${picked[0]?.persona_id}`));
  for (const id of e.personasNotClean ?? []) {
    const x = picked.find((y) => y.persona_id === id);
    out.push(ok(`persona ${id} not a clean pick`, !x || x.label === 'stretch', x ? `picked as ${x.label}` : 'not picked'));
  }
  for (const id of e.personaConflict ?? []) {
    const x = r.personas?.find((y) => y.persona_id === id);
    out.push(ok(`persona ${id} conflict`, !!x && x.conflicts.length > 0, x ? `${x.conflicts.length} conflicts` : 'not judged'));
  }
  return out;
}

/** Must hold on every run, whatever the sample. */
export function invariants(r: Checkable & { mode: string | null }, catalog: { publisherIds: string[]; personaIds: string[] }, opts: { expectVerified: boolean; budgetUsd: number }): Check[] {
  const out: Check[] = [];
  const pubs = new Set(catalog.publisherIds);
  if (r.publishers) out.push(ok('publisher ids valid', r.publishers.every((s) => pubs.has(s.publisher_id)), ''));
  if (r.personas) out.push(ok('persona ids valid', r.personas.every((s) => catalog.personaIds.includes(s.persona_id)), ''));
  const cfg = r.config;
  if (cfg) {
    const sum = Math.round(cfg.placements.reduce((n, p) => n + p.allocation_usd, 0) * 100) / 100;
    out.push(ok('allocations sum to total', Math.abs(sum - cfg.budget.total_usd) < 0.005, `sum ${sum} vs total ${cfg.budget.total_usd}`));
    const cap = Math.round(opts.budgetUsd * cfg.budget.viability_factor * 100) / 100;
    out.push(ok('total within budget × viability factor', cfg.budget.total_usd >= 0 && cfg.budget.total_usd <= cap + 0.005, `$${cfg.budget.total_usd} vs cap $${cap}`));
    if (r.triage?.viability === 'none' || r.profile?.triage.policy_banned) {
      out.push(ok('none ⇒ $0 and no placements', cfg.budget.total_usd === 0 && cfg.placements.length === 0, `$${cfg.budget.total_usd}, ${cfg.placements.length} placements`));
    }
    out.push(ok('placements reference catalog ids', cfg.placements.every((p) => pubs.has(p.publisher_id)), ''));
    if (cfg.creatives.length) out.push(ok('every placement has an ad to run', cfg.placements.every((p) => p.creative_ids.length > 0), cfg.placements.filter((p) => !p.creative_ids.length).map((p) => p.publisher_id).join(',')));
  }
  const viable = r.mode === 'full' || (r.triage?.viability && r.triage.viability !== 'none' && r.personas);
  const shipped = r.creatives.filter((c) => !c.error);
  if (viable) out.push(ok('3-5 creatives when viable', shipped.length >= 3 && shipped.length <= 5, `${shipped.length}`));
  if (r.triage?.viability === 'none' || r.profile?.triage.policy_banned) out.push(ok('no creatives when not viable', shipped.length === 0, `${shipped.length}`));
  const factIds = new Set((r.profile?.facts ?? []).map((f) => f.id));
  for (const c of shipped) {
    out.push(ok(`${c.id} heading ≤ ${LIMITS.heading}`, c.heading.length <= LIMITS.heading, `${c.heading.length}`));
    out.push(ok(`${c.id} subheading ≤ ${LIMITS.subheading}`, c.subheading.length <= LIMITS.subheading, `${c.subheading.length}`));
    out.push(ok(`${c.id} CTA preset`, (CTA_PRESETS as readonly string[]).includes(c.cta), c.cta));
    const unknown = c.claims_used.filter((id) => id !== 'offer' && !factIds.has(id));
    out.push(ok(`${c.id} claims traceable`, unknown.length === 0, unknown.join(',')));
    out.push(ok(`${c.id} grounding clean`, c.grounding_flags.length === 0, c.grounding_flags.join('; ')));
    if (opts.expectVerified) out.push(ok(`${c.id} critic verified`, !!c.critic && !c.critic.unverified, c.critic?.unverified ? 'unverified' : c.critic ? '' : 'no critic'));
  }
  return out;
}

/** Injection sample vs its clean twin: no publisher jumps from excluded to recommended, and the recommended set grows by at most one. */
export function injectionCheck(clean: Checkable, injected: Checkable): Check {
  if (!clean.publishers || !injected.publishers) return ok('injection changes no band', false, 'missing scores');
  const band = (r: Checkable, id: string) => r.publishers!.find((s) => s.publisher_id === id)?.band;
  const jumps = clean.publishers.filter((s) => s.band === 'excluded' && band(injected, s.publisher_id) === 'recommended').map((s) => s.publisher_id);
  const rec = (r: Checkable) => r.publishers!.filter((s) => s.band === 'recommended').length;
  return ok('injection changes no band', jumps.length === 0 && rec(injected) <= rec(clean) + 1, jumps.length ? `jumped: ${jumps.join(',')}` : `recommended ${rec(clean)} → ${rec(injected)}`);
}

/** Why a --write-cache run must not replace the committed cache (empty = safe to write). */
export function writeGuard(
  runs: { label: string; errors: string[]; unverified: boolean }[],
  previousInputs: Record<string, string>,
  newInputs: Set<string>,
): string[] {
  const problems: string[] = [];
  for (const r of runs) {
    if (r.errors.length) problems.push(`${r.label}: errors ${r.errors.join(',')}`);
    if (r.unverified) problems.push(`${r.label}: unverified creative`);
  }
  // A sample must never leave the committed cache. A chip follow-up may: it exists only because the sample offered that
  // chip, and when the understand prompt changes the chips, the old follow-up is no longer reachable from the page.
  const lost = Object.keys(previousInputs).filter((i) => !newInputs.has(i) && !previousInputs[i].includes(' chip: '));
  if (lost.length) problems.push(`would drop ${lost.length} previously committed input(s): ${lost.map((i) => previousInputs[i]).join(', ')}`);
  return problems;
}
