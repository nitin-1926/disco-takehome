import { describe, expect, test, vi } from 'vitest';

vi.mock('ai', () => ({
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  embed: vi.fn(),
  embedMany: vi.fn(),
}));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => Object.assign(() => ({}), { embedding: () => ({}) }) }));
process.env.OPENAI_API_KEY = 'sk-test';

const { topK, publisherText } = await import('@/lib/embed');
const { publishers } = await import('@/lib/data');

describe('embed helpers', () => {
  test('topK ranks by similarity, breaks ties by id, and respects k', () => {
    const index = { b: [1, 0], a: [1, 0], c: [0, 1] };
    const r = topK([1, 0], index, 2);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r[0].similarity).toBe(1);
  });

  test('publisher text carries the fields retrieval should see', () => {
    const t = publisherText(publishers[0]);
    expect(t).toContain(publishers[0].name);
    expect(t).toContain(publishers[0].notes);
  });
});
