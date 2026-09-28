import { beforeEach, describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '@/lib/cache';
import { normalizeSettings } from '@/lib/settings';
import type { RunContext, RunEvent } from '@/lib/types';
import { PUBLISHER_IDS, personaJudgments, profiles, publisherDims } from './fixtures/llm-dims';

// The stage graph with the LLM seam mocked. callLLM's own behaviour (cache, spend, repair, validate) is covered in
// llm.test.ts; here the mock mirrors its contract: validate → one retry → schema_invalid.

type Responder = (args: Record<string, unknown>, opts: { validate?: (o: unknown) => string | null; timeoutMs?: number }, attempt: number) => unknown;

const h = vi.hoisted(() => ({
  log: [] as { id: string; args: unknown; timeoutMs?: number; signal?: AbortSignal }[],
  timeline: [] as string[],
  responders: {} as Record<string, Responder>,
  delays: {} as Record<string, number>,
}));

vi.mock('@/lib/llm', async (orig) => {
  const actual = await orig<typeof import('@/lib/llm')>();
  return {
    ...actual,
    callLLM: async (mod: { id: string }, args: Record<string, unknown>, _ctx: RunContext, opts: { validate?: (o: unknown) => string | null; timeoutMs?: number } = {}) => {
      h.log.push({ id: mod.id, args, timeoutMs: opts.timeoutMs });
      h.timeline.push(`start:${mod.id}`);
      await new Promise((r) => setTimeout(r, h.delays[mod.id] ?? 1));
      let out = h.responders[mod.id](args, opts, 1);
      if (opts.validate?.(out)) {
        out = h.responders[mod.id](args, opts, 2);
        const again = opts.validate(out);
        if (again) throw new actual.LlmError('schema_invalid', mod.id, again);
      }
      h.timeline.push(`end:${mod.id}`);
      return { output: out, source: 'live', key: mod.id, record: { module: mod.id, model: 'm', source: 'live', ms: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd: 0.001 } };
    },
  };
});
vi.mock('@/lib/embed', () => ({
  retrieveCached: async () => ({ candidates: PUBLISHER_IDS.map((id) => ({ id, similarity: null })), record: null }),
}));

const { runPipeline, CRITIC_P95_MS } = await import('@/lib/pipeline');
const { LlmError } = await import('@/lib/llm');

const { input, ...u1 } = profiles[1];

function defaults() {
  h.responders = {
    understand: () => u1,
    'score-publishers': () => ({ scores: publisherDims[1], comparatives: [] }),
    'score-persona': (a) => {
      const j = personaJudgments[1].find((x) => x.persona_id === (a.persona as { id: string }).id)!;
      return Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'persona_id'));
    },
    creative: (a) => {
      const persona = a.persona as { name: string };
      return { heading: `Joint care for ${persona.name}`.slice(0, 50), subheading: 'Grain-free, vet-formulated, subscription-based food for senior dogs.', cta: 'Shop Now', angle: 'senior joint care', claims_used: ['f3'], disclosure: null };
    },
    critic: (a) => ({
      verdicts: (a.creatives as { id: string }[]).map((c) => ({ creative_id: c.id, failures: [] })),
    }),
    'creative-revise': () => ({ heading: 'Revised heading', subheading: 'Grain-free, vet-formulated, subscription-based.', cta: 'Shop Now', angle: 'revised', claims_used: ['f3'], disclosure: null }),
  };
  h.delays = {};
}

function ctx(over: Partial<RunContext> = {}): RunContext & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    run_id: 'test',
    sink: (e) => events.push(e),
    wallAt: Date.now() + 29_000,
    startedAt: Date.now(),
    cacheMode: { read: true, replayOnly: false, writeCommitted: false },
    spend: null,
    defer: () => {},
    events,
    ...over,
  };
}

const ids = (id: string) => h.log.filter((l) => l.id === id);
const errorsOf = (events: RunEvent[]) => events.filter((e) => e.type === 'error');

beforeEach(() => {
  h.log.length = 0;
  h.timeline.length = 0;
  defaults();
});

describe('runPipeline (mocked LLM)', () => {
  test('#1 happy path: Pawline > Ruffco > Tailcrate, 3-5 creatives, budget sums, understand ‖ scoring ‖ personas', async () => {
    const c = ctx();
    const r = await runPipeline(input, normalizeSettings(), c, { today: '2026-09-28' });
    const order = r.publishers!.filter((s) => s.band !== 'excluded').map((s) => s.publisher_id);
    expect(order.slice(0, 3)).toEqual(['pub_007', 'pub_009', 'pub_018']);
    expect(r.creatives.length).toBeGreaterThanOrEqual(3);
    expect(r.creatives.length).toBeLessThanOrEqual(5);
    expect(r.creatives.every((cr) => cr.critic && !cr.critic.unverified)).toBe(true);
    // understand + scoring + ten personas + (creative + critic) per card; nothing failed, so no revise.
    expect(h.log.length).toBe(12 + 2 * r.creatives.length);
    const cfg = r.config!;
    expect(cfg.placements.reduce((n, p) => n + p.allocation_usd, 0)).toBeCloseTo(cfg.budget.total_usd, 2);
    // All three t=0 calls begin before any of them finishes.
    const firstEnd = h.timeline.findIndex((t) => t.startsWith('end:'));
    for (const id of ['understand', 'score-publishers', 'score-persona']) expect(h.timeline.indexOf(`start:${id}`)).toBeLessThan(firstEnd);
    expect(errorsOf(c.events)).toEqual([]);
    expect(c.events.at(-1)?.type).toBe('done');
    // Creatives are mapped to placement-eligible publishers once scoring lands.
    expect(r.creatives.some((cr) => cr.publisher_ids.includes('pub_007'))).toBe(true);
  });

  test('prompt inputs are identical under two weight sets, critic and revise included', async () => {
    // Tailcrate at tone 3 sits on the recommended boundary, so the two weight sets really change the recommended set.
    h.responders['score-publishers'] = () => ({ scores: publisherDims[1].map((d) => (d.publisher_id === 'pub_018' ? { ...d, tone_fit: 3 } : d)), comparatives: [] });
    // One creative fails the critic so revise runs too.
    h.responders.critic = (a) => ({
      verdicts: (a.creatives as { id: string }[]).map((c, i) => ({ creative_id: c.id, failures: i === 0 ? [{ rule: 'grounded', fix: 'drop the claim' }] : [] })),
    });
    const r1 = await runPipeline(input, normalizeSettings(), ctx(), { weights: { tone: 0.4, audience: 0.3, price: 0.3 } });
    const calls1 = h.log.map((l) => canonicalJson({ id: l.id, args: l.args })).sort();
    h.log.length = 0;
    const r2 = await runPipeline(input, normalizeSettings(), ctx(), { weights: { tone: 0, audience: 1, price: 0 } });
    const calls2 = h.log.map((l) => canonicalJson({ id: l.id, args: l.args })).sort();
    // The weights did change the arithmetic, so equality below is not vacuous.
    expect(r1.publishers!.map((s) => s.score)).not.toEqual(r2.publishers!.map((s) => s.score));
    const rec = (r: typeof r1) => r.publishers!.filter((s) => s.band === 'recommended').map((s) => s.publisher_id);
    expect(rec(r1)).not.toEqual(rec(r2));
    expect(calls1.some((c) => c.includes('"creative-revise"'))).toBe(true);
    expect(calls1.some((c) => c.includes('"critic"'))).toBe(true);
    expect(calls2).toEqual(calls1);
  });

  test('scoring misses an id twice → scoring error, no config; personas branch still completes', async () => {
    const missing = publisherDims[1].filter((d) => d.publisher_id !== 'pub_020');
    h.responders['score-publishers'] = () => ({ scores: missing, comparatives: [] });
    const c = ctx();
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(ids('score-publishers')).toHaveLength(1);
    expect(r.publishers).toBeNull();
    expect(r.config).toBeNull();
    expect(r.creatives.length).toBeGreaterThanOrEqual(3);
    expect(errorsOf(c.events)).toMatchObject([{ stage: 'score_publishers', code: 'schema_invalid' }]);
    expect(c.events.some((e) => e.type === 'stage' && e.stage === 'config' && e.status === 'skipped')).toBe(true);
  });

  test('scoring misses an id once → retry succeeds, run completes', async () => {
    const missing = publisherDims[1].filter((d) => d.publisher_id !== 'pub_020');
    h.responders['score-publishers'] = (_a, _o, attempt) => ({ scores: attempt === 1 ? missing : publisherDims[1], comparatives: [] });
    const r = await runPipeline(input, normalizeSettings(), ctx());
    expect(r.config).not.toBeNull();
  });

  test('personas fail → no creatives, no config, scoring and exclusions still emitted, one error event', async () => {
    h.responders['score-persona'] = () => {
      throw new LlmError('schema_invalid', 'score-persona', 'bad');
    };
    const c = ctx();
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(ids('creative')).toHaveLength(0);
    expect(r.config).toBeNull();
    expect(r.publishers).not.toBeNull();
    expect(c.events.some((e) => e.type === 'stage' && e.stage === 'score_publishers' && e.status === 'done')).toBe(true);
    expect(errorsOf(c.events)).toHaveLength(1);
  });

  test('one creative call fails → the rest ship, the failed card carries an error', async () => {
    let n = 0;
    const ok = h.responders.creative;
    h.responders.creative = (a, o, at) => {
      if (n++ === 0) throw new LlmError('timeout', 'creative', 'slow');
      return ok(a, o, at);
    };
    const c = ctx();
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(r.creatives.filter((cr) => cr.error)).toHaveLength(1);
    expect(r.creatives.filter((cr) => !cr.error).length).toBe(r.creatives.length - 1);
    expect(r.config!.creatives.every((cr) => !cr.error)).toBe(true);
    expect(errorsOf(c.events)).toMatchObject([{ stage: 'creative', code: 'timeout' }]);
  });

  test('all but one creative fail → one shipped, done still emitted', async () => {
    let n = 0;
    const ok = h.responders.creative;
    h.responders.creative = (a, o, at) => {
      if (n++ > 0) throw new LlmError('provider_error', 'creative', 'x');
      return ok(a, o, at);
    };
    const c = ctx();
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(r.creatives.filter((cr) => !cr.error)).toHaveLength(1);
    expect(c.events.at(-1)?.type).toBe('done');
    expect(r.config).not.toBeNull();
  });

  test('wall too close for the critic → critic and revise skipped, creatives unverified, config built', async () => {
    const c = ctx({ wallAt: Date.now() + CRITIC_P95_MS - 1_000 });
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(ids('critic')).toHaveLength(0);
    expect(r.creatives.every((cr) => cr.critic?.unverified)).toBe(true);
    expect(r.config).not.toBeNull();
    expect(r.summary.skipped).toEqual(expect.arrayContaining(['critic', 'revise']));
  });

  test('critic gets only the time left before the wall; timing out there → unverified', async () => {
    const c = ctx({ wallAt: Date.now() + CRITIC_P95_MS + 500 });
    h.responders.critic = (_a, o) => {
      throw new LlmError('timeout', 'critic', `took longer than ${o.timeoutMs}`);
    };
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(ids('critic')[0].timeoutMs).toBeLessThanOrEqual(CRITIC_P95_MS + 500);
    expect(r.creatives.every((cr) => cr.critic?.unverified)).toBe(true);
    expect(r.config).not.toBeNull();
  });

  test('abort during personas → no creative calls, exactly one aborted error', async () => {
    const ac = new AbortController();
    h.responders['score-persona'] = () => {
      ac.abort();
      throw new LlmError('aborted', 'score-persona', 'aborted');
    };
    const c = ctx({ signal: ac.signal });
    await runPipeline(input, normalizeSettings(), c);
    expect(ids('creative')).toHaveLength(0);
    expect(errorsOf(c.events).filter((e) => e.type === 'error' && e.code === 'aborted')).toHaveLength(1);
  });

  test('vague input stops after understand: no scoring calls, config skipped, chips kept', async () => {
    const text = 'A new kind of thing for moms.';
    h.responders.understand = () => ({
      ...u1,
      facts: [],
      triage: { clarity: 'vague', viability: 'weak', policy_banned: false, reason: 'unclear product' },
      chips: [{ label: 'Baby gear', text: 'A new kind of baby carrier for moms.', quote: 'for moms' }],
    });
    const deferred: Array<() => Promise<void>> = [];
    const c = ctx({ defer: (t) => deferred.push(t) });
    const r = await runPipeline(text, normalizeSettings(), c);
    // Scoring and personas started beside understand and are released, not aborted, once understand says stop:
    // one deferred task waits for them so their spend settles at the real cost after the response.
    expect(new Set(h.log.map((l) => l.id))).toEqual(new Set(['score-persona', 'score-publishers', 'understand']));
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(h.timeline.filter((t) => t.startsWith('end:score-persona'))).toHaveLength(10);
    // Late calls never change the summary already sent.
    expect(r.summary.calls.map((x) => x.module)).toEqual(['understand']);
    expect(ids('creative')).toHaveLength(0);
    expect(r.profile!.chips).toHaveLength(1);
    expect(r.config).toBeNull();
    expect(errorsOf(c.events)).toEqual([]);
  });

  test('understand fails → every other stage settles (skipped), none is left started', async () => {
    h.responders.understand = () => {
      throw new LlmError('timeout', 'understand', 'slow');
    };
    const c = ctx();
    await runPipeline(input, normalizeSettings(), c);
    const last = new Map<string, string>();
    for (const e of c.events) if (e.type === 'stage') last.set(e.stage, e.status);
    for (const e of c.events) if (e.type === 'error') last.set(e.stage, 'error');
    expect([...last].filter(([, st]) => st === 'started')).toEqual([]);
    expect(last.get('score_publishers')).toBe('skipped');
    expect(c.events.at(-1)!.type).toBe('done');
  });

  test('policy-banned input: the streamed config event already carries the Policy warning', async () => {
    h.responders.understand = () => ({ ...u1, triage: { ...u1.triage, policy_banned: true, reason: 'nicotine' } });
    // Serialise at emit time, as the route does: a warning mutated in after the event would be missing here.
    const sentEvents: string[] = [];
    const r = await runPipeline('Premium nicotine pouches in six flavours.', normalizeSettings(), ctx({ sink: (e) => sentEvents.push(JSON.stringify(e)) }));
    expect(r.config!.budget.total_usd).toBe(0);
    const sent = sentEvents.map((x) => JSON.parse(x)).find((e) => e.type === 'stage' && e.stage === 'config' && e.status === 'done') as { payload: { config: { warnings: string[] } } };
    expect(sent.payload.config.warnings[0]).toMatch(/^Policy:/);
  });

  test('model says none but scores overrule → personas run after scoring, weak budget', async () => {
    h.responders.understand = () => ({ ...u1, triage: { clarity: 'clear', viability: 'none', policy_banned: false, reason: 'x' } });
    const c = ctx();
    const r = await runPipeline(input, normalizeSettings(), c);
    expect(r.triage!.viability).toBe('weak');
    const doneAt = (stage: string) => c.events.findIndex((e) => e.type === 'stage' && e.stage === stage && e.status === 'done');
    expect(doneAt('score_personas')).toBeGreaterThan(doneAt('score_publishers'));
    expect(r.personas).not.toBeNull();
    expect(r.config!.budget.viability_factor).toBe(0.4);
  });

  test('model says none and scores agree → $0 config, no personas', async () => {
    h.responders.understand = () => ({ ...u1, triage: { clarity: 'clear', viability: 'none', policy_banned: false, reason: 'x' } });
    h.responders['score-publishers'] = () => ({ scores: publisherDims[1].map((d) => ({ ...d, category_fit: 0 })), comparatives: [] });
    const deferred: Array<() => Promise<void>> = [];
    const r = await runPipeline(input, normalizeSettings(), ctx({ defer: (t) => deferred.push(t) }));
    expect(deferred).toHaveLength(1); // the persona calls, released
    expect(ids('creative')).toHaveLength(0);
    expect(r.personas).toBeNull();
    expect(r.config!.budget.total_usd).toBe(0);
    expect(r.config!.placements).toEqual([]);
  });
});
