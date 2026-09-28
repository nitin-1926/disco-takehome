'use client';

import { ArrowRight, Quotes } from '@phosphor-icons/react';
import type { RunState } from '@/lib/sse-client';
import { Banner } from './Banners';
import type { SampleChip } from './RunApp';
import { usd } from './format';

const CLARITY: Record<string, string> = { clear: 'Clear', vague: 'Vague', no_signal: 'No signal' };
const VIABILITY: Record<string, string> = { strong: 'Strong fit', weak: 'Weak fit', none: 'No fit' };

export function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="mb-4 text-xl font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="grid grid-cols-1 gap-2.5" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-3.5" style={{ width: `${[92, 70, 84, 60, 76][i % 5]}%` }} />
      ))}
    </div>
  );
}

export function ProfileCard({ state, onChip, samples, onSample }: { state: RunState; onChip: (text: string) => void; samples: SampleChip[]; onSample: (s: SampleChip) => void }) {
  const p = state.profile;
  if (!p) {
    if (state.status === 'idle') return null;
    return (
      <Section title="Brief" id="brief">
        {state.stages.understand.status === 'error' ? <p className="text-sm text-ink-2">The brief could not be read, so nothing else ran.</p> : <Skeleton lines={4} />}
      </Section>
    );
  }
  const t = state.triage ?? p.triage;
  const buyer = [p.buyer_age ? `ages ${p.buyer_age.low}-${p.buyer_age.high}` : null, p.buyer_gender === 'female' || p.buyer_gender === 'male' ? p.buyer_gender : null].filter(Boolean).join(', ');

  return (
    <Section title="Brief" id="brief">
      <div className="arrive grid grid-cols-1 gap-6">
        {p.triage.clarity !== 'no_signal' && (
          <div>
            <p className="text-lg font-medium leading-snug">{p.product}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <Item label="Category" value={[p.primary_category, ...p.subcategories].map((x) => x.replace(/_/g, ' ')).join(', ')} />
              <Item label="Price" value={p.price ? `${p.price.low === p.price.high ? usd(p.price.low) : `${usd(p.price.low)}-${usd(p.price.high)}`} ${p.price.basis === 'assumed' ? '(assumed)' : ''}` : `${p.price_tier} tier`} mono={!!p.price} />
              <Item label="Buyer" value={buyer || 'not stated'} />
              <Item label="Voice" value={p.tone || 'not stated'} />
            </dl>
          </div>
        )}

        <dl className="grid grid-cols-3 gap-3 rounded-panel border border-line bg-surface p-4 text-sm">
          <Item label="Clarity" value={CLARITY[p.triage.clarity]} strong />
          <Item label="Catalog fit" value={p.triage.clarity === 'clear' ? VIABILITY[t.viability] : 'not assessed'} strong={p.triage.clarity === 'clear'} />
          <Item label="Policy" value={p.triage.policy_banned ? 'Not allowed' : 'Allowed'} strong={p.triage.policy_banned} attention={p.triage.policy_banned} />
          <p className="col-span-3 text-ink-2">{p.triage.reason}</p>
          {state.viabilityNote && <p className="col-span-3 text-ink-2">Scores check: {state.viabilityNote}</p>}
        </dl>

        {p.triage.clarity === 'vague' && p.chips.length > 0 && (
          <div>
            <h3 className="text-sm font-medium">Which of these did you mean?</h3>
            <p className="mt-0.5 text-sm text-ink-2">Each reading quotes the words it came from. Picking one runs the plan on it.</p>
            <ul className="mt-3 grid grid-cols-1 gap-2">
              {p.chips.map((c) => (
                <li key={c.text}>
                  <button type="button" onClick={() => onChip(c.text)} disabled={state.status === 'streaming'} className="group flex w-full items-start justify-between gap-4 rounded-panel border border-line bg-surface px-4 py-3 text-left transition hover:border-ink-3 active:translate-y-px disabled:opacity-50">
                    <span>
                      <span className="block text-sm font-medium">{c.label}</span>
                      <span className="mt-0.5 block text-sm text-ink-2">{c.text}</span>
                      <span className="mt-1 block text-xs text-ink-3">Read from: &ldquo;{c.quote}&rdquo;</span>
                    </span>
                    <ArrowRight size={16} className="mt-1 shrink-0 text-ink-3 transition group-hover:text-ink" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {p.triage.clarity === 'no_signal' && (
          <div>
            <Banner tone="info" title="Nothing to plan from this yet" body="There is no product or buyer to work with. Say what you sell and who buys it, or start from one of these." />
            <div className="mt-3 flex flex-wrap gap-2">
              {samples.filter((s) => [1, 4, 9].includes(s.n)).map((s) => (
                <button key={s.n} type="button" onClick={() => onSample(s)} className="min-h-9 rounded-full border border-line bg-surface px-3 text-left text-xs transition hover:border-ink-3">
                  {s.text.split('.')[0]}.
                </button>
              ))}
            </div>
          </div>
        )}

        {p.facts.length > 0 && (
          <div>
            <h3 className="text-sm font-medium">Facts an ad may claim</h3>
            <p className="mt-0.5 text-xs text-ink-3">Copied word for word from the brief. The creatives cite these ids; anything else is flagged.</p>
            <ol className="mt-2 grid grid-cols-1 gap-1.5">
              {p.facts.map((f) => (
                <li key={f.id} className="flex gap-3 text-sm">
                  <span className="tabular w-6 shrink-0 font-mono text-xs leading-5 text-ink-3">{f.id}</span>
                  <span className="flex gap-1.5">
                    <Quotes size={12} weight="fill" className="mt-1 shrink-0 text-ink-3" aria-hidden />
                    {f.text}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {p.assumptions.length > 0 && (
          <div>
            <h3 className="text-sm font-medium">Assumed, not stated</h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {p.assumptions.map((a) => (
                <li key={`${a.field}-${a.value}`} className="rounded-full border border-dashed border-ink-3/60 px-3 py-1 text-xs" title={a.why}>
                  <span className="text-ink-2">{a.field.replace(/_/g, ' ')}:</span> {a.value}
                  <span className="sr-only">. {a.why}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

function Item({ label, value, mono, strong, attention }: { label: string; value: string; mono?: boolean; strong?: boolean; attention?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className={`mt-0.5 break-words ${mono ? 'tabular font-mono text-[13px]' : ''} ${strong ? 'font-medium' : ''} ${attention ? 'text-accent' : ''}`}>{value}</dd>
    </div>
  );
}
