// Model ids, per-step reasoning and caps, price table. One file to swap a model or an effort level.
// Prices: OpenAI pricing page, read 2026-09-27 (USD per 1M tokens). Cached input = 10% of input.
// Defaults below are placeholders until scripts/smoke-models.ts measures the effort curves (see docs/eval/latency.md).

export const MODEL_IDS = {
  sol: 'gpt-6-sol',
  luna: 'gpt-6-luna',
  embedding: 'text-embedding-3-large',
} as const;

export type ModelKey = 'sol' | 'luna';
// GPT-6 accepts low | medium | high | xhigh | max only ('none' is silently dropped; measured 2026-09-28).
export type Reasoning = 'low' | 'medium' | 'high';

export const PRICES_USD_PER_M: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-6-sol': { input: 2.0, cachedInput: 0.2, output: 10.0 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  // Embedding price from the same page; confirmed against the smoke output in U1.
  'text-embedding-3-large': { input: 0.13, cachedInput: 0.13, output: 0 },
};

export type StepName =
  | 'understand'
  | 'score_publishers'
  | 'score_personas'
  | 'creative'
  | 'revise'
  | 'critic'
  | 'repair'
  | 'judge';

export interface StepConfig {
  model: ModelKey;
  reasoning: Reasoning;
  /** Generous: reasoning tokens count against this on GPT-6 (keychain learning). Also sets the TPM reservation. */
  maxOutputTokens: number;
  /** Typical prompt size, used only for the worst-case spend reservation. */
  inputTokensEstimate: number;
}

// F23: Sol infers (understand, scoring, personas, copy), Luna checks (critic, repair, judge).
// Efforts are the GPT-6 floor ('low'); measured single-run walls at low (docs/eval/latency-pass1.md):
// understand 3.6 s, scoring 11.3 s, personas 9.5 s, creative 4.5 s, critic 4.8 s. Latency lever = visible output size.
export const STEPS: Record<StepName, StepConfig> = {
  understand: { model: 'sol', reasoning: 'low', maxOutputTokens: 2500, inputTokensEstimate: 2000 },
  score_publishers: { model: 'sol', reasoning: 'low', maxOutputTokens: 2500, inputTokensEstimate: 5000 },
  score_personas: { model: 'sol', reasoning: 'low', maxOutputTokens: 2500, inputTokensEstimate: 3000 },
  creative: { model: 'sol', reasoning: 'low', maxOutputTokens: 1200, inputTokensEstimate: 1500 },
  revise: { model: 'sol', reasoning: 'low', maxOutputTokens: 1500, inputTokensEstimate: 2000 },
  critic: { model: 'luna', reasoning: 'low', maxOutputTokens: 1500, inputTokensEstimate: 3000 },
  repair: { model: 'luna', reasoning: 'low', maxOutputTokens: 1500, inputTokensEstimate: 2000 },
  judge: { model: 'luna', reasoning: 'low', maxOutputTokens: 2000, inputTokensEstimate: 3000 },
};

/** Max creatives per run (one per picked persona). Live path may lower to 3 as a latency fallback rung. */
export const CREATIVES_MAX = 5;

export const EMBEDDING_DIMENSIONS = 1024;

export const PIPELINE_VERSION = '0.1.0';

/** Upper bound on what one call can cost: full input estimate + the whole output cap. */
export function worstCaseUsd(step: StepName): number {
  const cfg = STEPS[step];
  const price = PRICES_USD_PER_M[MODEL_IDS[cfg.model]];
  return (cfg.inputTokensEstimate * price.input + cfg.maxOutputTokens * price.output) / 1_000_000;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Cost from usage: cached input at the cached rate, the rest at the input rate, all output (incl. reasoning) at the output rate. */
export function costUsd(modelId: string, u: TokenUsage): number {
  const p = PRICES_USD_PER_M[modelId];
  if (!p) throw new Error(`No price for model ${modelId}`);
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens);
  return (uncached * p.input + u.cachedInputTokens * p.cachedInput + u.outputTokens * p.output) / 1_000_000;
}
