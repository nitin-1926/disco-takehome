'use client';

import { CaretDown, Check, Copy, DownloadSimple, WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import type { RunState } from '@/lib/sse-client';
import { Section, Skeleton } from './ProfileCard';
import { pct, pubName, slug, usd } from './format';

export function ConfigView({ state }: { state: RunState }) {
  const cfg = state.config;
  const st = state.stages.config;
  const [copied, setCopied] = useState(false);
  if (state.status === 'idle' || !state.profile) return null;
  if (!cfg) {
    if (st.status === 'skipped' && state.mode === 'stop' && !state.profile.triage.policy_banned) return null;
    return (
      <Section title="Campaign config" id="config">
        {st.status === 'skipped' || st.status === 'error' ? <p className="text-sm text-ink-2">No config: {st.reason ?? 'an earlier step failed.'}</p> : <Skeleton lines={5} />}
      </Section>
    );
  }
  const json = JSON.stringify(cfg, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign-${slug(cfg.campaign.name)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Section title="Campaign config" id="config">
      <div className="arrive grid grid-cols-1 gap-6">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-panel border border-line bg-surface p-4 text-sm sm:grid-cols-4">
          <Stat label="Budget" value={usd(cfg.budget.total_usd)} sub={cfg.budget.total_usd > 0 ? `${usd(cfg.budget.daily_cap_usd)} a day` : 'nothing to spend'} />
          <Stat label="Bid" value={`CPA ${usd(cfg.bidding.cpa_usd, true)}`} sub={cfg.bidding.cpc_alternative ? `or CPC ${usd(cfg.bidding.cpc_alternative.min_usd, true)}-${usd(cfg.bidding.cpc_alternative.max_usd, true)}` : cfg.campaign.objective} />
          <Stat label="Flight" value={`${cfg.flight.days} days`} sub={`${cfg.flight.start} to ${cfg.flight.end}`} />
          <Stat label="Expected conversions" value={String(cfg.measurement.expected_conversions)} sub={`${cfg.measurement.attribution_days}-day attribution`} />
          {cfg.flight.seasonality_note && <p className="col-span-full text-xs text-ink-2">{cfg.flight.seasonality_note}</p>}
        </dl>

        {cfg.warnings.length > 0 && (
          <ul className="grid grid-cols-1 gap-1.5 text-sm">
            {cfg.warnings.map((w) => (
              <li key={w} className="flex gap-2">
                <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        {cfg.placements.length > 0 && (
          <div className="overflow-x-auto rounded-panel border border-line">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">Placements</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th scope="col" className="px-4 py-2 font-normal">Publisher</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">Share</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">Budget</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">Conversions</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">Inventory used</th>
                </tr>
              </thead>
              <tbody className="tabular font-mono text-[13px]">
                {cfg.placements.map((p) => (
                  <tr key={p.publisher_id} className="border-b border-line/60 last:border-b-0">
                    <th scope="row" className="px-4 py-2 text-left font-sans text-sm font-medium">
                      {pubName(p.publisher_id)}
                      {p.role === 'explore' && <span className="ml-2 text-xs font-normal text-ink-3">explore</span>}
                    </th>
                    <td className="px-4 py-2 text-right">{pct(p.share)}</td>
                    <td className="px-4 py-2 text-right">{usd(p.allocation_usd)}</td>
                    <td className="px-4 py-2 text-right">{p.expected_conversions}</td>
                    <td className="px-4 py-2 text-right">{p.inventory_used_pct < 0.1 ? '<0.1' : p.inventory_used_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details className="rounded-panel border border-line">
          <summary className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm">
            <span>
              Every number that was assumed <span className="tabular font-mono text-ink-3">({cfg.assumptions.length})</span>
            </span>
            <CaretDown size={14} className="text-ink-3" aria-hidden />
          </summary>
          <ul className="drawer grid grid-cols-1 gap-3 border-t border-line px-4 py-3 text-sm">
            {cfg.assumptions.map((a) => (
              <li key={`${a.field}-${a.value}`}>
                <p>
                  <span className="font-mono text-[13px] text-ink-2">{a.field}</span> = <span className="font-medium">{a.value}</span>
                </p>
                <p className="text-ink-2">{a.why}</p>
                <p className="text-xs text-ink-3">Source: {a.source}</p>
              </li>
            ))}
          </ul>
        </details>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Config JSON</h3>
            <div className="flex gap-2">
              <button type="button" onClick={copy} className="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm transition active:translate-y-px" aria-live="polite">
                {copied ? <Check size={14} weight="bold" className="text-ok" aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" onClick={download} className="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm transition active:translate-y-px">
                <DownloadSimple size={14} aria-hidden /> Download
              </button>
            </div>
          </div>
          <pre className="tabular max-h-[520px] overflow-auto rounded-panel bg-sunken p-4 font-mono text-[12.5px] leading-relaxed" tabIndex={0} aria-label="Campaign config as JSON">
            <Json value={cfg} indent={0} />
          </pre>
        </div>
      </div>
    </Section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="tabular mt-0.5 font-mono text-[15px] font-medium">{value}</dd>
      <dd className="mt-0.5 text-xs text-ink-2">{sub}</dd>
    </div>
  );
}

/** JSON as React nodes: escaped by React, no HTML injection path. */
function Json({ value, indent }: { value: unknown; indent: number }): React.ReactNode {
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (value === null) return <span className="text-ink-3">null</span>;
  if (typeof value === 'string') return <span className="text-ink">{JSON.stringify(value)}</span>;
  if (typeof value === 'number' || typeof value === 'boolean') return <span className="text-ok">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-ink-3">[]</span>;
    return (
      <>
        <span className="text-ink-3">[</span>
        {'\n'}
        {value.map((v, i) => (
          <span key={i}>
            {pad}
            <Json value={v} indent={indent + 1} />
            {i < value.length - 1 && <span className="text-ink-3">,</span>}
            {'\n'}
          </span>
        ))}
        {end}
        <span className="text-ink-3">]</span>
      </>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="text-ink-3">{'{}'}</span>;
  return (
    <>
      <span className="text-ink-3">{'{'}</span>
      {'\n'}
      {entries.map(([k, v], i) => (
        <span key={k}>
          {pad}
          <span className="text-ink-2">{JSON.stringify(k)}</span>
          <span className="text-ink-3">: </span>
          <Json value={v} indent={indent + 1} />
          {i < entries.length - 1 && <span className="text-ink-3">,</span>}
          {'\n'}
        </span>
      ))}
      {end}
      <span className="text-ink-3">{'}'}</span>
    </>
  );
}
