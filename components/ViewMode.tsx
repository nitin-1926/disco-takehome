'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';

// Two readers, one page. The advertiser view is the product: reasons, ads, the plan. The reviewer view adds the
// working behind it: scores, formulas, critic verdicts, config JSON, stage timings. The choice lives in the URL
// (?view=reviewer, so a link carries it) and is remembered per browser.

export type ViewMode = 'advertiser' | 'reviewer';
const KEY = 'view-mode';
const ViewModeContext = createContext<ViewMode>('advertiser');

/** True in the reviewer view: render the working, not just the result. */
export const useDetail = () => useContext(ViewModeContext) === 'reviewer';
export const ViewModeProvider = ViewModeContext.Provider;

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const isMode = (v: string | null): v is ViewMode => v === 'reviewer' || v === 'advertiser';
function read(): ViewMode {
  const q = new URLSearchParams(window.location.search).get('view');
  if (isMode(q)) return q;
  try {
    const stored = localStorage.getItem(KEY);
    if (isMode(stored)) return stored;
  } catch {
    // per-browser convenience only
  }
  return 'advertiser';
}

export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const mode = useSyncExternalStore<ViewMode>(subscribe, read, () => 'advertiser');
  const set = (m: ViewMode) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', m);
    window.history.replaceState(null, '', url);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      // per-browser convenience only
    }
    for (const cb of listeners) cb();
  };
  return [mode, set];
}

export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div role="radiogroup" aria-label="View" className="inline-flex shrink-0 rounded-control border border-line bg-surface p-0.5 text-xs">
      {(['advertiser', 'reviewer'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => onChange(m)}
          className={`min-h-8 rounded-[4px] px-3 font-medium transition ${mode === m ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink'}`}
        >
          {m === 'advertiser' ? 'Advertiser' : 'Reviewer'}
        </button>
      ))}
    </div>
  );
}
