'use client';

import { CaretDown } from '@phosphor-icons/react';
import { effectiveWeights, GATE, WEIGHTS } from '@/lib/funnel';
import type { RunState } from '@/lib/sse-client';
import type { Creative, Placement, PublisherScore } from '@/lib/types';
import { Banner } from './Banners';
import { Section, Skeleton } from './ProfileCard';
import { pct, personaName, publisher, pubName, usd } from './format';
import { useDetail } from './ViewMode';

export function PublisherList({ state }: { state: RunState }) {
  const detail = useDetail();
  const title = detail ? 'Publishers' : 'Where to run';
  const st = state.stages.score_publishers;
  const scores = state.publishers;
  if (state.status === 'idle' || !state.profile) return null;
  if (!scores) {
    if (st.status === 'skipped') return null; // the brief explains why (vague, no signal, banned)
    return (
      <Section title={title} id="publishers">
        {st.status === 'error' ? <p className="text-sm text-ink-2">Publisher scoring failed, so there is no ranking and no config for this run.</p> : <Skeleton lines={6} />}
      </Section>
    );
  }
  const placements = new Map((state.config?.placements ?? []).map((p) => [p.publisher_id, p]));
  const creatives = state.creatives.filter((c) => !c.error);
  const ranked = scores.filter((s) => s.band !== 'excluded');
  const v = state.triage?.viability;
  const cfg = state.config;

  return (
    <Section title={title} id="publishers">
      {v === 'weak' && cfg && (
        <div className="mb-4">
          <Banner tone="attention" title="Weak fit: a test budget, not a launch" body={cfg.warnings.find((w) => w.startsWith('Weak fit'))?.replace(/^Weak fit:\s*/, '').replace(/^./, (c) => c.toUpperCase()) ?? `The plan uses ${pct(cfg.budget.viability_factor)} of the budget on the closest fits.`} />
        </div>
      )}
      {v === 'none' && (
        <div className="mb-4">
          <Banner tone="attention" title="No publisher in this catalog fits" body="Budget is $0 and no creatives were written. Each publisher's reason for exclusion is below." />
        </div>
      )}

      {ranked.length > 0 && (
        <ol className="rounded-panel border border-line bg-surface">
          {ranked.map((s, i) => (
            <Row key={s.publisher_id} s={s} rank={i + 1} placement={placements.get(s.publisher_id)} creatives={creatives} priceBasis={state.profile?.price?.basis ?? null} i={i} detail={detail} />
          ))}
        </ol>
      )}

      {state.comparatives.length > 0 && ranked.length > 1 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Why the top of the list is in this order</h3>
          <ul className="mt-2 grid grid-cols-1 gap-1.5 text-sm text-ink-2">
            {state.comparatives.map((c) => (
              <li key={`${c.higher}-${c.lower}`}>
                <span className="font-medium text-ink">{pubName(c.higher)}</span> over <span className="font-medium text-ink">{pubName(c.lower)}</span>: {c.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.exclusionGroups.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium">
            {detail ? 'Excluded' : 'Not recommended'} ({state.exclusionGroups.reduce((n, g) => n + g.count, 0)})
          </h3>
          <div className="mt-2 grid grid-cols-1 gap-2">
            {state.exclusionGroups.map((g) => (
              <details key={g.group} className="rounded-panel border border-line">
                <summary className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm">
                  <span>
                    {g.group[0].toUpperCase() + g.group.slice(1)} <span className="tabular font-mono text-ink-3">({g.count})</span>
                  </span>
                  <CaretDown size={14} className="text-ink-3" aria-hidden />
                </summary>
                <ul className="drawer grid grid-cols-1 gap-2 border-t border-line px-4 py-3 text-sm">
                  {g.ids.map((id) => {
                    const s = scores.find((x) => x.publisher_id === id)!;
                    return (
                      <li key={id} className="flex flex-wrap gap-x-3">
                        <span className="font-medium">{pubName(id)}</span>
                        <span className="text-ink-2">{deciding(s, g.group, detail)}</span>
                        {detail && <span className="tabular ml-auto font-mono text-xs text-ink-3">{Math.round(s.score * 100)}</span>}
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

/** The line under an excluded publisher: the model's sentence for its own dimensions, code's for the numeric ones. */
function deciding(s: PublisherScore, group: string, detail: boolean): string {
  if (group.startsWith('audience')) return s.reasons.audience;
  if (group.startsWith('price')) return s.reasons.price;
  if (group.startsWith('not their category')) return detail ? `${s.reasons.category} (category fit ${s.category_fit}/5)` : s.reasons.category;
  return detail ? `${s.reasons.category} (tone fit ${s.tone_fit}/5)` : s.reasons.category;
}

/** What "held at weak" means to an advertiser; the reviewer view shows the flag as scored. */
function heldText(flag: string, detail: boolean): string {
  if (detail) return flag;
  if (flag.startsWith('category')) return 'not close enough to what they sell';
  if (flag.startsWith('tone')) return 'their shoppers may not respond to this pitch';
  if (flag.startsWith('price')) return 'priced well above what their shoppers spend';
  return flag;
}

/** The ads that run on a placement: the personas that shop there, or every ad when none does (the explore case). */
function adsOn(placement: Placement | undefined, creatives: Creative[], publisherId: string): { names: string[]; rotating: boolean } | null {
  if (!placement || creatives.length === 0) return null;
  const matched = creatives.filter((c) => c.publisher_ids.includes(publisherId));
  const shown = matched.length ? matched : creatives;
  return { names: shown.map((c) => personaName(c.persona_id)), rotating: matched.length === 0 };
}

function Row({ s, rank, placement, creatives, priceBasis, i, detail }: { s: PublisherScore; rank: number; placement?: Placement; creatives: Creative[]; priceBasis: 'stated' | 'assumed' | null; i: number; detail: boolean }) {
  const pub = publisher(s.publisher_id);
  const w = effectiveWeights(WEIGHTS, priceBasis);
  const weak = s.band !== 'recommended';
  const ads = adsOn(placement, creatives, s.publisher_id);
  const head = (
    <>
      <span className="tabular pt-0.5 font-mono text-xs text-ink-3">{rank}</span>
      <span className="min-w-0">
        <span className={`block font-medium ${weak ? 'text-ink-2' : ''}`}>{pubName(s.publisher_id)}</span>
        <span className="mt-0.5 block text-sm text-ink-2">{s.reasons.category}</span>
        {s.capped_by && <span className="mt-0.5 block text-xs text-ink-3">Held at weak: {heldText(s.capped_by, detail)}</span>}
        {ads && (
          <span className="mt-0.5 block text-xs text-ink-3">
            {ads.rotating ? `All ${ads.names.length} ads rotate here: no chosen persona shops on it, so this budget learns which one converts` : `Ads: ${ads.names.join(', ')}`}
          </span>
        )}
      </span>
      <span className="text-right text-xs">
        <span className={`block ${weak ? 'text-ink-3' : 'font-medium text-ink'}`}>{weak ? 'Weak fit' : 'Recommended'}</span>
        <span className="tabular block text-ink-2">{placement ? `${pct(placement.share)} of budget` : 'not placed'}</span>
        {detail && (
          <span className="tabular block font-mono text-sm text-ink" aria-label={`score ${Math.round(s.score * 100)} of 100`}>
            {Math.round(s.score * 100)}
          </span>
        )}
      </span>
    </>
  );
  const grid = 'grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3';

  if (!detail) {
    return (
      <li className={`arrive border-b border-line last:border-b-0 ${grid}`} style={{ ['--i' as string]: i }}>
        {head}
      </li>
    );
  }
  return (
    <li className="arrive border-b border-line last:border-b-0" style={{ ['--i' as string]: i }}>
      <details className="group">
        <summary className={grid}>
          {head}
          <span className="col-span-full flex items-center gap-1 text-xs text-ink-3 sm:col-start-2">
            <CaretDown size={12} className="transition group-open:rotate-180" aria-hidden /> How this score was built
          </span>
        </summary>
        <div className="drawer mx-4 mb-4 grid grid-cols-1 gap-3 rounded-control bg-sunken p-4 text-sm">
          <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-6">
            <Trace label="Category fit (model)" value={`${s.category_fit}/5`} note={pub ? `${pub.category}: ${pub.subcategories.join(', ')}` : ''} />
            <Trace label="Tone fit (model)" value={`${s.tone_fit}/5`} note={pub?.notes ?? ''} />
            <Trace label="Audience fit (code)" value={s.audience_fit.toFixed(2)} note={s.reasons.audience} />
            <Trace label="Price fit (code)" value={s.price_fit.toFixed(2)} note={s.reasons.price} />
          </div>
          <p className="tabular break-words font-mono text-xs leading-relaxed text-ink-2">
            gate({s.category_fit}) {GATE[s.category_fit]?.toFixed(1)} × ({w.tone.toFixed(2)} × tone {(s.tone_fit / 5).toFixed(2)} + {w.audience.toFixed(2)} × audience {s.audience_fit.toFixed(2)} + {w.price.toFixed(2)} × price {s.price_fit.toFixed(2)}) = {s.score.toFixed(3)}
          </p>
          <p className="text-xs text-ink-3">
            {priceBasis === 'assumed' ? 'Price was assumed, so its weight is halved. ' : ''}
            {s.retrieval_similarity !== null ? `Retrieval similarity ${s.retrieval_similarity.toFixed(3)}. ` : ''}
            {placement ? `Planned ${usd(placement.allocation_usd)}, ${placement.expected_conversions} conversions, ${placement.inventory_used_pct}% of its inventory. ` : ''}
            Scored by prompts/score-publishers.ts and lib/funnel.ts.
          </p>
        </div>
      </details>
    </li>
  );
}

function Trace({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink-2">{label}</span>
        <span className="tabular font-mono">{value}</span>
      </div>
      {note && <p className="mt-0.5 text-xs text-ink-3">{note}</p>}
    </div>
  );
}
