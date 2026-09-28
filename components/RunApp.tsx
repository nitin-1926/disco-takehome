'use client';

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { buildConfig } from '@/lib/config';
import { DEFAULT_SETTINGS, normalizeSettings } from '@/lib/settings';
import { initialState, reduce, startRun, STAGES, type RunRequest, type RunState } from '@/lib/sse-client';
import type { Offer } from '@/lib/types';
import { Banners } from './Banners';
import { ConfigView } from './ConfigView';
import { Creatives } from './PersonaCreativeCard';
import { PUBLISHERS, STAGE_LABEL } from './format';
import { InputPanel } from './InputPanel';
import { ProfileCard } from './ProfileCard';
import { PublisherList } from './PublisherList';
import { StageStepper } from './StageStepper';

export interface SampleChip {
  n: number;
  text: string;
  trap: string;
}

export type RunSettings = NonNullable<RunRequest['settings']> & { budgetUsd: number; durationDays: number; conversionEvent: 'purchase' | 'signup' | 'subscription'; offer: Offer | null };

export const DEFAULT_RUN_SETTINGS: RunSettings = { budgetUsd: DEFAULT_SETTINGS.budgetUsd, durationDays: DEFAULT_SETTINGS.durationDays, conversionEvent: DEFAULT_SETTINGS.conversionEvent, offer: null };

export function RunApp({ samples }: { samples: SampleChip[] }) {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const [input, setInput] = useState(samples[0]?.text ?? '');
  const [applied, setApplied] = useState<RunSettings>(DEFAULT_RUN_SETTINGS);
  // ?live=1: operator mode, cache reads off. Read hydration-safely (false on the server).
  const liveFlag = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get('live') === '1', () => false);
  const [announce, setAnnounce] = useState('');
  const ctrl = useRef<AbortController | null>(null);
  const lastInput = useRef(input);

  const run = useCallback((text: string, settings: RunSettings, live: boolean) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    lastInput.current = text;
    void startRun({ input: text, settings, ...(live ? { live: true } : {}) }, dispatch, ac.signal);
  }, []);

  const stop = useCallback(() => {
    ctrl.current?.abort();
    dispatch({ type: 'network_error', message: 'Run stopped. Anything already shown is kept.' });
  }, []);

  // First paint: sample #1 replays from the committed cache (no model calls), which also warms the function.
  useEffect(() => {
    if (samples[0]) run(samples[0].text, DEFAULT_RUN_SETTINGS, false);
    return () => ctrl.current?.abort();
  }, [run, samples]);

  useAnnouncer(state, setAnnounce);

  const onSample = (s: SampleChip) => {
    setInput(s.text);
    setApplied(DEFAULT_RUN_SETTINGS);
    run(s.text, DEFAULT_RUN_SETTINGS, false);
  };

  const onApply = (next: RunSettings) => {
    const offerChanged = JSON.stringify(next.offer) !== JSON.stringify(applied.offer);
    setApplied(next);
    // Budget, duration and event only change the arithmetic: recompute the config here, no request.
    if (!offerChanged && state.config && state.profile && state.triage && state.publishers && state.status === 'done') {
      const config = buildConfig({
        profile: state.profile,
        triage: state.triage,
        settings: normalizeSettings(next),
        publisherScores: state.publishers,
        personaScores: state.personas ?? [],
        creatives: state.creatives.filter((c) => !c.error),
        publishers: PUBLISHERS,
        meta: { ...state.config.meta, generated_at: new Date().toISOString() },
        today: new Date().toISOString().slice(0, 10),
      });
      dispatch({ type: 'config', config });
      setAnnounce('Campaign config recalculated.');
      return;
    }
    // An offer changes the copy: re-run. Upstream stages come back from cache; only creative, critic and revise run live.
    run(lastInput.current, next, liveFlag);
  };

  const streaming = state.status === 'streaming';

  return (
    <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-8 px-4 py-6 md:px-8 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-12 lg:py-10">
      <a href="#plan" className="sr-only rounded-control bg-accent px-3 py-2 text-accent-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20">
        Skip to the plan
      </a>
      <aside className="lg:sticky lg:top-8 lg:max-h-[calc(100dvh-4rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
        <header className="mb-6">
          <h1 className="text-base font-semibold tracking-tight">Campaign planner</h1>
          <p className="mt-1 max-w-[42ch] text-sm leading-relaxed text-ink-2">
            Describe a business in a sentence or two. Get ranked publishers, ads written for real shopper personas, and a campaign config.
          </p>
        </header>
        <InputPanel
          input={input}
          setInput={setInput}
          streaming={streaming}
          onRun={() => run(input, applied, liveFlag)}
          onStop={stop}
          samples={samples}
          onSample={onSample}
          applied={applied}
          onApply={onApply}
          fieldError={state.httpError?.status === 400 ? state.httpError.message : null}
          liveFlag={liveFlag}
          progress={<StageStepper state={state} />}
        />
      </aside>

      <main id="plan" className="min-w-0 pb-24" aria-busy={streaming}>
        <p className="sr-only" aria-live="polite" role="status">
          {announce}
        </p>
        <Banners state={state} onRunLive={() => run(lastInput.current, applied, true)} />
        <div className="grid grid-cols-1 gap-12">
          <ProfileCard state={state} onChip={(text) => (setInput(text), run(text, applied, liveFlag))} samples={samples} onSample={onSample} />
          <PublisherList state={state} />
          <Creatives state={state} />
          <ConfigView state={state} />
        </div>
      </main>
    </div>
  );
}

const noSubscribe = () => () => {};

/** Announces each stage as it lands, and the end of the run, to screen readers. */
function useAnnouncer(state: RunState, set: (s: string) => void) {
  const prev = useRef<RunState['stages'] | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = state.stages;
    if (state.status === 'done' && state.summary) {
      const replayed = state.summary.calls.length > 0 && state.summary.calls.every((c) => c.source !== 'live');
      set(replayed ? 'Plan loaded from the sample cache.' : `Run complete in ${(state.summary.total_ms / 1000).toFixed(1)} seconds.`);
      return;
    }
    if (!before) return;
    // One message per render: several stages can settle in one batch, and a second set() would replace the first.
    const changes: string[] = [];
    for (const s of STAGES) {
      const now = state.stages[s].status;
      if (now !== before[s].status && (now === 'done' || now === 'error' || now === 'skipped')) {
        changes.push(`${STAGE_LABEL[s]}: ${now === 'done' ? 'done' : now === 'error' ? 'failed' : 'skipped'}.`);
      }
    }
    if (changes.length) set(changes.join(' '));
  }, [state.stages, state.status, state.summary, set]);
}
