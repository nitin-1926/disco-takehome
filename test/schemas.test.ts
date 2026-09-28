import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { understandSchema } from '@/prompts/understand';
import { scorePublishersSchema } from '@/prompts/score-publishers';
import { scorePersonaSchema } from '@/prompts/score-personas';
import { creativeSchema } from '@/prompts/creative';
import { criticSchema } from '@/prompts/critic';
import { judgeSchema } from '@/prompts/judge';

// OpenAI strict JSON mode: object root, every property required (nullable instead of optional), no records.
function walk(node: Record<string, unknown>, path: string, problems: string[]) {
  if (node.type === 'object' || node.properties) {
    const props = Object.keys((node.properties as Record<string, unknown>) ?? {});
    const required = (node.required as string[]) ?? [];
    for (const p of props) if (!required.includes(p)) problems.push(`${path}.${p} is optional`);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') problems.push(`${path} is a record`);
    for (const p of props) walk((node.properties as Record<string, Record<string, unknown>>)[p], `${path}.${p}`, problems);
  }
  if (node.items) walk(node.items as Record<string, unknown>, `${path}[]`, problems);
  for (const alt of (node.anyOf as Record<string, unknown>[]) ?? []) walk(alt, path, problems);
}

describe('prompt schemas are strict-mode compatible', () => {
  test.each([
    ['understand', understandSchema],
    ['score-publishers', scorePublishersSchema],
    ['score-persona', scorePersonaSchema],
    ['creative', creativeSchema],
    ['critic', criticSchema],
    ['judge', judgeSchema],
  ] as const)('%s', (_name, schema) => {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    expect(json.type).toBe('object');
    const problems: string[] = [];
    walk(json, '$', problems);
    expect(problems).toEqual([]);
  });
});
