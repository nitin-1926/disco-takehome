'use client';

import { Check, CircleDashed, MinusCircle, WarningCircle } from '@phosphor-icons/react';
import { STAGES, type RunState, type StageState } from '@/lib/sse-client';
import type { Stage } from '@/lib/types';
import { secs, STAGE_LABEL, usd } from './format';

function Glyph({ s }: { s: StageState['status'] }) {
  if (s === 'done') return <Check size={14} weight="bold" className="text-ink" aria-hidden />;
  if (s === 'error') return <WarningCircle size={15} weight="fill" className="text-accent" aria-hidden />;
  if (s === 'skipped') return <MinusCircle size={15} className="text-ink-3" aria-hidden />;
  return <CircleDashed size={15} className={s === 'started' ? 'text-ink' : 'text-ink-3'} aria-hidden />;
}

const WORD: Record<StageState['status'], string> = { pending: 'waiting', started: 'working', done: 'done', skipped: 'skipped', error: 'failed' };

export function StageStepper({ state }: { state: RunState }) {
  const idle = state.status === 'idle';
  const done = STAGES.filter((s) => state.stages[s].status === 'done').length;
  const active = STAGES.find((s) => state.stages[s].status === 'started');
  const summary = state.summary;
  const replayed = summary && summary.calls.length > 0 && summary.calls.every((c) => c.source !== 'live');

  return (
    <section aria-label="Run progress">
      <h2 className="text-sm font-medium">Pipeline</h2>

      {/* Phone: one line plus seven segments. */}
      <div className="mt-2 lg:hidden">
        <p className="text-xs text-ink-2">
          {idle ? 'Not started' : active ? `${STAGE_LABEL[active]}` : state.status === 'done' ? 'Complete' : `${done} of ${STAGES.length} done`}
        </p>
        <div className="mt-2 grid grid-cols-7 gap-1" aria-hidden>
          {STAGES.map((s) => (
            <span key={s} className={`h-1 rounded-full ${segment(state.stages[s].status)}`} />
          ))}
        </div>
      </div>

      <ol className="mt-3 hidden lg:block">
        {STAGES.map((s) => (
          <Row key={s} stage={s} st={state.stages[s]} />
        ))}
      </ol>

      {summary && (
        <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4 text-xs">
          <div>
            <dt className="text-ink-3">Model calls</dt>
            <dd className="tabular mt-0.5 font-mono text-ink">
              {summary.calls.filter((c) => c.source === 'live').length}/{summary.calls.length} live
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">{replayed ? 'Replayed cost' : 'Live cost'}</dt>
            <dd className="tabular mt-0.5 font-mono text-ink">{usd(replayed ? summary.cost_replayed_usd : summary.cost_live_usd, true).replace(/^\$0\.00$/, '<$0.01')}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Time</dt>
            <dd className="tabular mt-0.5 font-mono text-ink">{secs(summary.total_ms)}</dd>
          </div>
          {replayed && <p className="col-span-3 text-ink-3">Served from the committed sample cache: no model was called. The cost shown is what the original run spent.</p>}
        </dl>
      )}
    </section>
  );
}

function segment(s: StageState['status']) {
  if (s === 'done') return 'bg-ink';
  if (s === 'error') return 'bg-accent';
  if (s === 'started') return 'bg-ink-3';
  return 'bg-line';
}

function Row({ stage, st }: { stage: Stage; st: StageState }) {
  return (
    <li className="relative flex min-h-9 items-center gap-3 overflow-hidden border-b border-line/60 text-sm last:border-b-0" aria-label={`${STAGE_LABEL[stage]}: ${WORD[st.status]}`}>
      <Glyph s={st.status} />
      <span className={st.status === 'pending' || st.status === 'skipped' ? 'text-ink-3' : 'text-ink'}>{STAGE_LABEL[stage]}</span>
      <span className="ml-auto flex items-center gap-2 text-xs text-ink-3">
        {st.source && st.status === 'done' && <span>{st.source === 'live' ? 'live' : st.source === 'code' ? 'code' : 'cached'}</span>}
        {st.ms !== undefined && st.status !== 'pending' && <span className="tabular font-mono">{secs(st.ms)}</span>}
        {st.status === 'skipped' && <span>skipped</span>}
      </span>
      {st.status === 'started' && (
        <span className="absolute inset-x-0 bottom-0 h-px overflow-hidden" aria-hidden>
          <span className="working-bar block h-px w-2/5 bg-accent" />
        </span>
      )}
    </li>
  );
}
