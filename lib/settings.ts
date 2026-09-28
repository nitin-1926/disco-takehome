import type { ConversionEvent, Offer, OfferType, Settings } from './types';

// One normaliser for every caller (route, CLI, eval, UI) so the same input always hashes the same.

export const DEFAULT_SETTINGS = {
  budgetUsd: 10_000,
  durationDays: 30,
  conversionEvent: 'purchase' as ConversionEvent,
} as const;

export const INPUT_MAX_CHARS = 500;
export const BUDGET_MAX_USD = 10_000_000;
export const DURATION_MAX_DAYS = 365;

const OFFER_TYPES: OfferType[] = ['pct_off', 'fixed_off', 'bogo', 'free_shipping', 'free_gift'];
const EVENTS: ConversionEvent[] = ['purchase', 'signup', 'subscription'];

export interface RawSettings {
  budgetUsd?: unknown;
  durationDays?: unknown;
  conversionEvent?: unknown;
  offer?: unknown;
}

function finitePositive(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeOffer(v: unknown): Offer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!OFFER_TYPES.includes(o.type as OfferType)) return null;
  const amount = finitePositive(o.amount);
  const code = typeof o.code === 'string' && o.code.trim() ? o.code.trim().slice(0, 32) : null;
  return { type: o.type as OfferType, amount, code };
}

/** Canonical settings: defaults filled, invalid values dropped to defaults, offer null when absent. */
export function normalizeSettings(raw: RawSettings = {}): Settings {
  const budget = finitePositive(raw.budgetUsd);
  const duration = finitePositive(raw.durationDays);
  const event = EVENTS.includes(raw.conversionEvent as ConversionEvent) ? (raw.conversionEvent as ConversionEvent) : null;
  const offer = normalizeOffer(raw.offer);
  return {
    budgetUsd: budget ? Math.min(Math.max(1, Math.round(budget)), BUDGET_MAX_USD) : DEFAULT_SETTINGS.budgetUsd,
    durationDays: duration ? Math.min(Math.round(duration), DURATION_MAX_DAYS) : DEFAULT_SETTINGS.durationDays,
    conversionEvent: event ?? DEFAULT_SETTINGS.conversionEvent,
    offer,
  };
}

/** True when settings equal the defaults with no offer (the only shape a committed sample run has). */
export function isCanonical(s: Settings): boolean {
  return (
    s.budgetUsd === DEFAULT_SETTINGS.budgetUsd &&
    s.durationDays === DEFAULT_SETTINGS.durationDays &&
    s.conversionEvent === DEFAULT_SETTINGS.conversionEvent &&
    s.offer === null
  );
}

/** Whitespace-normalised input used for cache keys and committed-input matching. */
export function normalizeInput(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
