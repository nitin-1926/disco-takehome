// Recovery prompts used by lib/llm.ts for every step. Not a stage of their own and not keyed in the cache: a repaired
// or retried answer is cached under the original step's key.

/** One repair on the cheaper model when an answer fails its schema: fix the JSON, nothing else. */
export const REPAIR_SYSTEM = 'You repair JSON to match a schema. Output only JSON.';

export function repairPrompt(error: string, json: string): string {
  return `The JSON below failed validation.\nError: ${error}\n\nJSON:\n${json}\n\nReturn only corrected JSON that satisfies the schema. Keep every value that already fits.`;
}

/** Appended to the step's own prompt when its answer passes the schema but fails a code check (e.g. an id missing). */
export function retrySuffix(problem: string): string {
  return `\n\nYour previous answer was rejected: ${problem}. Answer again in full.`;
}
