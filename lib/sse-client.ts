// Browser side of POST /api/run: an SSE parser and a reducer. No React, so both are unit-tested directly.
// The reducer accepts stage events in any order and ignores repeated event ids.

import type {
  AdvertiserProfile,
  CampaignConfig,
  Creative,
  ErrorEvent,
  PersonaScore,
  PublisherScore,
  RunEvent,
  RunSummary,
  Settings,
  Source,
  Stage,
  Triage,
} from './types';

export const STAGES: Stage[] = ['understand', 'score_publishers', 'score_personas', 'creative', 'critic', 'revise', 'config'];

export type StageState = { status: 'pending' | 'started' | 'done' | 'skipped' | 'error'; ms?: number; source?: Source; reason?: string };

export interface HttpError {
  status: number;
  error: string;
  message: string;
  retryAfter?: number;
}

export interface RunState {
  status: 'idle' | 'streaming' | 'done' | 'failed';
  input: string;
  httpError: HttpError | null;
  seen: number[];
  stages: Record<Stage, StageState>;
  profile: AdvertiserProfile | null;
  mode: 'stop' | 'score_only' | 'full' | null;
  modeWhy: string;
  triage: Triage | null;
  viabilityNote: string | null;
  publishers: PublisherScore[] | null;
  exclusionGroups: { group: string; count: number; ids: string[] }[];
  comparatives: { higher: string; lower: string; why: string }[];
  personas: PersonaScore[] | null;
  creatives: Creative[];
  config: CampaignConfig | null;
  errors: ErrorEvent[];
  summary: RunSummary | null;
}

const pendingStages = (): Record<Stage, StageState> =>
  Object.fromEntries(STAGES.map((s) => [s, { status: 'pending' }])) as Record<Stage, StageState>;

export function initialState(input = ''): RunState {
  return {
    status: 'idle',
    input,
    httpError: null,
    seen: [],
    stages: pendingStages(),
    profile: null,
    mode: null,
    modeWhy: '',
    triage: null,
    viabilityNote: null,
    publishers: null,
    exclusionGroups: [],
    comparatives: [],
    personas: null,
    creatives: [],
    config: null,
    errors: [],
    summary: null,
  };
}

export type Action =
  | { type: 'start'; input: string }
  | { type: 'event'; id: number | null; event: RunEvent }
  | { type: 'http_error'; error: HttpError }
  | { type: 'network_error'; message: string }
  | { type: 'config'; config: CampaignConfig };

type Payload = Record<string, unknown>;

export function reduce(state: RunState, action: Action): RunState {
  switch (action.type) {
    case 'start':
      return { ...initialState(action.input), status: 'streaming' };
    case 'http_error':
      return { ...state, status: 'failed', httpError: action.error };
    case 'network_error':
      return state.status === 'done' ? state : { ...state, status: 'failed', httpError: { status: 0, error: 'network', message: action.message } };
    case 'config':
      return { ...state, config: action.config };
    case 'event': {
      if (action.id !== null && state.seen.includes(action.id)) return state;
      const s: RunState = { ...state, seen: action.id === null ? state.seen : [...state.seen, action.id] };
      const e = action.event;
      if (e.type === 'done') return { ...s, status: 'done', summary: e.summary };
      if (e.type === 'error') {
        return { ...s, errors: [...s.errors, e], stages: { ...s.stages, [e.stage]: { ...s.stages[e.stage], status: 'error', reason: e.message } } };
      }
      const prev = s.stages[e.stage];
      // A stage that already failed keeps its error even if a later done/skip arrives for it.
      const status = prev.status === 'error' ? 'error' : e.status;
      const p = (e.payload ?? {}) as Payload;
      s.stages = { ...s.stages, [e.stage]: { status, ms: e.ms ?? prev.ms, source: e.source ?? prev.source, reason: (p.reason as string) ?? prev.reason } };
      if (e.status !== 'done') return s;
      switch (e.stage) {
        case 'understand':
          return { ...s, profile: p.profile as AdvertiserProfile, mode: p.mode as RunState['mode'], modeWhy: (p.why as string) ?? '', triage: s.triage ?? (p.profile as AdvertiserProfile).triage };
        case 'score_publishers':
          return {
            ...s,
            publishers: p.scores as PublisherScore[],
            triage: p.triage as Triage,
            viabilityNote: (p.viability_note as string) ?? null,
            exclusionGroups: (p.exclusion_groups as RunState['exclusionGroups']) ?? [],
            comparatives: (p.comparatives as RunState['comparatives']) ?? [],
          };
        case 'score_personas':
          return { ...s, personas: mergePersonas(p.personas as PersonaScore[], s.config) };
        case 'creative':
        case 'critic':
        case 'revise':
          return { ...s, creatives: mergeCreatives(p.creatives as Creative[], s.config) };
        case 'config': {
          const config = p.config as CampaignConfig;
          return { ...s, config, creatives: mergeCreatives(s.creatives, config), personas: s.personas ? mergePersonas(s.personas, config) : s.personas };
        }
        default:
          return s;
      }
    }
  }
}

/** The config carries the final persona → publisher mapping; earlier events do not. */
function mergeCreatives(creatives: Creative[], config: CampaignConfig | null): Creative[] {
  if (!config) return creatives;
  const mapped = new Map(config.creatives.map((c) => [c.id, c.publisher_ids]));
  return creatives.map((c) => (mapped.has(c.id) ? { ...c, publisher_ids: mapped.get(c.id)! } : c));
}
function mergePersonas(personas: PersonaScore[], config: CampaignConfig | null): PersonaScore[] {
  if (!config) return personas;
  const mapped = new Map(config.personas.map((p) => [p.persona_id, p.publisher_ids]));
  return personas.map((p) => (mapped.has(p.persona_id) ? { ...p, publisher_ids: mapped.get(p.persona_id)! } : p));
}

/** Incremental SSE parser: feed it decoded text in any chunking; it calls back once per complete event. */
export function createParser(onEvent: (id: number | null, event: RunEvent) => void) {
  let buf = '';
  const flushBlock = (block: string) => {
    let id: number | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue; // comment / padding
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'id') id = Number.isFinite(Number(value)) ? Number(value) : null;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    try {
      // Model text sometimes carries en/em dashes; the page shows plain hyphens (design brief).
      onEvent(id, JSON.parse(data.join('\n').replace(/[\u2013\u2014]/g, '-')) as RunEvent);
    } catch {
      /* a malformed event is dropped; the stream continues */
    }
  };
  return {
    feed(text: string) {
      buf += text.replace(/\r\n/g, '\n');
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        flushBlock(buf.slice(0, at));
        buf = buf.slice(at + 2);
      }
    },
    end() {
      if (buf.trim()) flushBlock(buf);
      buf = '';
    },
  };
}

export interface RunRequest {
  input: string;
  settings?: Partial<Pick<Settings, 'budgetUsd' | 'durationDays' | 'conversionEvent' | 'offer'>>;
  live?: boolean;
}

/** POST and stream. Resolves when the stream ends; every outcome goes through dispatch. */
export async function startRun(req: RunRequest, dispatch: (a: Action) => void, signal: AbortSignal): Promise<void> {
  dispatch({ type: 'start', input: req.input });
  let res: Response;
  try {
    res = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal });
  } catch {
    if (!signal.aborted) dispatch({ type: 'network_error', message: 'Could not reach the server. Check your connection and try again.' });
    return;
  }
  if (signal.aborted) return;
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; retry_after?: number };
    if (signal.aborted) return; // superseded while reading the refusal: it must not fail the next run
    dispatch({ type: 'http_error', error: { status: res.status, error: body.error ?? 'unknown', message: body.message ?? 'Something went wrong.', retryAfter: body.retry_after } });
    return;
  }
  // A superseded run must not write into the next run's state.
  let sawDone = false;
  const parser = createParser((id, event) => {
    if (event.type === 'done') sawDone = true;
    if (!signal.aborted) dispatch({ type: 'event', id, event });
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();
    // Every run ends in `done`; a stream that closed without it (platform cut, crash) must not leave the page streaming.
    if (!sawDone && !signal.aborted) dispatch({ type: 'network_error', message: 'The run ended early. Try again.' });
  } catch {
    if (!signal.aborted) dispatch({ type: 'network_error', message: 'The connection dropped mid-run. Try again.' });
  }
}
