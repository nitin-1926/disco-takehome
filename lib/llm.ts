import 'server-only';
import { generateText, Output, NoObjectGeneratedError, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { z } from 'zod';
import { cacheGet, cacheKey, pendingCommitted, redisSet, sha256, type CacheEntry } from './cache';
import { env } from './env';
import { MODEL_IDS, STEPS, costUsd, worstCaseUsd, type Reasoning, type StepName, type TokenUsage } from './models';
import { REPAIR_SYSTEM, repairPrompt, retrySuffix } from '../prompts/repair';
import type { CallRecord, ErrorCode, RunContext, Source } from './types';

// The one seam every LLM call goes through: prompt assembly, cache, spend reservation, timeout/abort,
// schema validation with one repair (prompts/repair.ts), cost, deferred writes. pipeline.ts never touches cache or spend directly.

export interface PromptModule<TArgs, TOut> {
  /** Stable id; part of the cache key and shown in the trace drawer as the prompt file. */
  id: string;
  /** Bump when the prompt's meaning changes; the instructions hash also enters the key. */
  promptVersion: string;
  step: StepName;
  /** Stable prefix: rubric, catalog, rules. The advertiser input never goes here. */
  instructions: string;
  /** Variable suffix built from the arguments. Only these arguments enter the cache key. */
  build(args: TArgs): string;
  schema: z.ZodType<TOut>;
  schemaName: string;
}

export interface CallOptions<TOut = unknown> {
  timeoutMs?: number;
  reasoning?: Reasoning;
  modelId?: string;
  /** Code check beyond the schema (e.g. every id exactly once). Returns a problem or null. A failing output is never cached; one retry. */
  validate?: (output: TOut) => string | null;
}

export interface CallResult<TOut> {
  output: TOut;
  source: Source;
  record: CallRecord;
  key: string;
}

export class LlmError extends Error {
  code: ErrorCode;
  module: string;
  raws: string[];
  constructor(code: ErrorCode, module: string, message: string, raws: string[] = []) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.module = module;
    this.raws = raws;
  }
}

let provider: ReturnType<typeof createOpenAI> | null = null;
/** Shared OpenAI provider (language + embedding models). */
export function openaiProvider(): ReturnType<typeof createOpenAI> {
  provider ??= createOpenAI({ apiKey: env().openaiKey });
  return provider;
}
function model(id: string): LanguageModel {
  return openaiProvider()(id);
}

const DEFAULT_TIMEOUT_MS = 25_000;
/** Below this, a repair or retry could not finish; the call fails as a timeout instead of starting one. */
const MIN_ATTEMPT_MS = 1_500;

function usageOf(u: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): TokenUsage {
  return {
    inputTokens: u.inputTokens ?? 0,
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

function classify(e: unknown, timedOut: boolean): ErrorCode {
  const msg = String((e as Error)?.message ?? e);
  if (timedOut || /timeout|timed out/i.test(msg)) return 'timeout';
  if ((e as Error)?.name === 'AbortError' || /abort/i.test(msg)) return 'aborted';
  return 'provider_error';
}

export async function callLLM<TArgs, TOut>(
  mod: PromptModule<TArgs, TOut>,
  args: TArgs,
  ctx: RunContext,
  opts: CallOptions<TOut> = {},
): Promise<CallResult<TOut>> {
  const step = STEPS[mod.step];
  const modelId = opts.modelId ?? MODEL_IDS[step.model];
  const reasoning = opts.reasoning ?? step.reasoning;
  const key = cacheKey({
    module: mod.id,
    promptVersion: mod.promptVersion,
    instructionsHash: sha256(mod.instructions),
    model: modelId,
    reasoning,
    schemaName: mod.schemaName,
    args,
  });

  const started = Date.now();
  const cached = await cacheGet(key, ctx.cacheMode);
  // A cached answer must still fit today's schema and code check; one that does not is a miss, never served.
  const hit = cached && mod.schema.safeParse(cached.entry.output).success && !opts.validate?.(cached.entry.output as TOut) ? cached : null;
  if (hit) {
    // --write-cache carries forward every entry this run used, not only the new ones.
    if (ctx.cacheMode.writeCommitted) pendingCommitted.set(key, hit.entry);
    return {
      output: hit.entry.output as TOut,
      source: hit.source,
      key,
      record: { module: mod.id, model: hit.entry.model, source: hit.source, ms: Date.now() - started, ...hit.entry.usage, costUsd: hit.entry.costUsd },
    };
  }
  if (ctx.cacheMode.replayOnly) {
    throw new LlmError('cache_miss', mod.id, `No cached output for ${mod.id}; sample cache is stale`);
  }
  const signal = ctx.signal;
  if (signal?.aborted) throw new LlmError('aborted', mod.id, 'Run aborted before call');

  // Every attempt (first, repair, retry) reserves its own worst case first, so a retry cannot overshoot the cap.
  const reservations: string[] = [];
  const reserve = async (s: StepName) => {
    if (!ctx.spend) return;
    const r = await ctx.spend.reserve(worstCaseUsd(s));
    if (!r.ok) throw new LlmError(r.reason === 'cap' ? 'spend_refused' : 'store_error', mod.id, r.reason === 'cap' ? 'Spend cap reached' : 'Spend store unavailable');
    reservations.push(r.id);
  };

  // One deadline across all attempts: a repair or retry gets what is left of the call's budget, not a fresh one.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = started + timeoutMs;
  const userPrompt = mod.build(args);
  const raws: string[] = [];
  let usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  // Cost is priced per attempt at that attempt's model (a Luna repair is not billed at Sol rates),
  // and a failed attempt's tokens still count when the provider reports them.
  let cost = 0;
  let output: TOut;
  // Abort or timeout with a request in flight: the provider may have billed tokens we never saw, so reservations stay whole.
  let keepWhole = false;
  const account = (m: string, raw: Parameters<typeof usageOf>[0] | undefined) => {
    if (!raw) return;
    const u = usageOf(raw);
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      cachedInputTokens: usage.cachedInputTokens + u.cachedInputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      reasoningTokens: usage.reasoningTokens + u.reasoningTokens,
    };
    cost += costUsd(m, u);
  };

  const run = async (s: StepName, system: string, prompt: string, m: string, effort: Reasoning, cap: number) => {
    const left = deadline - Date.now();
    if (left < MIN_ATTEMPT_MS) throw new LlmError('timeout', mod.id, 'No time left for another attempt', raws);
    await reserve(s);
    try {
      const res = await generateText({
        model: model(m),
        instructions: {
          role: 'system',
          content: system,
          // Explicit breakpoint after the stable prefix; the variable suffix is never written to the provider cache.
          providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
        },
        prompt,
        output: Output.object({ schema: mod.schema, name: mod.schemaName }),
        maxOutputTokens: cap,
        maxRetries: 2,
        abortSignal: signal,
        timeout: { totalMs: left },
        providerOptions: {
          openai: {
            reasoningEffort: effort,
            strictJsonSchema: true,
            textVerbosity: 'low',
            // GPT-6: retention is set through promptCacheOptions; promptCacheRetention is rejected.
            promptCacheOptions: { mode: 'explicit', ttl: '30m' },
          },
        },
      });
      account(m, res.usage);
      return res.output as TOut;
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) account(m, (e as { usage?: Parameters<typeof usageOf>[0] }).usage);
      else if (classify(e, Date.now() >= deadline) !== 'provider_error') keepWhole = true;
      throw e;
    }
  };

  try {
    try {
      output = await run(mod.step, mod.instructions, userPrompt, modelId, reasoning, step.maxOutputTokens);
    } catch (e) {
      if (!NoObjectGeneratedError.isInstance(e)) throw e;
      raws.push(e.text ?? '');
      // One repair on the cheap model: fix the JSON to satisfy the schema, nothing else.
      const repair = STEPS.repair;
      try {
        output = await run('repair', REPAIR_SYSTEM, repairPrompt(e.message, e.text ?? ''), MODEL_IDS[repair.model], repair.reasoning, repair.maxOutputTokens);
      } catch (e2) {
        if (NoObjectGeneratedError.isInstance(e2)) {
          raws.push(e2.text ?? '');
          throw new LlmError('schema_invalid', mod.id, `Output failed schema twice: ${e2.message}`, raws);
        }
        throw e2;
      }
    }
    const problem = opts.validate?.(output);
    if (problem) {
      // One retry with the problem named; the rejected answer is never cached.
      raws.push(JSON.stringify(output));
      try {
        output = await run(mod.step, mod.instructions, `${userPrompt}${retrySuffix(problem)}`, modelId, reasoning, step.maxOutputTokens);
      } catch (e2) {
        if (NoObjectGeneratedError.isInstance(e2)) throw new LlmError('schema_invalid', mod.id, `Retry failed schema: ${e2.message}`, raws);
        throw e2;
      }
      const again = opts.validate?.(output);
      if (again) {
        raws.push(JSON.stringify(output));
        throw new LlmError('schema_invalid', mod.id, `Output failed validation twice: ${again}`, raws);
      }
    }
  } catch (e) {
    if (!keepWhole) settle(ctx, reservations, cost);
    if (e instanceof LlmError) throw e;
    throw new LlmError(classify(e, Date.now() >= deadline), mod.id, String((e as Error)?.message ?? e));
  }

  const entry: CacheEntry = { output, usage, costUsd: cost, model: modelId, promptVersion: mod.promptVersion, storedAt: new Date().toISOString() };
  settle(ctx, reservations, cost);
  ctx.defer(() => redisSet(key, entry));
  if (ctx.cacheMode.writeCommitted) pendingCommitted.set(key, entry);

  return {
    output,
    source: 'live',
    key,
    record: { module: mod.id, model: modelId, source: 'live', ms: Date.now() - started, ...usage, costUsd: cost },
  };
}

/** The first reservation settles to the whole actual cost; any extra (repair, retry) settles to zero. */
function settle(ctx: RunContext, reservations: string[], actualUsd: number): void {
  if (!ctx.spend || !reservations.length) return;
  const spend = ctx.spend;
  reservations.forEach((id, i) => ctx.defer(() => spend.settle(id, i === 0 ? actualUsd : 0)));
}
