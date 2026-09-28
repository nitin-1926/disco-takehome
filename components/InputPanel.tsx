'use client';

import { ArrowRight, Sliders, Stop } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { BUDGET_MAX_USD, DURATION_MAX_DAYS, INPUT_MAX_CHARS } from '@/lib/settings';
import type { ConversionEvent, OfferType } from '@/lib/types';
import type { RunSettings, SampleChip } from './RunApp';

interface Props {
  input: string;
  setInput: (s: string) => void;
  streaming: boolean;
  onRun: () => void;
  onStop: () => void;
  samples: SampleChip[];
  onSample: (s: SampleChip) => void;
  applied: RunSettings;
  onApply: (s: RunSettings) => void;
  fieldError: string | null;
  liveFlag: boolean;
  /** The stage rail sits right under the Run button: it is the live feedback for that button. */
  progress: React.ReactNode;
}

export function InputPanel(p: Props) {
  const id = useId();
  const length = p.input.trim().length;
  const tooLong = p.input.length > INPUT_MAX_CHARS;
  const error = tooLong ? `Keep it under ${INPUT_MAX_CHARS} characters.` : p.fieldError;

  return (
    <section aria-label="Advertiser input" className="grid grid-cols-1 gap-5">
      <form
        className="grid grid-cols-1 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!p.streaming && length > 0 && !tooLong) p.onRun();
        }}
      >
        <label htmlFor={`${id}-input`} className="text-sm font-medium">
          What does the business sell, and to whom?
        </label>
        <textarea
          id={`${id}-input`}
          value={p.input}
          onChange={(e) => p.setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
          rows={4}
          aria-invalid={!!error}
          aria-describedby={`${id}-help`}
          className="w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-base leading-relaxed text-ink placeholder:text-ink-3 focus-visible:border-accent"
          placeholder="e.g. We sell refillable cleaning concentrates to people who care about plastic waste."
        />
        <div id={`${id}-help`} className="flex items-baseline justify-between gap-3 text-xs">
          <span className={error ? 'text-accent' : 'text-ink-3'} role={error ? 'alert' : undefined}>
            {error ?? 'One or two sentences is enough. Cmd/Ctrl + Enter runs it.'}
          </span>
          <span className={`tabular font-mono ${tooLong ? 'text-accent' : 'text-ink-3'}`}>
            {p.input.length}/{INPUT_MAX_CHARS}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3">
          {p.streaming ? (
            <button type="button" onClick={p.onStop} className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium transition active:translate-y-px">
              <Stop size={16} weight="fill" aria-hidden /> Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={length === 0 || tooLong}
              className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-sm font-semibold text-accent-ink transition hover:brightness-95 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
            >
              Plan campaign <ArrowRight size={16} weight="bold" aria-hidden />
            </button>
          )}
          {p.liveFlag && <span className="text-xs text-ink-2">Live mode: cache reads off</span>}
        </div>
      </form>

      {p.progress}

      <div>
        <h2 className="text-sm font-medium">Or try a sample</h2>
        <p className="mt-0.5 text-xs text-ink-3">Each one tests a different trap; samples replay from cache instantly.</p>
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {p.samples.map((s) => (
            <li key={s.n}>
              <button
                type="button"
                disabled={p.streaming}
                onClick={() => p.onSample(s)}
                title={s.text}
                aria-label={`Sample ${s.n}, ${s.trap}: ${s.text}`}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs transition hover:border-ink-3 active:translate-y-px disabled:opacity-45"
              >
                <span className="tabular font-mono text-ink-3">{s.n}</span>
                <span>{s.trap}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Keyed on the applied settings: a sample click resets them, and the form must reset with them. */}
      <SettingsPanel key={JSON.stringify(p.applied)} applied={p.applied} onApply={p.onApply} disabled={p.streaming} />
    </section>
  );
}

const EVENTS: { value: ConversionEvent; label: string }[] = [
  { value: 'purchase', label: 'First purchase' },
  { value: 'subscription', label: 'Subscription start' },
  { value: 'signup', label: 'Signup' },
];
const OFFERS: { value: '' | OfferType; label: string; amount: string | null }[] = [
  { value: '', label: 'No offer', amount: null },
  { value: 'pct_off', label: 'Percent off', amount: '%' },
  { value: 'fixed_off', label: 'Amount off', amount: '$' },
  { value: 'free_shipping', label: 'Free shipping', amount: null },
  { value: 'bogo', label: 'Buy one, get one', amount: null },
  { value: 'free_gift', label: 'Free gift', amount: null },
];

function SettingsPanel({ applied, onApply, disabled }: { applied: RunSettings; onApply: (s: RunSettings) => void; disabled: boolean }) {
  const id = useId();
  const [budget, setBudget] = useState(String(applied.budgetUsd));
  const [days, setDays] = useState(String(applied.durationDays));
  const [event, setEvent] = useState<ConversionEvent>(applied.conversionEvent);
  const [offerType, setOfferType] = useState<'' | OfferType>(applied.offer?.type ?? '');
  const [amount, setAmount] = useState(applied.offer?.amount != null ? String(applied.offer.amount) : '');
  const [code, setCode] = useState(applied.offer?.code ?? '');

  const b = Number(budget);
  const d = Number(days);
  const a = Number(amount);
  const offerMeta = OFFERS.find((o) => o.value === offerType)!;
  const errors = {
    budget: !(b >= 1 && b <= BUDGET_MAX_USD) ? `Enter a budget between $1 and $${BUDGET_MAX_USD.toLocaleString('en-US')}.` : null,
    days: !(Number.isInteger(d) && d >= 1 && d <= DURATION_MAX_DAYS) ? `Whole days, 1 to ${DURATION_MAX_DAYS}.` : null,
    amount: offerMeta.amount && !(a > 0 && (offerMeta.amount !== '%' || a < 100)) ? (offerMeta.amount === '%' ? 'A percent between 1 and 99.' : 'A positive amount.') : null,
  };
  const valid = !errors.budget && !errors.days && !errors.amount;
  const next: RunSettings = {
    budgetUsd: b,
    durationDays: d,
    conversionEvent: event,
    offer: offerType ? { type: offerType, amount: offerMeta.amount ? a : null, code: code.trim() || null } : null,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(applied);
  const field = 'w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink focus-visible:border-accent sm:text-sm';

  return (
    <details className="group rounded-panel border border-line bg-surface">
      <summary className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm font-medium">
        <span className="inline-flex items-center gap-2">
          <Sliders size={16} aria-hidden /> Budget, flight and offer
        </span>
        <span className="tabular font-mono text-xs text-ink-2">
          ${applied.budgetUsd.toLocaleString('en-US')} / {applied.durationDays}d{applied.offer ? ' / offer' : ''}
        </span>
      </summary>
      <form
        className="drawer grid grid-cols-1 gap-4 border-t border-line px-4 pb-4 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && dirty && !disabled) onApply(next);
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${id}-budget`} label="Budget (USD)" error={errors.budget}>
            <input id={`${id}-budget`} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} className={field} aria-invalid={!!errors.budget} aria-describedby={errors.budget ? `${id}-budget-error` : undefined} />
          </Field>
          <Field id={`${id}-days`} label="Flight (days)" error={errors.days}>
            <input id={`${id}-days`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className={field} aria-invalid={!!errors.days} aria-describedby={errors.days ? `${id}-days-error` : undefined} />
          </Field>
        </div>
        <Field id={`${id}-event`} label="Conversion event">
          <select id={`${id}-event`} value={event} onChange={(e) => setEvent(e.target.value as ConversionEvent)} className={field}>
            {EVENTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-offer`} label="Offer">
          <select id={`${id}-offer`} value={offerType} onChange={(e) => setOfferType(e.target.value as '' | OfferType)} className={field}>
            {OFFERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {offerType && (
          <div className="grid grid-cols-2 gap-3">
            {offerMeta.amount && (
              <Field id={`${id}-amount`} label={offerMeta.amount === '%' ? 'Percent' : 'Amount (USD)'} error={errors.amount}>
                <input id={`${id}-amount`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? `${id}-amount-error` : undefined} />
              </Field>
            )}
            <Field id={`${id}-code`} label="Promo code (optional)">
              <input id={`${id}-code`} value={code} maxLength={32} onChange={(e) => setCode(e.target.value)} className={`${field} uppercase`} />
            </Field>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink-3">{next.offer && JSON.stringify(next.offer) !== JSON.stringify(applied.offer) ? 'An offer change rewrites the creatives.' : 'Budget and flight recalculate the config instantly.'}</p>
          <button
            type="submit"
            disabled={!valid || !dirty || disabled}
            className="inline-flex min-h-10 shrink-0 items-center rounded-control border border-ink bg-ink px-4 text-sm font-medium text-bg transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </form>
    </details>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs text-accent" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
