// CLI runner: the full pipeline through the same RunContext the route uses (wall included).
//
//   npm run run -- --sample 7
//   npm run run -- --text "We sell ..."
//   npm run run -- --sample 1 --live      (bypass cache reads)
//   npm run run -- --sample 1 --json      (full result as JSON)

import { existsSync, readFileSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

import { personas, publishers, sampleAdvertisers } from '../lib/data';
import { RUN_WALL_MS, runPipeline, type PipelineResult } from '../lib/pipeline';
import { normalizeInput, normalizeSettings } from '../lib/settings';
import type { RunContext } from '../lib/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function makeCliContext(opts: { live?: boolean } = {}): RunContext & { deferred: Array<() => Promise<void>> } {
  const deferred: Array<() => Promise<void>> = [];
  return {
    run_id: `cli-${Date.now()}`,
    sink: (e) => {
      if (e.type === 'stage') console.log(`  [${e.stage}] ${e.status}${e.source ? ` (${e.source})` : ''}${e.ms ? ` ${e.ms}ms` : ''}`);
      if (e.type === 'error') console.log(`  [${e.stage}] ERROR ${e.code}: ${e.message}`);
    },
    wallAt: Date.now() + RUN_WALL_MS,
    startedAt: Date.now(),
    cacheMode: { read: !opts.live, replayOnly: false, writeCommitted: false },
    spend: null,
    defer: (t) => deferred.push(t),
    deferred,
  };
}

async function main() {
  const samples = sampleAdvertisers(readFileSync('data/example_advertisers.txt', 'utf8'));
  const n = arg('--sample');
  const input = normalizeInput(n ? samples[Number(n) - 1] : arg('--text') ?? '');
  if (!input) throw new Error('Pass --sample N or --text "..."');
  console.log(`\nInput: ${input}\n`);

  const ctx = makeCliContext({ live: process.argv.includes('--live') });
  const r = await runPipeline(input, normalizeSettings(), ctx);
  await Promise.allSettled(ctx.deferred.map((t) => t()));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  printReport(r);
}

function printReport(r: PipelineResult) {
  const p = r.profile;
  const name = (id: string) => publishers.find((x) => x.id === id)?.name ?? personas.find((x) => x.id === id)?.name ?? id;
  if (p) {
    console.log(`\ntriage: clarity=${p.triage.clarity} viability=${p.triage.viability}${r.triage && r.triage.viability !== p.triage.viability ? ` → resolved ${r.triage.viability}` : ''} banned=${p.triage.policy_banned}  mode=${r.mode}${r.modeWhy ? ` (${r.modeWhy})` : ''}`);
    console.log(`profile: ${p.primary_category} [${p.subcategories.join(', ')}] | ${p.product} | price ${p.price ? `$${p.price.low}-${p.price.high} ${p.price.basis}` : 'none'} ${p.price_tier}`);
    console.log(`facts: ${p.facts.map((f) => `${f.id}="${f.text}"`).join(' | ')}`);
    if (p.chips.length) console.log(`chips: ${p.chips.map((c) => `[${c.label}] ${c.text}`).join(' | ')}`);
  }
  if (r.viabilityNote) console.log(`viability note: ${r.viabilityNote}`);
  if (r.publishers) {
    console.log('\npublishers:');
    for (const s of r.publishers.filter((x) => x.band !== 'excluded')) {
      console.log(`  ${String(Math.round(s.score * 100)).padStart(3)} ${s.band.padEnd(11)} ${name(s.publisher_id).padEnd(18)} cat ${s.category_fit} tone ${s.tone_fit} aud ${s.audience_fit.toFixed(2)} price ${s.price_fit.toFixed(2)} | ${s.reasons.category}`);
    }
    for (const g of r.exclusionGroups) console.log(`  excluded (${g.group}): ${g.count}`);
  }
  if (r.personas) {
    console.log('\npersonas:');
    for (const s of r.personas.filter((x) => x.picked)) {
      console.log(`  ${s.score.toFixed(2)} ${s.label.padEnd(8)} ${name(s.persona_id).padEnd(32)} fit ${s.fit}${s.conflicts.length ? ` conflicts: ${s.conflicts.map((c) => `${c.field}="${c.persona_value}" vs "${c.input_quote}"`).join('; ')}` : ''} | ${s.why}`);
    }
    const demoted = r.personas.filter((x) => !x.picked && x.conflicts.length);
    if (demoted.length) console.log(`  demoted by conflict: ${demoted.map((d) => name(d.persona_id)).join(', ')}`);
  }
  if (r.creatives.length) {
    console.log('\ncreatives:');
    for (const c of r.creatives) {
      if (c.error) {
        console.log(`  ${c.id} ${name(c.persona_id)}: ERROR ${c.error}`);
        continue;
      }
      const verdict = !c.critic ? 'no critic' : c.critic.unverified ? 'UNVERIFIED' : c.critic.pass ? 'critic pass' : `critic FAIL: ${c.critic.checks.filter((k) => !k.pass).map((k) => `${k.criterion} (${k.fix})`).join('; ')}`;
      console.log(`  ${c.id} ${name(c.persona_id)} [${c.angle}] ${verdict}${c.revised_from ? ' → REVISED' : ''}`);
      if (c.revised_from) console.log(`     before: "${c.revised_from.heading}" / "${c.revised_from.subheading}"`);
      console.log(`     "${c.heading}" (${c.char_counts.heading}) / "${c.subheading}" (${c.char_counts.subheading}) [${c.cta}] claims ${c.claims_used.join(',')}${c.grounding_flags.length ? ` FLAGS ${c.grounding_flags.join('; ')}` : ''}`);
    }
  }
  const cfg = r.config;
  if (cfg) {
    console.log(`\nconfig: budget $${cfg.budget.total_usd} (factor ${cfg.budget.viability_factor}) bid ${cfg.bidding.model} CPA $${cfg.bidding.fixed_cpa_usd}${cfg.bidding.cpc_alternative ? ` | CPC alt $${cfg.bidding.cpc_alternative.min_usd}-${cfg.bidding.cpc_alternative.max_usd}` : ''} | flight ${cfg.flight.start}→${cfg.flight.end}`);
    for (const pl of cfg.placements) console.log(`  ${name(pl.publisher_id).padEnd(18)} $${pl.allocation_usd} (${Math.round(pl.share * 100)}%) conv ${pl.conversions_range.join('-')} inv ${pl.inventory_used_pct}%`);
    for (const w of cfg.warnings) console.log(`  warning: ${w}`);
  }
  const s = r.summary;
  console.log(`\ncalls ${s.calls.length} (${s.calls.filter((c) => c.source === 'live').length} live) | cost live $${s.cost_live_usd.toFixed(4)} replayed $${s.cost_replayed_usd.toFixed(4)} | total ${s.total_ms}ms | skipped ${s.skipped.join(',') || '-'} | errors ${s.errors.map((e) => `${e.stage}:${e.code}`).join(',') || '-'}`);
  console.log(`per call: ${s.calls.map((c) => `${c.module} ${c.source} ${c.ms}ms out ${c.outputTokens} (r ${c.reasoningTokens}) in ${c.inputTokens} (cached ${c.cachedInputTokens})`).join(" | ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
