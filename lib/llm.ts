import 'server-only';
import { generateText, Output, NoObjectGeneratedError, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { z } from 'zod';
import { cacheGet, cacheKey, pendingCommitted, redisSet, sha256, type CacheEntry } from './cache';
import { env } from './env';
import { MODEL_IDS, STEPS, costUsd, worstCaseUsd, type Reasoning, type StepName, type TokenUsage } from './models';
import type { CallRecord, ErrorCode, RunContext, Source } from './types';

// The one seam every LLM call goes through: prompt assembly, cache, spend reservation, timeout/abort,
// schema validation with one repair, cost, deferred writes. pipeline.ts never touches cache or spend directly.

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
  label?: string;
  /** Extra cancel signal for this call only (a side branch the run no longer needs); ctx.signal still applies. */
  signal?: AbortSignal;
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
  const hit = cached && !opts.validate?.(cached.entry.output as TOut) ? cached : null;
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
  const signal = opts.signal && ctx.signal ? AbortSignal.any([ctx.signal, opts.signal]) : (opts.signal ?? ctx.signal);
  if (signal?.aborted) throw new LlmError('aborted', mod.id, 'Run aborted before call');

  let reservation: string | null = null;
  if (ctx.spend) {
    const r = await ctx.spend.reserve(worstCaseUsd(mod.step), opts.label ?? mod.id);
    if (!r.ok) throw new LlmError('spend_refused', mod.id, r.reason === 'cap' ? 'Spend cap reached' : 'Spend store unavailable');
    reservation = r.id;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userPrompt = mod.build(args);
  const raws: string[] = [];
  let usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  // Cost is priced per attempt at that attempt's model (a Luna repair is not billed at Sol rates),
  // and a failed attempt's tokens still count when the provider reports them.
  let cost = 0;
  let output: TOut;
  const account = (m: string, raw: Parameters<typeof usageOf>[0] | undefined) => {
    if (!raw) return;
    const u = usageOf(raw);
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      cachedInputTokens: usage.cachedInputTokens + u.cachedInputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      reasoningTokens: usage.reasoningTokens + u.reasoningTokens,
    };
    cost += safeCost(m, u);
  };

  const run = async (system: string, prompt: string, m: string, effort: Reasoning, cap: number) => {
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
        timeout: { totalMs: timeoutMs },
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
      throw e;
    }
  };

  try {
    try {
      output = await run(mod.instructions, userPrompt, modelId, reasoning, step.maxOutputTokens);
    } catch (e) {
      if (!NoObjectGeneratedError.isInstance(e)) throw e;
      raws.push(e.text ?? '');
      // One repair on the cheap model: fix the JSON to satisfy the schema, nothing else.
      const repair = STEPS.repair;
      const repairPrompt = `The JSON below failed validation.\nError: ${e.message}\n\nJSON:\n${e.text ?? ''}\n\nReturn only corrected JSON that satisfies the schema. Keep every value that already fits.`;
      try {
        output = await run('You repair JSON to match a schema. Output only JSON.', repairPrompt, MODEL_IDS[repair.model], repair.reasoning, repair.maxOutputTokens);
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
      // ponytail: the reservation covers one attempt; settle charges the real total, so a retry can overshoot the cap by one call.
      raws.push(JSON.stringify(output));
      output = await run(mod.instructions, `${userPrompt}\n\nYour previous answer was rejected: ${problem}. Answer again in full.`, modelId, reasoning, step.maxOutputTokens);
      const again = opts.validate?.(output);
      if (again) {
        raws.push(JSON.stringify(output));
        throw new LlmError('schema_invalid', mod.id, `Output failed validation twice: ${again}`, raws);
      }
    }
  } catch (e) {
    const code = e instanceof LlmError ? e.code : classify(e, Date.now() - started >= timeoutMs);
    // Abort or timeout: the provider may have billed tokens we never saw, so the reservation stays whole.
    if (code !== 'aborted' && code !== 'timeout') settle(ctx, reservation, cost);
    if (e instanceof LlmError) throw e;
    throw new LlmError(code, mod.id, String((e as Error)?.message ?? e));
  }

  const entry: CacheEntry = { output, usage, costUsd: cost, model: modelId, promptVersion: mod.promptVersion, storedAt: new Date().toISOString() };
  settle(ctx, reservation, cost);
  ctx.defer(() => redisSet(key, entry));
  if (ctx.cacheMode.writeCommitted) pendingCommitted.set(key, entry);

  return {
    output,
    source: 'live',
    key,
    record: { module: mod.id, model: modelId, source: 'live', ms: Date.now() - started, ...usage, costUsd: cost },
  };
}

function safeCost(modelId: string, usage: TokenUsage): number {
  try {
    return costUsd(modelId, usage);
  } catch {
    return 0;
  }
}

function settle(ctx: RunContext, reservation: string | null, actualUsd: number): void {
  if (!ctx.spend || !reservation) return;
  const spend = ctx.spend;
  ctx.defer(() => spend.settle(reservation, actualUsd));
}
