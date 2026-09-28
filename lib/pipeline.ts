import 'server-only';
import { buildConfig } from './config';
import { personas as PERSONAS, publishers as PUBLISHERS } from './data';
import { retrieveCached, type Retrieved } from './embed';
import { env } from './env';
import { consistentComparatives, groupExclusions, resolveViability, scorePublishers, WEIGHTS, type Weights } from './funnel';
import { checkLimits, groundCreative } from './grounding';
import { callLLM, LlmError, type CallOptions, type CallResult, type PromptModule } from './llm';
import { CREATIVES_MAX, PIPELINE_VERSION } from './models';
import { scorePersonas } from './personas';
import { containsSpan, finalizeProfile, runMode, type RunMode } from './profile';
import { normalizeInput } from './settings';
import type {
  AdvertiserProfile,
  CallRecord,
  CampaignConfig,
  Creative,
  ErrorCode,
  LlmPersonaJudgment,
  Persona,
  PersonaScore,
  PublisherScore,
  RunContext,
  RunEvent,
  RunSummary,
  Settings,
  Source,
  Stage,
  Triage,
} from './types';
import { creativeArgs, creativeModule, reviseModule, type CreativeOutput } from '../prompts/creative';
import { CRITIC_RULES, criticModule, type CriticArgs } from '../prompts/critic';
import { personaScoringArgs, scorePersonaModule, type ScorePersonaOutput } from '../prompts/score-personas';
import { publisherScoringArgs, scorePublishersModule, type ScorePublishersOutput } from '../prompts/score-publishers';
import { understandModule } from '../prompts/understand';

// The stage graph (F23, F25, F26): understand ‖ score publishers ‖ score personas (all at t=0, retrieval beside them)
// → per picked persona: creative → critic → revise → config.
// Everything reaches the outside world through the RunContext: events to ctx.sink, LLM calls through callLLM (cache,
// spend, abort), deferred writes through ctx.defer. Route, CLI and eval all drive this one function.

/** Run wall: optional stages (critic, revise) must finish inside it. Mandatory stages are not bounded by it. */
export const RUN_WALL_MS = 29_000;
export const CALL_TIMEOUT_MS = 25_000;
/** Per card. Measured single-card critic 4.8 s and creative 2.3-4.8 s at low (docs/eval/latency-pass1.md, U4 live runs). */
export const CRITIC_P95_MS = 6_000;
export const REVISE_P95_MS = 5_000;
/** Retrieval runs beside understand; scoring waits at most this long for it, then uses the whole catalog. */
const RETRIEVAL_WAIT_MS = 4_000;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  cache_miss: 'This sample’s cached result is stale. Run it live to refresh.',
  spend_refused: 'The demo’s live-run budget is used up for now. Cached samples still work.',
  store_error: 'The spend tracker could not be reached, so this step did not run. Try again shortly.',
  schema_invalid: 'The model returned an unusable answer twice.',
  timeout: 'The model took too long to answer.',
  aborted: 'Run cancelled.',
  provider_error: 'The model provider returned an error.',
  wall_exceeded: 'Out of time for this step.',
  dependency_failed: 'Skipped because an earlier step failed.',
};

export interface PipelineOptions {
  weights?: Weights;
  /** YYYY-MM-DD; eval pins it so the committed output is stable. */
  today?: string;
  cold?: boolean;
}

export interface PipelineResult {
  input: string;
  profile: AdvertiserProfile | null;
  mode: RunMode | null;
  modeWhy: string;
  /** Triage after resolveViability (null until scoring lands; equals the model's triage when scoring never ran). */
  triage: Triage | null;
  viabilityNote: string | null;
  publishers: PublisherScore[] | null;
  exclusionGroups: { group: string; count: number; ids: string[] }[];
  comparatives: ScorePublishersOutput['comparatives'];
  judgments: LlmPersonaJudgment[] | null;
  personas: PersonaScore[] | null;
  creatives: Creative[];
  config: CampaignConfig | null;
  summary: RunSummary;
}

/** Every candidate id scored exactly once. */
export function checkIds(got: string[], want: string[], what: string): string | null {
  const seen = new Map<string, number>();
  for (const id of got) seen.set(id, (seen.get(id) ?? 0) + 1);
  const missing = want.filter((id) => !seen.has(id));
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const unknown = [...seen.keys()].filter((id) => !want.includes(id));
  const problems = [
    missing.length ? `missing ${what} ${missing.join(', ')}` : '',
    dupes.length ? `duplicate ${what} ${dupes.join(', ')}` : '',
    unknown.length ? `unknown ${what} ${unknown.join(', ')}` : '',
  ].filter(Boolean);
  return problems.length ? problems.join('; ') : null;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

export async function runPipeline(rawInput: string, settings: Settings, ctx: RunContext, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const input = normalizeInput(rawInput);
  const weights = opts.weights ?? WEIGHTS;
  const calls: CallRecord[] = [];
  const errors: RunSummary['errors'] = [];
  const skipped: Stage[] = [];
  let aborted = false;
  // Late side calls (released in stop mode) settle their spend but never change a summary already sent.
  let finished = false;

  const result: PipelineResult = {
    input,
    profile: null,
    mode: null,
    modeWhy: '',
    triage: null,
    viabilityNote: null,
    publishers: null,
    exclusionGroups: [],
    comparatives: [],
    judgments: null,
    personas: null,
    creatives: [],
    config: null,
    summary: null as unknown as RunSummary,
  };

  const emit = (e: RunEvent) => {
    try {
      ctx.sink(e);
    } catch (err) {
      console.warn('[pipeline] sink threw', (err as Error).message);
    }
  };
  const started = (stage: Stage) => {
    emit({ type: 'stage', stage, status: 'started' });
    return Date.now();
  };
  const skip = (stage: Stage, reason: string) => {
    skipped.push(stage);
    emit({ type: 'stage', stage, status: 'skipped', payload: { reason } });
  };
  const fail = (stage: Stage, e: unknown) => {
    const err = e instanceof LlmError ? e : new LlmError('provider_error', stage, String((e as Error)?.message ?? e));
    if (err.code === 'aborted') {
      if (aborted) return;
      aborted = true;
    }
    console.error(`[pipeline] ${ctx.run_id} ${stage} failed: ${err.code}: ${err.message}`);
    errors.push({ stage, code: err.code });
    emit({ type: 'error', stage, code: err.code, message: ERROR_MESSAGES[err.code] });
  };
  /** True when the run is cancelled; records the cancellation once against the stage that noticed it. */
  const halted = (stage: Stage) => {
    if (!aborted && ctx.signal?.aborted) fail(stage, new LlmError('aborted', stage, 'aborted'));
    return aborted;
  };
  const call = async <A, O>(mod: PromptModule<A, O>, args: A, o: CallOptions<O> = {}): Promise<CallResult<O>> => {
    const r = await callLLM(mod, args, ctx, o);
    if (!finished) calls.push(r.record);
    return r;
  };
  const optionalTimeout = () => Math.min(CALL_TIMEOUT_MS, ctx.wallAt - Date.now());
  const checks = {
    criticT: null as number | null,
    criticOk: 0,
    criticWall: 0,
    criticErr: null as unknown,
    criticSources: [] as Source[],
    reviseT: null as number | null,
    reviseNeeded: 0,
    reviseWall: 0,
    reviseErr: null as unknown,
    reviseSources: [] as Source[],
  };

  const finish = (): PipelineResult => {
    finished = true;
    const live = calls.filter((c) => c.source === 'live');
    result.summary = {
      run_id: ctx.run_id,
      cost_live_usd: live.reduce((n, c) => n + c.costUsd, 0),
      cost_replayed_usd: calls.filter((c) => c.source !== 'live').reduce((n, c) => n + c.costUsd, 0),
      calls,
      total_ms: Date.now() - ctx.startedAt,
      cold: opts.cold ?? false,
      skipped,
      errors,
    };
    emit({ type: 'done', summary: result.summary });
    return result;
  };

  // ---- Stage 1: understand, with retrieval beside it (off the critical path) ----
  const retrieval: Promise<Retrieved[] | null> = retrieveCached(input, env().retrieveK, ctx)
    .then((r) => {
      if (r.record && !finished) calls.push(r.record);
      return r.candidates;
    })
    .catch((e) => {
      console.warn('[pipeline] retrieval failed; scoring the whole catalog', (e as Error).message);
      return null;
    });

  // ---- t = 0: understand ‖ score publishers ‖ score personas (F25) ----
  // Scoring and personas read the advertiser's own words, so none of the three waits for another.
  // At K = catalog size retrieval is a pass-through and stays off the critical path; below it, the two wait for it.
  if (halted('understand')) return finish();
  const allIds = PUBLISHERS.map((p) => p.id);
  const candidatesP: Promise<string[]> =
    env().retrieveK >= allIds.length
      ? Promise.resolve(allIds)
      : withTimeout(retrieval, RETRIEVAL_WAIT_MS, null).then((c) => c?.map((x) => x.id).filter((id) => allIds.includes(id)) ?? allIds);
  const t = started('understand');
  const understandP = call(understandModule, { input });
  const tScoring = started('score_publishers');
  const scoringP = candidatesP.then((ids) =>
    call(scorePublishersModule, publisherScoringArgs(input, ids), {
      validate: (o) => checkIds(o.scores.map((s) => s.publisher_id), ids, 'publisher'),
    }).then((r) => ({ r, ids })),
  );
  const tPersonas = started('score_personas');
  // One call per persona, in parallel (F27). Each settles on its own; the branch decides what a partial failure means.
  const personasP = candidatesP.then((ids) =>
    Promise.all(
      PERSONAS.map((persona) =>
        call(scorePersonaModule, personaScoringArgs(input, persona, ids)).then(
          (r) => ({ persona, r, e: null as unknown }),
          (e: unknown) => ({ persona, r: null, e }),
        ),
      ),
    ),
  );
  // Side branches may be released (stop mode); never leave their rejection unhandled.
  scoringP.catch(() => {});
  personasP.catch(() => {});
  // A released call is not aborted: it finishes after the response and settles at its real cost. Aborting it would
  // keep its whole worst-case reservation on the counter (the provider may bill an aborted call), so every vague
  // input would eat ~$0.35 of the cap for a few cents of work. A client cancel (ctx.signal) still aborts everything.
  const release = (...branches: Promise<unknown>[]) => ctx.defer(async () => void (await Promise.allSettled(branches)));

  let profile: AdvertiserProfile;
  try {
    const u = await understandP;
    profile = finalizeProfile(u.output, input);
    const gate = runMode(profile);
    Object.assign(result, { profile, mode: gate.mode, modeWhy: gate.why, triage: profile.triage });
    emit({ type: 'stage', stage: 'understand', status: 'done', source: u.source, ms: Date.now() - t, payload: { profile, mode: gate.mode, why: gate.why } });
  } catch (e) {
    release(scoringP, personasP);
    fail('understand', e);
    for (const s of ['score_publishers', 'score_personas', 'creative', 'critic', 'revise', 'config'] as Stage[]) skip(s, ERROR_MESSAGES.dependency_failed);
    await withTimeout(retrieval, RETRIEVAL_WAIT_MS, null);
    return finish();
  }
  const mode = result.mode!;

  if (mode === 'stop') {
    release(scoringP, personasP);
    for (const s of ['score_publishers', 'score_personas', 'creative', 'critic', 'revise'] as Stage[]) skip(s, result.modeWhy);
    if (profile.triage.policy_banned) {
      // Banned: a $0 config states the decision; nothing is scored.
      const triage: Triage = { ...profile.triage, viability: 'none' };
      result.triage = triage;
      buildAndEmitConfig(triage, [], [], [], [`Policy: ${result.modeWhy}`]);
    } else {
      skip('config', result.modeWhy);
    }
    await withTimeout(retrieval, RETRIEVAL_WAIT_MS, null);
    return finish();
  }

  // ---- Stage 3: publisher scores = LLM dims (already in flight) + code arithmetic on the profile ----
  const scoringStage = async (): Promise<ScorePublishersOutput | null> => {
    try {
      const { r, ids } = await scoringP;
      // Similarity is a trace column only; it never changes a score.
      const found = await withTimeout(retrieval, RETRIEVAL_WAIT_MS, null);
      const similarity = Object.fromEntries((found ?? []).filter((c) => c.similarity !== null).map((c) => [c.id, c.similarity as number]));
      const scores = scorePublishers(profile, PUBLISHERS.filter((p) => ids.includes(p.id)), r.output.scores, similarity, weights);
      const resolved = resolveViability(profile.triage.viability, scores);
      const triage: Triage = { ...profile.triage, viability: resolved.viability };
      const comparatives = consistentComparatives(r.output.comparatives, scores);
      Object.assign(result, { publishers: scores, triage, viabilityNote: resolved.message, exclusionGroups: groupExclusions(scores), comparatives });
      emit({
        type: 'stage',
        stage: 'score_publishers',
        status: 'done',
        source: r.source,
        ms: Date.now() - tScoring,
        payload: { scores, triage, viability_note: resolved.message, exclusion_groups: result.exclusionGroups, comparatives },
      });
      return r.output;
    } catch (e) {
      fail('score_publishers', e);
      return null;
    }
  };

  // ---- Stage 4 + 5: persona pick (code) on the in-flight judgments, then one chain per card: creative → critic → revise ----
  // Per-card chains (F26): a card's critic starts when its own copy lands and its revise when its own verdict lands,
  // so one slow card never holds the others; and a card's critic key does not depend on which other personas were picked.
  const personasBranch = async (): Promise<void> => {
    try {
      const settled = await personasP;
      const ok = settled.filter((x) => x.r !== null);
      const firstError = settled.find((x) => x.e !== null)?.e;
      // Fewer than three judged personas cannot guarantee three creatives: the stage fails. Otherwise a missing
      // persona is reported once and the pick runs on the rest.
      if (ok.length < 3) throw firstError ?? new LlmError('provider_error', 'score-persona', 'too few personas judged');
      if (firstError) fail('score_personas', firstError);
      result.judgments = ok.map(({ persona, r }) => toJudgment(persona, r!.output, input));
      // The pick never depends on publisher weights; the publisher mapping is attached once scoring lands.
      result.personas = scorePersonas(profile, PERSONAS, result.judgments, [], { max: CREATIVES_MAX });
      const sources = ok.map((x) => x.r!.source);
      emit({ type: 'stage', stage: 'score_personas', status: 'done', source: sources.includes('live') ? 'live' : sources[0], ms: Date.now() - tPersonas, payload: { personas: result.personas } });
    } catch (e) {
      fail('score_personas', e);
      for (const s of ['creative', 'critic', 'revise'] as Stage[]) skip(s, ERROR_MESSAGES.dependency_failed);
      return;
    }

    if (halted('creative')) return;
    const t1 = started('creative');
    const picked = result.personas.filter((p) => p.picked);
    result.creatives = picked.map((p, i) => emptyCreative(`c${i + 1}`, p.persona_id));
    let written = 0;
    let creativeErr: unknown = null;
    const sources: Source[] = [];
    await Promise.all(
      picked.map(async (p, i) => {
        const persona = PERSONAS.find((x) => x.id === p.persona_id)!;
        const card = result.creatives[i];
        try {
          const r = await call(creativeModule, creativeArgs(profile, { ...p, name: persona.name, description: persona.description }, settings.offer), { validate: limitsProblem });
          sources.push(r.source);
          Object.assign(card, toCreative(card.id, p.persona_id, r.output));
        } catch (e) {
          creativeErr ??= e;
          card.error = e instanceof LlmError ? ERROR_MESSAGES[e.code] : ERROR_MESSAGES.provider_error;
        }
        if (++written === picked.length) {
          if (creativeErr) fail('creative', creativeErr);
          emit({ type: 'stage', stage: 'creative', status: 'done', source: sources.includes('live') ? 'live' : sources[0], ms: Date.now() - t1, payload: { creatives: result.creatives } });
        }
        if (!card.error) await checkCard(card);
      }),
    );
    finishChecks();
  };

  const toCreative = (id: string, personaId: string, o: CreativeOutput): Creative => ({
    id,
    persona_id: personaId,
    angle: o.angle,
    heading: o.heading,
    subheading: o.subheading,
    cta: o.cta,
    offer: settings.offer,
    disclosure: o.disclosure,
    claims_used: o.claims_used,
    publisher_ids: [],
    constraints_respected: [],
    critic: null,
    revised_from: null,
    char_counts: { heading: o.heading.length, subheading: o.subheading.length },
    grounding_flags: groundCreative(o, profile.facts, settings.offer).flags,
    error: null,
  });

  // ---- Run the graph ----
  if (mode === 'full') {
    await Promise.all([scoringStage(), personasBranch()]);
  } else {
    // score_only: the model said nothing fits. Score to show why; if the scores overrule it, run the rest after.
    const scoring = await scoringStage();
    if (scoring && result.triage?.viability !== 'none') {
      await personasBranch();
    } else {
      release(personasP);
      for (const s of ['score_personas', 'creative', 'critic', 'revise'] as Stage[]) skip(s, scoring ? result.modeWhy : ERROR_MESSAGES.dependency_failed);
    }
  }

  // Map personas and creatives to the placement-eligible publishers (recommended, else weak) once both branches landed.
  const eligible = result.publishers ? eligibleIds(result.publishers) : [];
  if (result.judgments && result.personas) {
    result.personas = scorePersonas(profile, PERSONAS, result.judgments, eligible, { max: CREATIVES_MAX });
    const byPersona = new Map(result.personas.map((p) => [p.persona_id, p]));
    for (const c of result.creatives) c.publisher_ids = byPersona.get(c.persona_id)?.publisher_ids ?? [];
  }

  // ---- Stage 6: config (pure code) ----
  // Built when scoring and personas both landed, or when scoring alone decided there is nothing to run ($0 config).
  if (result.publishers && (result.personas || result.triage?.viability === 'none')) {
    buildAndEmitConfig(result.triage!, result.publishers!, result.personas ?? [], result.creatives);
  } else if (!halted('config')) {
    skip('config', ERROR_MESSAGES.dependency_failed);
  }
  return finish();

  // ---- helpers that close over the run ----

  async function checkCard(card: Creative) {
    if (halted('critic')) return;
    if (ctx.wallAt - Date.now() < CRITIC_P95_MS) {
      markUnverified([card]);
      checks.criticWall++;
      return;
    }
    checks.criticT ??= started('critic');
    try {
      const r = await call(criticModule, criticArgsFor(card), {
        timeoutMs: optionalTimeout(),
        validate: (o) => checkIds(o.verdicts.map((v) => v.creative_id), [card.id], 'creative'),
      });
      checks.criticSources.push(r.source);
      const v = r.output.verdicts[0];
      const list = CRITIC_RULES.map((rule) => {
        const f = v.failures.find((x) => x.rule === rule);
        return { criterion: rule, pass: !f, fix: f?.fix ?? null };
      });
      card.critic = { pass: list.every((k) => k.pass), checks: list, unverified: false };
      card.constraints_respected = list.filter((k) => k.pass).map((k) => k.criterion);
      checks.criticOk++;
    } catch (e) {
      checks.criticErr ??= e;
      markUnverified([card]);
      return;
    }

    if (card.critic.pass && !card.grounding_flags.length) return;
    checks.reviseNeeded++;
    if (halted('revise')) return;
    if (ctx.wallAt - Date.now() < REVISE_P95_MS) {
      checks.reviseWall++;
      return;
    }
    checks.reviseT ??= started('revise');
    const persona = PERSONAS.find((p) => p.id === card.persona_id)!;
    const pscore = result.personas!.find((p) => p.persona_id === card.persona_id)!;
    const failures = [...card.critic.checks.filter((k) => !k.pass).map((k) => `${k.criterion}: ${k.fix ?? 'fix this'}`), ...card.grounding_flags];
    try {
      const r = await call(
        reviseModule,
        creativeArgs(profile, { ...pscore, name: persona.name, description: persona.description }, settings.offer, { heading: card.heading, subheading: card.subheading, failures }),
        { timeoutMs: optionalTimeout(), validate: limitsProblem },
      );
      checks.reviseSources.push(r.source);
      const next = toCreative(card.id, card.persona_id, r.output);
      Object.assign(card, {
        revised_from: { heading: card.heading, subheading: card.subheading },
        heading: next.heading,
        subheading: next.subheading,
        cta: next.cta,
        angle: next.angle,
        disclosure: next.disclosure,
        claims_used: next.claims_used,
        char_counts: next.char_counts,
        grounding_flags: next.grounding_flags,
      });
    } catch (e) {
      checks.reviseErr ??= e;
    }
  }

  function criticArgsFor(card: Creative): CriticArgs {
    const j = result.judgments!.find((x) => x.persona_id === card.persona_id)!;
    const persona = PERSONAS.find((p) => p.id === card.persona_id)!;
    // Weight-invariant and ready as soon as the card is: the publishers this persona shops on, never the recommended set.
    // Checking against a few extra publishers' notes is conservative; waiting for scoring would put it on the critical path.
    const pubs = [...new Set(j.publisher_ids)].filter((id) => PUBLISHERS.some((p) => p.id === id)).sort();
    return {
      facts: profile.facts,
      offer: settings.offer,
      creatives: [
        {
          id: card.id,
          persona_name: persona.name,
          preferences_to_use: j.preferences_to_use,
          disinterests_to_avoid: j.disinterests_to_avoid,
          heading: card.heading,
          subheading: card.subheading,
          cta: card.cta,
          claims_used: card.claims_used,
          publisher_notes: pubs.map((id) => {
            const p = PUBLISHERS.find((x) => x.id === id)!;
            return `${p.name}: ${p.notes}`;
          }),
        },
      ],
    };
  }

  /** One stage event per check stage once every card chain has settled. */
  function finishChecks() {
    if (aborted) return;
    if (checks.criticT !== null) {
      if (checks.criticErr) fail('critic', checks.criticErr);
      emit({ type: 'stage', stage: 'critic', status: 'done', source: checks.criticSources.includes('live') ? 'live' : checks.criticSources[0], ms: Date.now() - checks.criticT, payload: { creatives: result.creatives } });
    } else {
      skip('critic', checks.criticWall ? ERROR_MESSAGES.wall_exceeded : ERROR_MESSAGES.dependency_failed);
    }
    if (checks.reviseT !== null) {
      if (checks.reviseErr) fail('revise', checks.reviseErr);
      emit({ type: 'stage', stage: 'revise', status: 'done', source: checks.reviseSources.includes('live') ? 'live' : checks.reviseSources[0], ms: Date.now() - checks.reviseT, payload: { creatives: result.creatives } });
    } else if (checks.criticOk === 0) {
      skip('revise', checks.criticWall ? ERROR_MESSAGES.wall_exceeded : ERROR_MESSAGES.dependency_failed);
    } else {
      skip('revise', checks.reviseNeeded === 0 ? 'Every creative passed.' : ERROR_MESSAGES.wall_exceeded);
    }
  }

  function markUnverified(cards: Creative[]) {
    for (const c of cards) c.critic = { pass: false, checks: [], unverified: true };
  }

  function buildAndEmitConfig(triage: Triage, pubScores: PublisherScore[], personaScores: PersonaScore[], creatives: Creative[], leadWarnings: string[] = []) {
    const t0 = started('config');
    result.config = buildConfig({
      profile,
      triage,
      settings,
      publisherScores: pubScores,
      personaScores,
      creatives: creatives.filter((c) => !c.error),
      publishers: PUBLISHERS,
      meta: {
        run_id: ctx.run_id,
        generated_at: new Date().toISOString(),
        pipeline_version: PIPELINE_VERSION,
      },
      today: opts.today ?? new Date().toISOString().slice(0, 10),
    });
    // Before the event is serialised: a warning added afterwards would never reach the page or the download.
    result.config.warnings.unshift(...leadWarnings);
    // The final persona → publisher mapping rides beside the config (the page shows it), not inside it.
    emit({ type: 'stage', stage: 'config', status: 'done', source: 'code', ms: Date.now() - t0, payload: { config: result.config, creatives: result.creatives, personas: result.personas } });
  }
}

/** Disco's character limits as a code check, so an over-long heading gets one retry instead of shipping. */
function limitsProblem(o: CreativeOutput): string | null {
  return checkLimits(o).join('; ') || null;
}

/** Model output → judgment: ids set by code, copied lists kept only where they really are the persona's own words. */
function toJudgment(persona: Persona, o: ScorePersonaOutput, input: string): LlmPersonaJudgment {
  return {
    persona_id: persona.id,
    fit: o.fit,
    conflicts: o.conflicts.filter((c) => containsSpan(input, c.input_quote)),
    why: o.why,
    preferences_to_use: o.preferences_to_use.filter((x) => persona.messaging_preferences.includes(x)),
    disinterests_to_avoid: o.disinterests_to_avoid.filter((x) => persona.disinterested_in.includes(x)),
    offer_depth: o.offer_depth,
    publisher_ids: o.publisher_ids.filter((id) => PUBLISHERS.some((p) => p.id === id)),
  };
}

function eligibleIds(scores: PublisherScore[]): string[] {
  const rec = scores.filter((s) => s.band === 'recommended');
  return (rec.length ? rec : scores.filter((s) => s.band === 'weak')).map((s) => s.publisher_id);
}

function emptyCreative(id: string, personaId: string): Creative {
  return {
    id,
    persona_id: personaId,
    angle: '',
    heading: '',
    subheading: '',
    cta: 'Shop Now',
    offer: null,
    disclosure: null,
    claims_used: [],
    publisher_ids: [],
    constraints_respected: [],
    critic: null,
    revised_from: null,
    char_counts: { heading: 0, subheading: 0 },
    grounding_flags: [],
    error: null,
  };
}
