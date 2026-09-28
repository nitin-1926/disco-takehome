'use client';

import { ArrowClockwise, Info, WarningCircle } from '@phosphor-icons/react';
import type { RunState } from '@/lib/sse-client';
import type { GateError } from '@/lib/types';
import { STAGE_LABEL } from './format';

// Run-level problems, inline at the top of the plan (never toasts). Stage failures also show inside their section.

const TITLE: Partial<Record<GateError, string>> = {
  rate_limited: 'Live-run limit reached',
  in_progress: 'A run is already going',
  spend_cap: 'Live runs paused',
  daily_cap: 'Live runs paused until tomorrow',
  key_missing: 'Live runs unavailable',
  store_unavailable: 'Live runs unavailable',
};

const waitText = (sec: number) => (sec >= 5400 ? `${Math.ceil(sec / 3600)} h` : sec >= 90 ? `${Math.ceil(sec / 60)} min` : `${sec} s`);
export function Banners({ state, onRunLive }: { state: RunState; onRunLive: () => void }) {
  const e = state.httpError;
  const stale = state.errors.find((x) => x.code === 'cache_miss');
  const stageErrors = state.errors.filter((x) => x.code !== 'cache_miss' && x.code !== 'aborted');
  const items: React.ReactNode[] = [];

  if (e && e.status !== 400) {
    const retry = e.retryAfter ? ` Try again in ${waitText(e.retryAfter)}.` : '';
    items.push(<Banner key="http" tone="attention" title={TITLE[e.error as GateError] ?? 'Run stopped'} body={`${e.message}${retry}`} />);
  }
  if (stale) {
    items.push(
      <Banner key="stale" tone="attention" title="This sample's cached result is out of date" body="The prompts changed after the cache was written, so the replay stopped instead of calling the model silently.">
        <button type="button" onClick={onRunLive} className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-sm font-medium">
          <ArrowClockwise size={14} aria-hidden /> Run it live
        </button>
      </Banner>,
    );
  }
  if (stageErrors.length) {
    items.push(<Banner key="stage" tone="attention" title="Part of this run failed" body={stageErrors.map((x) => `${STAGE_LABEL[x.stage]}: ${x.message}`).join(' ')} note="Everything that finished is still shown below." />);
  }
  if (!items.length) return null;
  return <div className="mb-8 grid grid-cols-1 gap-3">{items}</div>;
}

export function Banner({ tone, title, body, note, children }: { tone: 'attention' | 'info'; title: string; body: string; note?: string; children?: React.ReactNode }) {
  const Icon = tone === 'attention' ? WarningCircle : Info;
  return (
    <div role={tone === 'attention' ? 'alert' : 'status'} className={`arrive flex gap-3 rounded-panel border px-4 py-3 ${tone === 'attention' ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface'}`}>
      <Icon size={18} weight={tone === 'attention' ? 'fill' : 'regular'} className={`mt-0.5 shrink-0 ${tone === 'attention' ? 'text-accent' : 'text-ink-2'}`} aria-hidden />
      <div className="text-sm">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-ink-2">{body}</p>
        {note && <p className="mt-0.5 text-ink-2">{note}</p>}
        {children}
      </div>
    </div>
  );
}
