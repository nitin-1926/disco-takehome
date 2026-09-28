import { describe, expect, test } from 'vitest';
import { createParser, initialState, reduce, type Action, type RunState } from '@/lib/sse-client';
import type { RunEvent } from '@/lib/types';
import { profiles } from './fixtures/llm-dims';

const frame = (id: number, e: RunEvent) => `id: ${id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const summary = { run_id: 'r', cost_live_usd: 0, cost_replayed_usd: 0, calls: [], total_ms: 5, cold: false, skipped: [], errors: [] };

function play(chunks: string[]): RunState {
  let s = reduce(initialState(), { type: 'start', input: 'x' });
  const p = createParser((id, event) => (s = reduce(s, { type: 'event', id, event })));
  for (const c of chunks) p.feed(c);
  p.end();
  return s;
}

describe('SSE parser + reducer', () => {
  test('padding comment, events split across chunks, an error and done → ordered state', () => {
    const body =
      `:${' '.repeat(2048)}\n\n` +
      frame(1, { type: 'stage', stage: 'understand', status: 'started' }) +
      frame(2, { type: 'stage', stage: 'understand', status: 'done', source: 'committed', ms: 3, payload: { profile: profiles[1], mode: 'full', why: '' } }) +
      frame(3, { type: 'error', stage: 'critic', code: 'timeout', message: 'The model took too long to answer.' }) +
      frame(4, { type: 'done', summary });
    const chunks = [body.slice(0, 900), body.slice(900, 2300), body.slice(2300, 2301), body.slice(2301)];
    const s = play(chunks);
    expect(s.profile?.product).toBe(profiles[1].product);
    expect(s.stages.understand).toMatchObject({ status: 'done', source: 'committed', ms: 3 });
    expect(s.stages.critic.status).toBe('error');
    expect(s.errors).toHaveLength(1);
    expect(s.status).toBe('done');
  });

  test('scoring arriving after personas still renders both', () => {
    const s = play([
      frame(1, { type: 'stage', stage: 'score_personas', status: 'done', payload: { personas: [{ persona_id: 'persona_004', picked: true }] } }),
      frame(2, { type: 'stage', stage: 'score_publishers', status: 'done', payload: { scores: [{ publisher_id: 'pub_007', band: 'recommended' }], triage: profiles[1].triage } }),
    ]);
    expect(s.personas).toHaveLength(1);
    expect(s.publishers).toHaveLength(1);
  });

  test('a repeated event id is ignored', () => {
    const e: RunEvent = { type: 'error', stage: 'creative', code: 'timeout', message: 'x' };
    const s = play([frame(7, e), frame(7, e)]);
    expect(s.errors).toHaveLength(1);
  });

  test('a stage that failed keeps its error when a later done arrives for it', () => {
    const s = play([frame(1, { type: 'error', stage: 'creative', code: 'timeout', message: 'x' }), frame(2, { type: 'stage', stage: 'creative', status: 'done', payload: { creatives: [] } })]);
    expect(s.stages.creative.status).toBe('error');
  });

  test('model dashes become hyphens; malformed data is dropped without stopping the stream', () => {
    const s = play([
      'id: 1\nevent: stage\ndata: {not json\n\n',
      frame(2, { type: 'stage', stage: 'understand', status: 'done', payload: { profile: { ...profiles[1], product: 'Mugs — hand-thrown' }, mode: 'full', why: '' } }),
    ]);
    expect(s.profile?.product).toBe('Mugs - hand-thrown');
  });

  test('config event maps creatives to publishers; unverified cards keep their flag', () => {
    let s = reduce(initialState(), { type: 'start', input: 'x' });
    const card = { id: 'c1', persona_id: 'persona_004', publisher_ids: [], critic: { pass: false, checks: [], unverified: true } };
    s = reduce(s, { type: 'event', id: 1, event: { type: 'stage', stage: 'creative', status: 'done', payload: { creatives: [card] } } } as Action);
    s = reduce(s, { type: 'event', id: 2, event: { type: 'stage', stage: 'config', status: 'done', payload: { config: { creatives: [{ ...card, publisher_ids: ['pub_007'] }], personas: [] } } } } as Action);
    expect(s.creatives[0].publisher_ids).toEqual(['pub_007']);
    expect(s.creatives[0].critic?.unverified).toBe(true);
  });

  test('HTTP errors before the stream land as a failed state with retry-after', () => {
    const s = reduce(reduce(initialState(), { type: 'start', input: 'x' }), { type: 'http_error', error: { status: 429, error: 'rate_limited', message: 'slow down', retryAfter: 600 } });
    expect(s.status).toBe('failed');
    expect(s.httpError?.retryAfter).toBe(600);
  });

  test('a network error after done does not overwrite a finished run', () => {
    let s = play([frame(1, { type: 'done', summary })]);
    s = reduce(s, { type: 'network_error', message: 'x' });
    expect(s.status).toBe('done');
  });
});
