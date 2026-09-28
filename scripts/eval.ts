// Eval harness (plan U5). Same pipeline, same RunContext as the route; checks from eval/checks.ts.
//
//   npm run eval                        15 samples + injection twin; cache on (committed → Redis → live); writes eval/output.md
//   npm run eval -- --fresh             same, cache reads off (every call live)
//   npm run eval -- --grid              + grid search over weights/thresholds on this run's LLM dims; sensitivity table
//   npm run eval -- --stability         + messy samples' understand ×3 with reads off; triage must not change
//   npm run eval -- --write-cache       canonical run of samples, chip follow-ups and the injection twin with no wall
//                                       (reuses still-valid committed entries; add --fresh to make every call live);
//                                       refuses on any error/unverified card or lost input; writes data/cache/committed.json;
//                                       then replays every committed input in a child process and asserts zero live calls
//   npm run eval -- --bakeoff           embedding scorer vs rubric; understand+scoring on Luna; critic on Sol; effort
//                                       low vs medium; creatives low vs medium judged; reversed catalog (docs/eval/bakeoff.md)
//   npm run eval -- --judge             Luna judge per creative (docs/eval/judge.md, docs/eval/hand-label-checklist.md, κ if labelled)
//   npm run eval -- --verify-replay     (internal) replay-only run of every committed input
//
// --write-cache is exclusive with --bakeoff and --judge.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

import { pendingCommitted } from '../lib/cache';
import { committedCache, personas as PERSONAS, publishers as PUBLISHERS, sampleAdvertisers } from '../lib/data';
import { resolveViability, scorePublishers, THRESHOLDS, WEIGHTS, type Thresholds, type Weights } from '../lib/funnel';
import { callLLM } from '../lib/llm';
import { MODEL_IDS, PIPELINE_VERSION, type Reasoning } from '../lib/models';
import { scorePersonas } from '../lib/personas';
import { CALL_TIMEOUT_MS, RUN_WALL_MS, runPipeline, type PipelineResult } from '../lib/pipeline';
import { finalizeProfile } from '../lib/profile';
import { normalizeInput, normalizeSettings } from '../lib/settings';
import type { CallRecord, LlmPublisherDims, RunContext, RunEvent } from '../lib/types';
import { expectationChecks, injectionCheck, invariants, publisherChecks, writeGuard, type Check } from '../eval/checks';
import { EXPECTATIONS, INJECTION_SUFFIX, resolveNames, type Expectation } from '../eval/expectations';
import { creativeArgs, creativeModule } from '../prompts/creative';
import { CRITIC_RULES, criticModule } from '../prompts/critic';
import { JUDGE_CRITERIA, judgeModule } from '../prompts/judge';
import { personaScoringArgs, scorePersonaModule } from '../prompts/score-personas';
import { publisherScoringArgs, scorePublishersModule } from '../prompts/score-publishers';
import { understandModule } from '../prompts/understand';

const has = (f: string) => process.argv.includes(f);
const argVal = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const TODAY = '2026-09-28';
/** Bake-off and judge calls are offline: not bound by the live 25 s call timeout (medium effort can exceed it). */
const OFFLINE_TIMEOUT_MS = 120_000;
const MESSY = [5, 8, 11, 14, 15];

// ---------------------------------------------------------------- context + runner

interface Run {
  label: string;
  sample: number | null;
  input: string;
  result: PipelineResult;
  events: RunEvent[];
}

function evalCtx(o: { read: boolean; replayOnly?: boolean; write?: boolean; wallMs?: number }): RunContext & { deferred: Array<() => Promise<void>>; events: RunEvent[] } {
  const deferred: Array<() => Promise<void>> = [];
  const events: RunEvent[] = [];
  const now = Date.now();
  return {
    run_id: `eval-${now}`,
    sink: (e) => events.push(e),
    wallAt: now + (o.wallMs ?? RUN_WALL_MS),
    startedAt: now,
    cacheMode: { read: o.read, replayOnly: !!o.replayOnly, writeCommitted: !!o.write },
    spend: null,
    defer: (t) => deferred.push(t),
    deferred,
    events,
  };
}

async function runOne(label: string, sample: number | null, input: string, o: Parameters<typeof evalCtx>[0], weights?: Weights): Promise<Run> {
  const ctx = evalCtx(o);
  const result = await runPipeline(input, normalizeSettings(), ctx, { today: TODAY, weights });
  await Promise.allSettled(ctx.deferred.map((t) => t()));
  const s = result.summary;
  const live = s.calls.filter((c) => c.source === 'live').length;
  console.log(`  ${label.padEnd(18)} ${String(s.total_ms).padStart(6)}ms  calls ${s.calls.length} (${live} live)  $${s.cost_live_usd.toFixed(4)}${s.errors.length ? `  errors ${s.errors.map((e) => `${e.stage}:${e.code}`).join(',')}` : ''}`);
  return { label, sample, input, result, events: ctx.events };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const samples = sampleAdvertisers(readFileSync('data/example_advertisers.txt', 'utf8'));
const sampleInputs = samples.map((s, i) => ({ label: `#${i + 1}`, sample: i + 1, input: normalizeInput(s) }));
const injectionInput = { label: 'injection (#1)', sample: null, input: normalizeInput(samples[0] + INJECTION_SUFFIX) };
const pubName = (id: string) => PUBLISHERS.find((p) => p.id === id)?.name ?? id;
const personaName = (id: string) => PERSONAS.find((p) => p.id === id)?.name ?? id;
const catalog = { publisherIds: PUBLISHERS.map((p) => p.id), personaIds: PERSONAS.map((p) => p.id) };

// ---------------------------------------------------------------- checks + report

interface Scored {
  run: Run;
  exp: Expectation | null;
  checks: Check[];
  inv: Check[];
}

function score(runs: Run[], exps: Expectation[], expectVerified: boolean): Scored[] {
  return runs.map((run) => {
    const exp = exps.find((e) => e.sample === run.sample) ?? null;
    const r = run.result;
    return {
      run,
      exp,
      checks: exp ? expectationChecks(exp, r) : [],
      inv: invariants(r, catalog, { expectVerified, budgetUsd: normalizeSettings().budgetUsd }),
    };
  });
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function metrics(runs: Run[]) {
  const calls: CallRecord[] = runs.flatMap((r) => r.result.summary.calls);
  const live = calls.filter((c) => c.source === 'live');
  const liveRuns = runs.filter((r) => r.result.summary.calls.length && r.result.summary.calls.every((c) => c.source === 'live'));
  const input = live.reduce((n, c) => n + c.inputTokens, 0);
  const cached = live.reduce((n, c) => n + c.cachedInputTokens, 0);
  return {
    runs: runs.length,
    calls: calls.length,
    liveCalls: live.length,
    callsPerRun: runs.length ? calls.length / runs.length : 0,
    costLive: live.reduce((n, c) => n + c.costUsd, 0),
    costPerRun: runs.length ? calls.reduce((n, c) => n + c.costUsd, 0) / runs.length : 0,
    inputTokens: input,
    outputTokens: live.reduce((n, c) => n + c.outputTokens, 0),
    reasoningTokens: live.reduce((n, c) => n + c.reasoningTokens, 0),
    cacheReadShare: input ? cached / input : 0,
    liveRunMs: liveRuns.map((r) => r.result.summary.total_ms),
  };
}

function reportMarkdown(scored: Scored[], extra: string[], mode: string): string {
  const m = metrics(scored.map((s) => s.run));
  const all = scored.flatMap((s) => [...s.checks, ...s.inv]);
  const failed = scored.flatMap((s) => [...s.checks, ...s.inv].filter((c) => !c.pass).map((c) => `${s.run.label}: ${c.name} (${c.detail})`));
  const L: string[] = [];
  L.push('# Eval output', '');
  L.push(`Generated by \`npm run eval${mode ? ` -- ${mode}` : ''}\` on ${new Date().toISOString().slice(0, 10)}. Pipeline ${PIPELINE_VERSION}; infer ${MODEL_IDS.sol}, check ${MODEL_IDS.luna}; weights tone ${WEIGHTS.tone} / audience ${WEIGHTS.audience} / price ${WEIGHTS.price}; recommended ≥ ${THRESHOLDS.recommended} with category ≥ ${THRESHOLDS.category_min}, weak ≥ ${THRESHOLDS.weak}. Flight dates computed as of ${TODAY}.`, '');
  L.push(`**${all.filter((c) => c.pass).length}/${all.length} checks pass** (${scored.reduce((n, s) => n + s.checks.length, 0)} expectation checks, ${scored.reduce((n, s) => n + s.inv.length, 0)} invariants). Expectations: \`eval/expectations.ts\`; #2, #11, #12 are held-out controls.`, '');
  L.push('| sample | trap | clarity × viability | recommended | personas picked | creatives | checks | ms | $ |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of scored) {
    const r = s.run.result;
    const rec = r.publishers?.filter((x) => x.band === 'recommended').map((x) => pubName(x.publisher_id)).join(', ') || '—';
    const per = r.personas?.filter((x) => x.picked).map((x) => `${personaName(x.persona_id).replace('The ', '')}${x.label === 'stretch' ? ' (stretch)' : ''}`).join(', ') || '—';
    const cs = [...s.checks, ...s.inv];
    L.push(`| ${s.run.label} | ${s.exp?.trap ?? 'invariants only'}${s.exp?.heldOut ? ' (held out)' : ''} | ${r.profile?.triage.clarity ?? '?'} × ${r.triage?.viability ?? '?'}${r.profile?.triage.policy_banned ? ' banned' : ''} | ${rec} | ${per} | ${r.creatives.filter((c) => !c.error).length} | ${cs.filter((c) => c.pass).length}/${cs.length} | ${r.summary.total_ms} | ${r.summary.cost_live_usd.toFixed(4)} |`);
  }
  L.push('', '## Run metrics', '');
  L.push(`- Runs ${m.runs}; calls ${m.calls} (${m.callsPerRun.toFixed(1)} per run), ${m.liveCalls} live this time.`);
  L.push(`- Cost of a live run (stored cost per call, whether replayed or live): $${m.costPerRun.toFixed(4)} average; live spend this eval $${m.costLive.toFixed(4)}.`);
  if (m.liveCalls) L.push(`- Live tokens: input ${m.inputTokens} (cache-read share ${(m.cacheReadShare * 100).toFixed(0)}%), output ${m.outputTokens} (reasoning ${m.reasoningTokens}).`);
  if (m.liveRunMs.length) L.push(`- Fully live runs: ${m.liveRunMs.length}; wall p50 ${pct(m.liveRunMs, 50)} ms, p95 ${pct(m.liveRunMs, 95)} ms, max ${Math.max(...m.liveRunMs)} ms.`);
  L.push('', '## Failures', '', failed.length ? failed.map((f) => `- ${f}`).join('\n') : 'None.', '');
  for (const x of extra) L.push(x, '');
  L.push('## Per-sample detail', '');
  for (const s of scored) L.push(...detail(s), '');
  return L.join('\n');
}

function detail(s: Scored): string[] {
  const r = s.run.result;
  const L: string[] = [`### ${s.run.label}${s.exp ? `: ${s.exp.trap}` : ''}`, '', `> ${s.run.input}`, ''];
  const p = r.profile;
  if (!p) return [...L, 'Understand failed.'];
  L.push(`- Triage: ${p.triage.clarity} × ${r.triage?.viability ?? p.triage.viability}${p.triage.policy_banned ? ', policy banned' : ''}. ${p.triage.reason}${r.viabilityNote ? ` (${r.viabilityNote})` : ''}`);
  L.push(`- Profile: ${p.primary_category} [${p.subcategories.join(', ')}]; ${p.product}; price ${p.price ? `$${p.price.low}-${p.price.high} (${p.price.basis})` : 'none'}, ${p.price_tier}; buyer ${p.buyer_age ? `${p.buyer_age.low}-${p.buyer_age.high}` : 'any age'}, ${p.buyer_gender}.`);
  L.push(`- Facts: ${p.facts.map((f) => `${f.id} "${f.text}"`).join('; ') || 'none'}`);
  if (p.chips.length) L.push(`- Interpretation chips: ${p.chips.map((c) => `[${c.label}] "${c.text}" (quotes "${c.quote}")`).join('; ')}`);
  if (r.mode !== 'full') L.push(`- Mode: ${r.mode}. ${r.modeWhy}`);
  if (r.publishers) {
    L.push('', '| publisher | score | band | category | tone | audience | price | why |', '|---|---|---|---|---|---|---|---|');
    for (const x of r.publishers.filter((y) => y.band !== 'excluded')) {
      L.push(`| ${pubName(x.publisher_id)} | ${Math.round(x.score * 100)} | ${x.band} | ${x.category_fit} | ${x.tone_fit} | ${x.audience_fit.toFixed(2)} | ${x.price_fit.toFixed(2)} | ${x.reasons.category} |`);
    }
    L.push('', `Excluded: ${r.exclusionGroups.map((g) => `${g.group} (${g.count}: ${g.ids.map(pubName).join(', ')})`).join('; ') || 'none'}.`);
    if (r.comparatives.length) L.push(`Comparatives: ${r.comparatives.map((c) => `${pubName(c.higher)} over ${pubName(c.lower)}: ${c.why}`).join(' / ')}`);
  }
  if (r.personas) {
    L.push('', `Personas picked: ${r.personas.filter((x) => x.picked).map((x) => `${personaName(x.persona_id)} ${x.score.toFixed(2)} ${x.label}${x.conflicts.length ? ` (conflict: "${x.conflicts[0].input_quote}" vs ${x.conflicts[0].field} "${x.conflicts[0].persona_value}")` : ''}`).join('; ')}.`);
  }
  for (const c of r.creatives) {
    if (c.error) {
      L.push(`- ${c.id} ${personaName(c.persona_id)}: error, ${c.error}`);
      continue;
    }
    const v = !c.critic ? 'no critic' : c.critic.unverified ? 'unverified' : c.critic.pass ? 'critic pass' : `critic fail: ${c.critic.checks.filter((k) => !k.pass).map((k) => k.criterion).join(', ')}`;
    L.push(`- ${c.id} ${personaName(c.persona_id)} [${c.angle}]: **${c.heading}** / ${c.subheading} [${c.cta}] (${v}${c.revised_from ? `; revised from "${c.revised_from.heading}"` : ''})`);
  }
  const cfg = r.config;
  if (cfg) {
    L.push('', `Config: budget $${cfg.budget.total_usd} (factor ${cfg.budget.viability_factor}), ${cfg.bidding.model} CPA $${cfg.bidding.fixed_cpa_usd}${cfg.bidding.cpc_alternative ? `, CPC alternative $${cfg.bidding.cpc_alternative.min_usd}-${cfg.bidding.cpc_alternative.max_usd}` : ''}, flight ${cfg.flight.start} → ${cfg.flight.end}${cfg.flight.seasonality_note ? ` (${cfg.flight.seasonality_note})` : ''}.`);
    if (cfg.placements.length) L.push(`Placements: ${cfg.placements.map((x) => `${pubName(x.publisher_id)} $${x.allocation_usd} (${Math.round(x.share * 100)}%)`).join(', ')}.`);
    for (const w of cfg.warnings) L.push(`Warning: ${w}`);
  }
  const failed = [...s.checks, ...s.inv].filter((c) => !c.pass);
  L.push('', failed.length ? `Failed checks: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}` : 'All checks pass.');
  return L;
}

// ---------------------------------------------------------------- grid search

function dimsOf(r: PipelineResult): LlmPublisherDims[] {
  return (r.publishers ?? []).map((s) => ({ publisher_id: s.publisher_id, category_fit: s.category_fit, tone_fit: s.tone_fit, reason: s.reasons.category }));
}

function rescore(run: Run, w: Weights, t: Thresholds) {
  const r = run.result;
  const scores = scorePublishers(r.profile!, PUBLISHERS.filter((p) => r.publishers!.some((s) => s.publisher_id === p.id)), dimsOf(r), undefined, w, t);
  const triage = { ...r.profile!.triage, viability: resolveViability(r.profile!.triage.viability, scores, t).viability };
  return { ...r, publishers: scores, triage };
}

function gridSearch(runs: Run[], exps: Expectation[]): string {
  const tuning = runs.filter((x) => x.result.publishers && x.result.profile && exps.find((e) => e.sample === x.sample && !e.heldOut));
  const held = runs.filter((x) => x.result.publishers && x.result.profile && exps.find((e) => e.sample === x.sample && e.heldOut));
  const evalSet = (set: Run[], w: Weights, t: Thresholds) => {
    const checks = set.flatMap((x) => publisherChecks(exps.find((e) => e.sample === x.sample)!, rescore(x, w, t)).map((c) => ({ ...c, name: `${x.label} ${c.name}` })));
    return { pass: checks.filter((c) => c.pass).length, total: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.name) };
  };
  const combos: { w: Weights; t: Thresholds; pass: number }[] = [];
  for (let tone = 0.1; tone <= 0.701; tone += 0.05) {
    for (let audience = 0.1; audience <= 0.701; audience += 0.05) {
      const price = 1 - tone - audience;
      if (price < 0.099) continue;
      for (const rec of [0.5, 0.55, 0.6, 0.65]) {
        for (const weak of [0.3, 0.35, 0.4]) {
          const w = { tone: +tone.toFixed(2), audience: +audience.toFixed(2), price: +price.toFixed(2) };
          const t = { ...THRESHOLDS, recommended: rec, weak };
          combos.push({ w, t, pass: evalSet(tuning, w, t).pass });
        }
      }
    }
  }
  const current = evalSet(tuning, WEIGHTS, THRESHOLDS);
  const best = Math.max(...combos.map((c) => c.pass));
  const plateau = combos.filter((c) => c.pass === best);
  const centre = {
    tone: +(plateau.reduce((n, c) => n + c.w.tone, 0) / plateau.length).toFixed(2),
    audience: +(plateau.reduce((n, c) => n + c.w.audience, 0) / plateau.length).toFixed(2),
    price: +(plateau.reduce((n, c) => n + c.w.price, 0) / plateau.length).toFixed(2),
  };
  const mode = <T>(xs: T[]) => [...xs].sort((a, b) => xs.filter((x) => x === b).length - xs.filter((x) => x === a).length)[0];
  const centreT = { ...THRESHOLDS, recommended: mode(plateau.map((c) => c.t.recommended)), weak: mode(plateau.map((c) => c.t.weak)) };
  const L = ['## Grid search (publisher and viability checks, tuning samples only)', ''];
  L.push(`- Combos: ${combos.length} (weights in 0.05 steps, each ≥ 0.1; recommended ∈ {0.5, 0.55, 0.6, 0.65}; weak ∈ {0.3, 0.35, 0.4}).`);
  L.push(`- Current (tone ${WEIGHTS.tone} / audience ${WEIGHTS.audience} / price ${WEIGHTS.price}; rec ${THRESHOLDS.recommended}, weak ${THRESHOLDS.weak}): ${current.pass}/${current.total}.${current.failed.length ? ` Failing: ${current.failed.join('; ')}.` : ''}`);
  L.push(`- Best: ${best}/${current.total}, reached by ${plateau.length} combos (${((plateau.length / combos.length) * 100).toFixed(0)}% of the grid). Plateau centre: tone ${centre.tone} / audience ${centre.audience} / price ${centre.price}; rec ${centreT.recommended}, weak ${centreT.weak} → ${evalSet(tuning, centre, centreT).pass}/${current.total}.`);
  const hc = evalSet(held, WEIGHTS, THRESHOLDS);
  const hn = evalSet(held, centre, centreT);
  L.push(`- Held-out controls (#2, #11, #12): current ${hc.pass}/${hc.total}, plateau centre ${hn.pass}/${hn.total}.${hn.failed.length ? ` Failing at centre: ${hn.failed.join('; ')}.` : ''}`);
  L.push('', '| change from current | checks | flips |', '|---|---|---|');
  const base = new Set(current.failed);
  for (const k of ['tone', 'audience', 'price'] as const) {
    for (const d of [-0.1, 0.1]) {
      const raw = { ...WEIGHTS, [k]: Math.max(0.05, WEIGHTS[k] + d) };
      const sum = raw.tone + raw.audience + raw.price;
      const w = { tone: raw.tone / sum, audience: raw.audience / sum, price: raw.price / sum };
      const e = evalSet(tuning, w, THRESHOLDS);
      const flips = [...e.failed.filter((f) => !base.has(f)).map((f) => `now fails ${f}`), ...current.failed.filter((f) => !e.failed.includes(f)).map((f) => `now passes ${f}`)];
      L.push(`| ${k} ${d > 0 ? '+' : ''}${d} (renormalised) | ${e.pass}/${e.total} | ${flips.join('; ') || 'none'} |`);
    }
  }
  for (const [name, t] of [
    ['recommended 0.50', { ...THRESHOLDS, recommended: 0.5 }],
    ['recommended 0.60', { ...THRESHOLDS, recommended: 0.6 }],
    ['weak 0.30', { ...THRESHOLDS, weak: 0.3 }],
    ['weak 0.40', { ...THRESHOLDS, weak: 0.4 }],
  ] as const) {
    const e = evalSet(tuning, WEIGHTS, t);
    const flips = [...e.failed.filter((f) => !base.has(f)).map((f) => `now fails ${f}`), ...current.failed.filter((f) => !e.failed.includes(f)).map((f) => `now passes ${f}`)];
    L.push(`| ${name} | ${e.pass}/${e.total} | ${flips.join('; ') || 'none'} |`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- stability

async function stability(): Promise<string> {
  const L = ['## Stability (understand ×3, cache reads off)', '', '| sample | runs (clarity, × viability when clear) | stable |', '|---|---|---|'];
  let unstable = 0;
  for (const n of MESSY) {
    const input = sampleInputs[n - 1].input;
    const outs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ctx = evalCtx({ read: false });
      const u = await callLLM(understandModule, { input }, ctx);
      await Promise.allSettled(ctx.deferred.map((t) => t()));
      const p = finalizeProfile(u.output, input);
      // Viability only matters for clear inputs: vague and no-signal inputs stop after understand whatever it says.
      outs.push(`${p.triage.clarity}${p.triage.clarity === 'clear' ? ` × ${p.triage.viability}` : ''}${p.triage.policy_banned ? ' banned' : ''}`);
    }
    const stable = outs.every((o) => o === outs[0]);
    if (!stable) unstable++;
    L.push(`| #${n} | ${outs.join(' / ')} | ${stable ? 'yes' : 'NO'} |`);
  }
  L.push('', unstable ? `${unstable} messy sample(s) changed class across repeats.` : 'Every messy sample kept its class across three live repeats.');
  return L.join('\n');
}

// ---------------------------------------------------------------- write cache + replay verify

async function writeCache(): Promise<number> {
  const exps = resolveNames();
  pendingCommitted.clear();
  const inputs = new Map<string, string>();
  // Default: reuse committed entries whose keys still match (only changed prompts go live, chips stay stable).
  // --fresh: every call live.
  const fresh = has('--fresh');
  const o = { read: !fresh, write: true, wallMs: 120_000 };
  console.log(`\nCanonical runs (no wall, ${fresh ? 'cache reads off' : 'reusing entries whose keys still match'}):`);
  const runs = await pool([...sampleInputs, injectionInput], Number(argVal('--concurrency') ?? 3), (x) => runOne(x.label, x.sample, x.input, o));
  for (const r of runs) inputs.set(r.input, r.label);
  // Chip follow-ups: each vague sample's interpretation chips become inputs of record.
  const chips = runs.flatMap((r) => (r.result.profile?.triage.clarity === 'vague' ? r.result.profile.chips.map((c) => ({ label: `${r.label} chip: ${c.label}`, sample: null, input: normalizeInput(c.text) })) : []));
  console.log(`\nChip follow-ups (${chips.length}):`);
  const chipRuns = await pool(chips, Number(argVal('--concurrency') ?? 3), (x) => runOne(x.label, null, x.input, o));
  for (const r of chipRuns) inputs.set(r.input, r.label);

  const problems = writeGuard(
    [...runs, ...chipRuns].map((r) => ({
      label: r.label,
      errors: r.result.summary.errors.map((e) => `${e.stage}:${e.code}`),
      unverified: r.result.creatives.some((c) => !c.error && !!c.critic?.unverified),
    })),
    committedCache.inputs,
    new Set(inputs.keys()),
  );
  if (problems.length) {
    console.error(`\nRefusing to write the committed cache:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const out = { version: 1, inputs: Object.fromEntries(inputs), entries: Object.fromEntries([...pendingCommitted].sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync('data/cache/committed.json', JSON.stringify(out) + '\n');
  console.log(`\nWrote data/cache/committed.json: ${inputs.size} inputs, ${pendingCommitted.size} entries.`);
  const scored = score(runs.filter((r) => r.sample !== null), exps, true);
  scored[0].inv.push(injectionCheck(runs[0].result, runs.find((r) => r.sample === null)!.result));
  writeFileSync('eval/output.md', reportMarkdown(scored, [], '--write-cache'));
  console.log('Wrote eval/output.md from the canonical runs.');
  console.log('\nReplay check in a fresh process (reads the new file):');
  try {
    execFileSync('npx', ['tsx', '--conditions=react-server', 'scripts/eval.ts', '--verify-replay'], { stdio: 'inherit' });
  } catch {
    return 1;
  }
  return 0;
}

async function verifyReplay(): Promise<number> {
  let bad = 0;
  for (const [input, label] of Object.entries(committedCache.inputs)) {
    const r = await runOne(label, null, input, { read: true, replayOnly: true });
    const live = r.result.summary.calls.filter((c) => c.source === 'live').length;
    if (live || r.result.summary.errors.length) {
      bad++;
      console.error(`  ✗ ${label}: ${live} live calls, errors ${r.result.summary.errors.map((e) => `${e.stage}:${e.code}`).join(',') || 'none'}`);
    }
  }
  console.log(bad ? `\n${bad} committed input(s) do not replay cleanly.` : `\nAll ${Object.keys(committedCache.inputs).length} committed inputs replay with zero provider calls.`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------- bake-off

async function bakeoff(runs: Run[], exps: Expectation[]): Promise<string> {
  const tuning = runs.filter((x) => x.result.publishers && x.result.profile && exps.find((e) => e.sample === x.sample && !e.heldOut));
  const ctx = () => evalCtx({ read: true, wallMs: 120_000 });
  const L = ['# Bake-offs', '', `Run ${new Date().toISOString().slice(0, 10)} on the ${tuning.length} tuning samples that reach scoring. Every arm is scored by the same publisher/viability checks (\`eval/checks.ts\`).`, ''];
  const pubPass = (set: { run: Run; r: ReturnType<typeof rescore> }[]) => {
    const cs = set.flatMap(({ run, r }) => publisherChecks(exps.find((e) => e.sample === run.sample)!, r));
    return `${cs.filter((c) => c.pass).length}/${cs.length}`;
  };
  const rubric = pubPass(tuning.map((run) => ({ run, r: rescore(run, WEIGHTS, THRESHOLDS) })));

  // (a) Embedding-only scorer: rank by retrieval similarity; top 3 recommended, next 4 weak.
  const embedArm = tuning.map((run) => {
    const ranked = [...run.result.publishers!].sort((a, b) => (b.retrieval_similarity ?? 0) - (a.retrieval_similarity ?? 0));
    const publishers = ranked.map((s, i) => ({ ...s, score: 1 - i / ranked.length, band: (i < 3 ? 'recommended' : i < 7 ? 'weak' : 'excluded') as 'recommended' | 'weak' | 'excluded' }));
    return { run, r: { ...run.result, publishers, triage: run.result.profile!.triage } };
  });
  const hasSim = tuning.some((x) => x.result.publishers!.some((s) => s.retrieval_similarity !== null));
  L.push('## Embedding-only scorer vs LLM rubric', '', '| arm | publisher checks |', '|---|---|', `| LLM rubric + code (live design) | ${rubric} |`, `| embedding similarity only (top 3 recommended, next 4 weak) | ${hasSim ? pubPass(embedArm) : 'no similarities in this run'} |`, '');

  // (b) Understand + scoring on Luna.
  const lunaArm: { run: Run; r: ReturnType<typeof rescore> }[] = [];
  let lunaClarity = 0;
  const lunaMs: number[] = [];
  for (const run of tuning) {
    const c = ctx();
    const t0 = Date.now();
    const [u, s] = await Promise.all([
      callLLM(understandModule, { input: run.input }, c, { modelId: MODEL_IDS.luna, timeoutMs: OFFLINE_TIMEOUT_MS }),
      callLLM(scorePublishersModule, publisherScoringArgs(run.input, catalog.publisherIds), c, { modelId: MODEL_IDS.luna, timeoutMs: OFFLINE_TIMEOUT_MS }),
    ]);
    lunaMs.push(Date.now() - t0);
    const profile = finalizeProfile(u.output, run.input);
    if (exps.find((e) => e.sample === run.sample)!.clarity.includes(profile.triage.clarity)) lunaClarity++;
    const scores = scorePublishers(profile, PUBLISHERS, s.output.scores);
    lunaArm.push({ run, r: { ...run.result, profile, publishers: scores, triage: { ...profile.triage, viability: resolveViability(profile.triage.viability, scores).viability } } });
  }
  const solClarity = tuning.filter((run) => exps.find((e) => e.sample === run.sample)!.clarity.includes(run.result.profile!.triage.clarity)).length;
  L.push('## Understand + scoring on the cheaper model', '', '| arm | clarity correct | publisher checks | understand ‖ scoring wall p50 |', '|---|---|---|---|');
  L.push(`| ${MODEL_IDS.sol} (live design) | ${solClarity}/${tuning.length} | ${rubric} | see eval/output.md |`);
  L.push(`| ${MODEL_IDS.luna} | ${lunaClarity}/${tuning.length} | ${pubPass(lunaArm)} | ${pct(lunaMs, 50)} ms |`, '');

  // (c) Critic on Sol vs Luna, same final copy.
  let agree = 0;
  let total = 0;
  let solStricter = 0;
  let lunaStricter = 0;
  for (const run of tuning) {
    for (const card of run.result.creatives.filter((x) => !x.error)) {
      const j = run.result.judgments!.find((x) => x.persona_id === card.persona_id)!;
      const args = {
        facts: run.result.profile!.facts,
        offer: null,
        creatives: [
          {
            id: card.id,
            persona_name: personaName(card.persona_id),
            preferences_to_use: j.preferences_to_use,
            disinterests_to_avoid: j.disinterests_to_avoid,
            heading: card.heading,
            subheading: card.subheading,
            cta: card.cta,
            claims_used: card.claims_used,
            publisher_notes: [...new Set(j.publisher_ids)].sort().map((id) => `${pubName(id)}: ${PUBLISHERS.find((p) => p.id === id)?.notes}`),
          },
        ],
      };
      const pair = await Promise.all([callLLM(criticModule, args, ctx(), { timeoutMs: OFFLINE_TIMEOUT_MS }), callLLM(criticModule, args, ctx(), { modelId: MODEL_IDS.sol, timeoutMs: OFFLINE_TIMEOUT_MS })]).catch((e) => {
        console.warn(`  critic pair failed on ${run.label} ${card.id}: ${(e as Error).message}`);
        return null;
      });
      if (!pair) continue;
      const [luna, sol] = pair;
      const lf = new Set(luna.output.verdicts[0]?.failures.map((f) => f.rule) ?? []);
      const sf = new Set(sol.output.verdicts[0]?.failures.map((f) => f.rule) ?? []);
      for (const rule of CRITIC_RULES) {
        total++;
        if (lf.has(rule) === sf.has(rule)) agree++;
        else if (sf.has(rule)) solStricter++;
        else lunaStricter++;
      }
    }
  }
  L.push('## Critic: Luna (live) vs Sol on the same final copy', '', `- Rule-level agreement ${agree}/${total} (${total ? ((agree / total) * 100).toFixed(0) : 0}%). Sol flagged ${solStricter} rule(s) Luna passed; Luna flagged ${lunaStricter} Sol passed.`, '');

  // (d) Effort: scoring and personas at medium vs low.
  const medScoring: { run: Run; r: ReturnType<typeof rescore> }[] = [];
  const msLow: number[] = [];
  const msMed: number[] = [];
  let medOverLiveTimeout = 0;
  let medFailed = 0;
  let personaTopSame = 0;
  let personaPickSame = 0;
  const personaMsLow: number[] = [];
  const personaMsMed: number[] = [];
  const fresh = () => evalCtx({ read: false, wallMs: 120_000 });
  for (const run of tuning) {
    const args = publisherScoringArgs(run.input, catalog.publisherIds);
    // Both arms timed fresh, so the comparison is like for like (replays carry no timings).
    let t0 = Date.now();
    await callLLM(scorePublishersModule, args, fresh(), { timeoutMs: OFFLINE_TIMEOUT_MS });
    msLow.push(Date.now() - t0);
    try {
      t0 = Date.now();
      const s = await callLLM(scorePublishersModule, args, fresh(), { reasoning: 'medium' as Reasoning, timeoutMs: OFFLINE_TIMEOUT_MS });
      const took = Date.now() - t0;
      msMed.push(took);
      if (took > CALL_TIMEOUT_MS) medOverLiveTimeout++;
      const scores = scorePublishers(run.result.profile!, PUBLISHERS, s.output.scores);
      medScoring.push({ run, r: { ...run.result, publishers: scores, triage: { ...run.result.profile!.triage, viability: resolveViability(run.result.profile!.triage.viability, scores).viability } } });
    } catch (e) {
      medFailed++;
      console.warn(`  medium scoring failed on ${run.label}: ${(e as Error).message}`);
    }
    if (!run.result.personas) continue;
    const judgeAll = async (effort: Reasoning) => {
      const t = Date.now();
      const js = await Promise.all(PERSONAS.map((p) => callLLM(scorePersonaModule, personaScoringArgs(run.input, p, catalog.publisherIds), fresh(), { reasoning: effort, timeoutMs: OFFLINE_TIMEOUT_MS }).then((r) => ({ persona_id: p.id, ...r.output }))));
      return { js, ms: Date.now() - t };
    };
    try {
      const lo = await judgeAll('low');
      personaMsLow.push(lo.ms);
      const med = await judgeAll('medium');
      personaMsMed.push(med.ms);
      const picks = scorePersonas(run.result.profile!, PERSONAS, med.js, []).filter((x) => x.picked).map((x) => x.persona_id);
      const lowPicks = scorePersonas(run.result.profile!, PERSONAS, lo.js, []).filter((x) => x.picked).map((x) => x.persona_id);
      if (picks[0] === lowPicks[0]) personaTopSame++;
      if (picks.slice().sort().join() === lowPicks.slice().sort().join()) personaPickSame++;
    } catch (e) {
      console.warn(`  persona effort arm failed on ${run.label}: ${(e as Error).message}`);
    }
  }
  const personaRuns = tuning.filter((x) => x.result.personas).length;
  L.push('## Reasoning effort: low (live) vs medium', '', '| step | low | medium |', '|---|---|---|');
  L.push(`| scoring: publisher checks | ${rubric} | ${pubPass(medScoring)} (${medFailed} failed) |`);
  L.push(`| scoring: wall p50 / max | ${pct(msLow, 50)} / ${Math.max(0, ...msLow)} ms | ${pct(msMed, 50)} / ${Math.max(0, ...msMed)} ms |`);
  L.push(`| scoring: over the live 25 s call timeout | ${msLow.filter((x) => x > CALL_TIMEOUT_MS).length}/${msLow.length} | ${medOverLiveTimeout}/${msMed.length} |`);
  L.push(`| personas: same top persona, low vs medium | ${personaTopSame}/${personaRuns} | |`);
  L.push(`| personas: same picked set, low vs medium | ${personaPickSame}/${personaRuns} | |`);
  L.push(`| personas: ten parallel calls, wall p50 | ${pct(personaMsLow, 50)} ms | ${pct(personaMsMed, 50)} ms |`, '');

  // (e) Creatives: low vs medium first drafts, judged.
  const judged = { low: new Map<string, number>(), medium: new Map<string, number>() };
  let drafts = 0;
  for (const run of tuning) {
    if (!run.result.personas) continue;
    for (const card of run.result.creatives.filter((x) => !x.error)) {
      const p = run.result.personas.find((x) => x.persona_id === card.persona_id)!;
      const persona = PERSONAS.find((x) => x.id === card.persona_id)!;
      const args = creativeArgs(run.result.profile!, { ...p, name: persona.name, description: persona.description }, null);
      const med = await callLLM(creativeModule, args, ctx(), { reasoning: 'medium' as Reasoning, timeoutMs: OFFLINE_TIMEOUT_MS }).catch(() => null);
      if (!med) continue;
      const low = { heading: card.revised_from?.heading ?? card.heading, subheading: card.revised_from?.subheading ?? card.subheading, cta: card.cta };
      const judge = (h: string, s: string, cta: string) =>
        callLLM(judgeModule, { facts: run.result.profile!.facts.map((f) => f.text), offer: null, persona: { name: persona.name, preferences: p.preferences_to_use, disinterests: p.disinterests_to_avoid }, heading: h, subheading: s, cta }, ctx(), { timeoutMs: OFFLINE_TIMEOUT_MS });
      const judged2 = await Promise.all([judge(low.heading, low.subheading, low.cta), judge(med.output.heading, med.output.subheading, med.output.cta)]).catch(() => null);
      if (!judged2) continue;
      const [jl, jm] = judged2;
      drafts++;
      for (const v of jl.output.verdicts) if (v.pass) judged.low.set(v.criterion, (judged.low.get(v.criterion) ?? 0) + 1);
      for (const v of jm.output.verdicts) if (v.pass) judged.medium.set(v.criterion, (judged.medium.get(v.criterion) ?? 0) + 1);
    }
  }
  L.push('## Creatives: low (live) vs medium first drafts, judged by Luna', '', '| criterion | low | medium |', '|---|---|---|');
  for (const c of JUDGE_CRITERIA) L.push(`| ${c} | ${judged.low.get(c) ?? 0}/${drafts} | ${judged.medium.get(c) ?? 0}/${drafts} |`);
  L.push('');

  // (f) Position bias: the catalog in reverse order.
  const reversed = { ...scorePublishersModule, id: 'score-publishers-reversed', instructions: scorePublishersModule.instructions.replace(/Catalog:\n(\[[\s\S]*?\])\n/, (_m, json: string) => `Catalog:\n${JSON.stringify((JSON.parse(json) as unknown[]).reverse())}\n`) };
  let dCat = 0;
  let dTone = 0;
  let n = 0;
  for (const run of tuning) {
    const r = await callLLM(reversed, publisherScoringArgs(run.input, catalog.publisherIds), ctx(), { timeoutMs: OFFLINE_TIMEOUT_MS }).catch(() => null);
    if (!r) continue;
    for (const s of r.output.scores) {
      const f = run.result.publishers!.find((x) => x.publisher_id === s.publisher_id);
      if (!f) continue;
      dCat += Math.abs(f.category_fit - s.category_fit);
      dTone += Math.abs(f.tone_fit - s.tone_fit);
      n++;
    }
  }
  L.push('## Position bias: catalog order reversed', '', `- Mean |Δ category_fit| ${(dCat / Math.max(1, n)).toFixed(2)}, mean |Δ tone_fit| ${(dTone / Math.max(1, n)).toFixed(2)} over ${n} publisher scores (0-5 scale). Same-order repeat noise is in the stability section of eval/output.md.`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------- judge

async function judge(runs: Run[]): Promise<void> {
  const rows: { key: string; sample: string; persona: string; heading: string; subheading: string; verdicts: Record<string, { pass: boolean; critique: string }> }[] = [];
  for (const run of runs) {
    for (const card of run.result.creatives.filter((c) => !c.error)) {
      const p = run.result.personas!.find((x) => x.persona_id === card.persona_id)!;
      const r = await callLLM(
        judgeModule,
        { facts: run.result.profile!.facts.map((f) => f.text), offer: null, persona: { name: personaName(card.persona_id), preferences: p.preferences_to_use, disinterests: p.disinterests_to_avoid }, heading: card.heading, subheading: card.subheading, cta: card.cta },
        evalCtx({ read: true, wallMs: 120_000 }),
        { timeoutMs: OFFLINE_TIMEOUT_MS },
      );
      rows.push({ key: `${run.label}-${card.id}`, sample: run.label, persona: personaName(card.persona_id), heading: card.heading, subheading: card.subheading, verdicts: Object.fromEntries(r.output.verdicts.map((v) => [v.criterion, { pass: v.pass, critique: v.critique }])) });
    }
  }
  const J = ['# Judge (Luna, binary per criterion)', '', `${rows.length} creatives from the canonical runs. A sanity check, not a metric, until κ against hand labels is ≥ 0.6.`, ''];
  J.push('| creative | persona | ' + JUDGE_CRITERIA.join(' | ') + ' |', '|---|---|' + JUDGE_CRITERIA.map(() => '---').join('|') + '|');
  for (const r of rows) J.push(`| ${r.key} | ${r.persona} | ${JUDGE_CRITERIA.map((c) => (r.verdicts[c]?.pass ? 'pass' : 'FAIL')).join(' | ')} |`);
  J.push('', '## Pass rate', '');
  for (const c of JUDGE_CRITERIA) J.push(`- ${c}: ${rows.filter((r) => r.verdicts[c]?.pass).length}/${rows.length}`);
  J.push('', '## Critiques on failures', '');
  for (const r of rows) for (const c of JUDGE_CRITERIA) if (r.verdicts[c] && !r.verdicts[c].pass) J.push(`- ${r.key} ${c}: ${r.verdicts[c].critique} ("${r.heading}" / "${r.subheading}")`);
  mkdirSync('docs/eval', { recursive: true });
  writeFileSync('docs/eval/judge.md', J.join('\n') + '\n');

  // Hand-label checklist; if one is already filled in, compute κ against it first.
  const path = 'docs/eval/hand-label-checklist.md';
  const kappa = existsSync(path) ? kappaFrom(readFileSync(path, 'utf8'), rows) : null;
  const C = ['# Hand-label checklist', '', 'Replace each `?` with `y` (pass) or `n` (fail) in your columns, then run `npm run eval -- --judge` again to get Cohen\'s κ per criterion against the judge. The judge\'s own answers are in docs/eval/judge.md; do not look before labelling.', ''];
  C.push('| key | persona | heading | subheading | ' + JUDGE_CRITERIA.join(' | ') + ' |', '|---|---|---|---|' + JUDGE_CRITERIA.map(() => '---').join('|') + '|');
  const prev = existsSync(path) ? parseLabels(readFileSync(path, 'utf8')) : new Map<string, string[]>();
  for (const r of rows) C.push(`| ${r.key} | ${r.persona} | ${r.heading} | ${r.subheading} | ${(prev.get(r.key) ?? JUDGE_CRITERIA.map(() => '?')).join(' | ')} |`);
  writeFileSync(path, C.join('\n') + '\n');
  console.log(`\nWrote docs/eval/judge.md (${rows.length} creatives) and ${path}.`);
  if (kappa) console.log(kappa);
}

function parseLabels(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6 || !/^#?\S+-c\d+$/.test(cells[1] ?? '')) continue;
    out.set(cells[1], cells.slice(-1 - JUDGE_CRITERIA.length, -1));
  }
  return out;
}

function kappaFrom(md: string, rows: { key: string; verdicts: Record<string, { pass: boolean }> }[]): string | null {
  const labels = parseLabels(md);
  const lines: string[] = [];
  for (const [ci, c] of JUDGE_CRITERIA.entries()) {
    const pairs = rows.flatMap((r) => {
      const h = labels.get(r.key)?.[ci];
      return h === 'y' || h === 'n' ? [[h === 'y', !!r.verdicts[c]?.pass] as const] : [];
    });
    if (pairs.length < 5) continue;
    const po = pairs.filter(([a, b]) => a === b).length / pairs.length;
    const pa = pairs.filter(([a]) => a).length / pairs.length;
    const pb = pairs.filter(([, b]) => b).length / pairs.length;
    const pe = pa * pb + (1 - pa) * (1 - pb);
    const k = pe === 1 ? 1 : (po - pe) / (1 - pe);
    lines.push(`  ${c}: κ = ${k.toFixed(2)} over ${pairs.length} labels (agreement ${(po * 100).toFixed(0)}%)`);
  }
  return lines.length ? `Cohen's κ, judge vs hand labels:\n${lines.join('\n')}` : null;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  if (has('--write-cache') && (has('--bakeoff') || has('--judge'))) {
    console.error('--write-cache cannot be combined with --bakeoff or --judge.');
    return 2;
  }
  const exps = resolveNames(EXPECTATIONS);
  if (has('--verify-replay')) return verifyReplay();
  if (has('--write-cache')) return writeCache();

  const fresh = has('--fresh');
  console.log(`\nEval: ${sampleInputs.length} samples + injection twin, cache ${fresh ? 'reads off' : 'on'}`);
  const runs = await pool([...sampleInputs, injectionInput], Number(argVal('--concurrency') ?? 1), (x) => runOne(x.label, x.sample, x.input, { read: !fresh }));
  const scored = score(runs.filter((r) => r.sample !== null), exps, false);
  const inj = runs.find((r) => r.label.startsWith('injection'))!;
  const injectionResult = injectionCheck(runs[0].result, inj.result);
  scored[0].inv.push(injectionResult);

  const extra: string[] = [];
  if (has('--grid')) extra.push(gridSearch(runs, exps));
  if (has('--stability')) extra.push(await stability());
  const md = reportMarkdown(scored, extra, [fresh && '--fresh', has('--grid') && '--grid', has('--stability') && '--stability'].filter(Boolean).join(' '));
  writeFileSync('eval/output.md', md);

  if (has('--bakeoff')) {
    mkdirSync('docs/eval', { recursive: true });
    writeFileSync('docs/eval/bakeoff.md', await bakeoff(runs, exps));
    console.log('Wrote docs/eval/bakeoff.md');
  }
  if (has('--judge')) await judge(runs.filter((r) => r.sample !== null));

  const failed = scored.flatMap((s) => [...s.checks, ...s.inv].filter((c) => !c.pass).map((c) => `${s.run.label}: ${c.name} (${c.detail})`));
  const total = scored.reduce((n, s) => n + s.checks.length + s.inv.length, 0);
  console.log(`\n${total - failed.length}/${total} checks pass. Wrote eval/output.md.`);
  for (const f of failed) console.log(`  ✗ ${f}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
