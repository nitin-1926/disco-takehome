'use client';

import { CaretDown, Check, CheckCircle, Clock, WarningCircle, X } from '@phosphor-icons/react';
import type { RunState } from '@/lib/sse-client';
import type { Creative, PersonaScore } from '@/lib/types';
import { Section } from './ProfileCard';
import { persona, personaName, pubName, RULE_LABEL } from './format';

const LABEL: Record<string, string> = { strong: 'Strong', moderate: 'Moderate', weak: 'Weak', stretch: 'Stretch' };

export function Creatives({ state }: { state: RunState }) {
  const st = state.stages.creative;
  if (state.status === 'idle' || !state.profile || state.mode === 'stop') return null;
  const t = state.triage;
  const picked = state.personas?.filter((p) => p.picked) ?? [];

  const body = (() => {
    if (t?.viability === 'none' || st.status === 'skipped') {
      return (
        <p className="rounded-panel border border-dashed border-line px-4 py-6 text-sm text-ink-2">
          No creatives for this run: {t?.viability === 'none' ? 'no publisher in the catalog fits, so the budget is $0 and nothing is written.' : st.reason ?? 'an earlier step did not finish.'}
        </p>
      );
    }
    if (!state.creatives.length) {
      const n = picked.length || 3;
      return (
        <div className="grid grid-cols-1 gap-5">
          {Array.from({ length: n }, (_, i) => (
            <PendingCard key={i} p={picked[i]} failed={st.status === 'error' || (state.stages.score_personas.status === 'error' && !state.personas)} />
          ))}
        </div>
      );
    }
    return (
      <div className="grid divide-y divide-line">
        {state.creatives.map((c, i) => (
          <Card key={c.id} c={c} p={state.personas?.find((x) => x.persona_id === c.persona_id)} facts={state.profile!.facts} i={i} checking={state.stages.critic.status === 'started' || state.stages.revise.status === 'started'} />
        ))}
      </div>
    );
  })();

  const passed = state.personas?.filter((p) => !p.picked) ?? [];
  return (
    <Section title="Creatives" id="creatives">
      <p className="-mt-2 mb-5 max-w-[65ch] text-sm text-ink-2">One ad per persona, shown where it would run: on the order-confirmation page of a publisher that persona shops on.</p>
      {body}
      {passed.length > 0 && (
        <details className="mt-5 rounded-panel border border-line">
          <summary className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm">
            <span>
              Personas passed over <span className="tabular font-mono text-ink-3">({passed.length})</span>
            </span>
            <CaretDown size={14} className="text-ink-3" aria-hidden />
          </summary>
          <ul className="drawer grid grid-cols-1 gap-2 border-t border-line px-4 py-3 text-sm">
            {passed.map((p) => (
              <li key={p.persona_id} className="grid gap-0.5 sm:grid-cols-[14rem_minmax(0,1fr)_3rem] sm:gap-3">
                <span className="font-medium">{personaName(p.persona_id)}</span>
                <span className="text-ink-2">{p.conflicts.length ? `Clashes with "${p.conflicts[0].input_quote}" (${p.conflicts[0].field.replace(/_/g, ' ')}: ${p.conflicts[0].persona_value})` : p.why}</span>
                <span className="tabular font-mono text-xs text-ink-3 sm:text-right">{p.score.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function PendingCard({ p, failed }: { p?: PersonaScore; failed: boolean }) {
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]" aria-hidden={!failed}>
      <div className="rounded-panel bg-surface p-4" style={{ boxShadow: 'var(--frame-shadow)' }}>
        <div className="skeleton mb-4 h-3 w-1/3" />
        <div className="skeleton h-5 w-4/5" />
        <div className="skeleton mt-2 h-3.5 w-full" />
        <div className="skeleton mt-1.5 h-3.5 w-2/3" />
        <div className="skeleton mt-4 h-9 w-28" />
      </div>
      <div className="text-sm">
        {p ? <p className="font-medium">{personaName(p.persona_id)}</p> : <div className="skeleton h-4 w-40" />}
        <p className="mt-1 text-ink-3">{failed ? 'Not written: an earlier step failed.' : 'Writing for this persona...'}</p>
      </div>
    </div>
  );
}

function Card({ c, p, facts, i, checking }: { c: Creative; p?: PersonaScore; facts: { id: string; text: string }[]; i: number; checking: boolean }) {
  const who = persona(c.persona_id);
  if (c.error) {
    return (
      <article className="arrive my-6 rounded-panel border border-accent/40 bg-accent-soft px-4 py-4 text-sm first:mt-0" style={{ ['--i' as string]: i }}>
        <p className="font-medium">{personaName(c.persona_id)}: this ad could not be written</p>
        <p className="mt-1 text-ink-2">{c.error} The other personas are unaffected.</p>
      </article>
    );
  }
  const failed = c.critic?.checks.filter((k) => !k.pass) ?? [];
  const cited = facts.filter((f) => c.claims_used.includes(f.id));
  return (
    <article className="arrive grid gap-5 py-8 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]" style={{ ['--i' as string]: i }} aria-label={`Creative for ${personaName(c.persona_id)}`}>
      <div>
        <AdFrame c={c} />
        {c.revised_from && (
          <div className="mt-3 rounded-control border border-dashed border-line px-3 py-2 text-xs">
            <p className="text-ink-3">Before the critic</p>
            <p className="mt-1 text-ink-2 line-through decoration-ink-3/70">
              {c.revised_from.heading} / {c.revised_from.subheading}
            </p>
          </div>
        )}
      </div>

      <div className="min-w-0 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-base font-semibold">{personaName(c.persona_id)}</h3>
          {p && (
            <span className="text-xs text-ink-2">
              {LABEL[p.label]} <span className="tabular font-mono text-ink-3">{p.score.toFixed(2)}</span>
            </span>
          )}
        </div>
        {p && <p className="mt-1 text-ink-2">{p.why}</p>}
        {who && <p className="mt-1 text-xs text-ink-3">{who.age_range}, {who.gender_skew}, price sensitivity {who.price_sensitivity}</p>}

        <dl className="mt-4 grid grid-cols-1 gap-2.5">
          <Line label="Angle tested" value={c.angle} />
          {p && p.preferences_to_use.length > 0 && <Line label="Speaks to" value={p.preferences_to_use.join(', ')} />}
          {p && p.disinterests_to_avoid.length > 0 && <Line label="Steers clear of" value={p.disinterests_to_avoid.join(', ')} />}
          {p && p.conflicts.length > 0 && <Line label="Conflict" value={p.conflicts.map((x) => `"${x.input_quote}" vs ${x.field.replace(/_/g, ' ')} "${x.persona_value}"`).join('; ')} />}
          {p?.offer_depth && <Line label="Offer depth" value={p.offer_depth} />}
          <Line label="Facts cited" value={cited.length ? cited.map((f) => `${f.id} "${f.text}"`).join('; ') : 'none'} />
          {c.publisher_ids.length > 0 && <Line label="Runs on" value={c.publisher_ids.map(pubName).join(', ')} />}
        </dl>

        <div className="mt-4 border-t border-line pt-3">
          {!c.critic ? (
            <p className="flex items-center gap-2 text-ink-3">
              <Clock size={14} aria-hidden /> {checking ? 'The critic is reading this ad...' : 'Waiting for the critic.'}
            </p>
          ) : c.critic.unverified ? (
            <p className="flex items-center gap-2 text-ink-2">
              <Clock size={14} aria-hidden /> Not checked in time: the critic did not fit inside the time limit for this run. Treat this copy as a draft.
            </p>
          ) : (
            <>
              <p className="flex items-center gap-2 font-medium">
                {failed.length === 0 ? (
                  <>
                    <CheckCircle size={16} weight="fill" className="text-ok" aria-hidden /> Critic passed all {c.critic.checks.length} rules
                  </>
                ) : (
                  <>
                    <WarningCircle size={16} weight="fill" className="text-accent" aria-hidden /> Critic flagged {failed.length} {failed.length === 1 ? 'rule' : 'rules'}
                    {c.revised_from ? ', then the copy was revised' : ''}
                  </>
                )}
              </p>
              {failed.length > 0 && (
                <ul className="mt-2 grid grid-cols-1 gap-1.5">
                  {failed.map((k) => (
                    <li key={k.criterion} className="flex gap-2">
                      <X size={14} weight="bold" className="mt-0.5 shrink-0 text-accent" aria-label="failed" />
                      <span>
                        <span className="font-medium">{RULE_LABEL[k.criterion] ?? k.criterion}.</span> <span className="text-ink-2">{k.fix}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                {c.critic.checks
                  .filter((k) => k.pass)
                  .map((k) => (
                    <li key={k.criterion} className="inline-flex items-center gap-1">
                      <Check size={12} weight="bold" className="text-ok" aria-label="passed" /> {RULE_LABEL[k.criterion] ?? k.criterion}
                    </li>
                  ))}
              </ul>
            </>
          )}
          {c.grounding_flags.length > 0 && <p className="mt-2 text-xs text-accent">Code check: {c.grounding_flags.join('; ')}</p>}
        </div>
      </div>
    </article>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

/** The ad as the shopper would meet it: under the publisher's order confirmation. */
function AdFrame({ c }: { c: Creative }) {
  const store = c.publisher_ids[0] ? pubName(c.publisher_ids[0]) : null;
  return (
    <figure className="overflow-hidden rounded-panel bg-surface" style={{ boxShadow: 'var(--frame-shadow)' }}>
      <div className="flex items-center justify-between gap-3 border-b border-line bg-sunken px-4 py-2.5 text-xs">
        <span className="font-semibold tracking-tight">{store ?? 'Publisher store'}</span>
        <span className="inline-flex items-center gap-1 text-ink-2">
          <CheckCircle size={13} weight="fill" className="text-ok" aria-hidden /> Order confirmed
        </span>
      </div>
      <div className="px-4 pb-4 pt-3">
        <p className="text-[11px] text-ink-3">Sponsored offer for you</p>
        <p className="mt-1.5 text-[17px] font-semibold leading-snug tracking-tight">{c.heading}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">{c.subheading}</p>
        {c.disclosure && <p className="mt-1.5 text-[11px] text-ink-3">{c.disclosure}</p>}
        <div className="mt-3.5 flex items-center gap-3">
          <span className="inline-flex min-h-9 items-center rounded-control bg-ink px-4 text-sm font-medium text-bg">{c.cta}</span>
          <span className="text-xs text-ink-3">No thanks</span>
        </div>
      </div>
      <figcaption className="tabular border-t border-line px-4 py-2 font-mono text-[11px] text-ink-3">
        heading {c.char_counts.heading}/50, subheading {c.char_counts.subheading}/175
      </figcaption>
    </figure>
  );
}
