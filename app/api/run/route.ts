import { after } from 'next/server';
import { z } from 'zod';
import { isCommittedInput } from '@/lib/cache';
import { env } from '@/lib/env';
import { RUN_WALL_MS, runPipeline } from '@/lib/pipeline';
import { BUDGET_MAX_USD, DURATION_MAX_DAYS, INPUT_MAX_CHARS, isCanonical, normalizeInput, normalizeSettings } from '@/lib/settings';
import { clientBucket, dailySpendKey, lastProbeRttMs, ledgerKey, runWorstCaseUsd, secondsToUtcMidnight, spendHook, spendKey, spendStore, storeHealthy, toMicro } from '@/lib/spend';
import type { GateError, RunContext, RunEvent, RunSummary } from '@/lib/types';

// POST /api/run → text/event-stream. Gates return JSON before any stream byte: 400 body, 403 origin, 503 key/store,
// 429 limiter/cap. A committed sample with canonical settings is replayed from the committed cache only (never billed,
// never rate-limited); everything else is live, capped per call inside callLLM.

export const maxDuration = 120;

const LOCK_TTL_SEC = maxDuration + 10;
const PADDING = `:${' '.repeat(2048)}\n\n`;
/** Far above any real body (input ≤ 500 chars plus settings); refused before parsing. */
const BODY_MAX_BYTES = 8_192;

const Body = z
  .object({
    input: z.string().max(BODY_MAX_BYTES),
    settings: z
      .object({
        budgetUsd: z.number().finite().min(1).max(BUDGET_MAX_USD).optional(),
        durationDays: z.number().int().positive().max(DURATION_MAX_DAYS).optional(),
        conversionEvent: z.enum(['purchase', 'signup', 'subscription']).optional(),
        offer: z
          .object({
            type: z.enum(['pct_off', 'fixed_off', 'bogo', 'free_shipping', 'free_gift']),
            amount: z.number().finite().positive().nullable().optional(),
            code: z.string().max(32).nullable().optional(),
          })
          .strict()
          .refine((o) => o.type !== 'pct_off' || o.amount == null || o.amount < 100, { message: 'percent off must be under 100', path: ['amount'] })
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    live: z.boolean().optional(),
  })
  .strict();


function fail(status: number, error: GateError, message: string, retryAfterSec?: number): Response {
  return Response.json(
    { error, message, ...(retryAfterSec ? { retry_after: retryAfterSec } : {}) },
    { status, headers: { 'Cache-Control': 'no-store', ...(retryAfterSec ? { 'Retry-After': String(retryAfterSec) } : {}) } },
  );
}

/** Same-origin only: fetch metadata when the browser sends it, else Origin must match Host. */
function sameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

let warm = false;

export async function POST(req: Request): Promise<Response> {
  const cold = !warm;
  warm = true;

  if (!sameOrigin(req)) return fail(403, 'forbidden', 'Cross-site requests are not accepted.');
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail(415, 'unsupported_media_type', 'JSON only.');
  if (Number(req.headers.get('content-length') ?? 0) > BODY_MAX_BYTES) return fail(413, 'too_large', 'Request body is too large.');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail(400, 'bad_request', 'Body is not valid JSON.');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return fail(400, 'bad_request', `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`);
  const input = normalizeInput(parsed.data.input);
  if (!input) return fail(400, 'bad_request', 'Describe the business in a sentence or two.');
  if (input.length > INPUT_MAX_CHARS) return fail(400, 'bad_request', `Keep it under ${INPUT_MAX_CHARS} characters.`);
  const settings = normalizeSettings(parsed.data.settings ?? {});
  const live = parsed.data.live === true;
  const replayOnly = !live && isCanonical(settings) && isCommittedInput(input);

  // ---- live gates (a replayed sample skips all of them) ----
  const e = env();
  const store = replayOnly ? null : spendStore();
  let lock: { key: string; token: string } | null = null;
  if (!replayOnly) {
    if (!e.openaiKey) return fail(503, 'key_missing', 'Live runs are unavailable right now. The sample chips still work.');
    if (!store || !(await storeHealthy(store))) return fail(503, 'store_unavailable', 'Live runs are unavailable right now. The sample chips still work.');
    const bucket = clientBucket(req.headers, e.isVercel);
    try {
      // Lock first: a refused concurrent request does not use up one of the window's runs.
      const token = crypto.randomUUID();
      if (!(await store.lock(`inflight:${bucket}`, token, LOCK_TTL_SEC))) return fail(429, 'in_progress', 'A live run from you is already in progress.', 10);
      lock = { key: `inflight:${bucket}`, token };
      const refuse = async (res: Response) => {
        await store.unlock(lock!.key, lock!.token);
        return res;
      };
      const w = await store.hit(`rl:${bucket}`, e.rateLimitWindowMin * 60);
      if (w.count > e.rateLimitRuns) return refuse(fail(429, 'rate_limited', 'You have used this hour’s live runs. The sample chips still work.', w.ttl));
      // Courtesy only: the binding check is the per-call reservation inside callLLM.
      const [spent, today] = await Promise.all([store.get(spendKey()), store.get(dailySpendKey())]);
      const worst = toMicro(runWorstCaseUsd());
      if (spent + worst > toMicro(e.spendCapUsd)) return refuse(fail(429, 'spend_cap', 'The demo’s spend cap is reached, so live runs are paused. The sample chips still work.'));
      if (today + worst > toMicro(e.spendCapDailyUsd)) return refuse(fail(429, 'daily_cap', 'Today’s live-run budget is used up. The sample chips still work.', secondsToUtcMidnight()));
    } catch (err) {
      console.error('[route] limiter/store error', (err as Error).message);
      if (lock) await store.unlock(lock.key, lock.token).catch(() => {});
      return fail(503, 'store_unavailable', 'Live runs are unavailable right now. The sample chips still work.');
    }
  }

  // ---- stream ----
  const run_id = crypto.randomUUID();
  const deferred: Array<() => Promise<void>> = [];
  const hook = store ? spendHook(store) : null;
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  let closed = false;
  let seq = 0;
  let summary: RunSummary | null = null;
  let crashed = false;
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const sink = (ev: RunEvent) => write(`id: ${++seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      write(PADDING); // defeats proxy/Safari buffering so the first stage paints immediately
      const ctx: RunContext = {
        run_id,
        sink,
        signal: abort.signal,
        wallAt: startedAt + RUN_WALL_MS,
        startedAt,
        cacheMode: { read: !live, replayOnly, writeCommitted: false },
        spend: hook,
        defer: (t) => deferred.push(t),
      };
      try {
        summary = (await runPipeline(input, settings, ctx, { cold })).summary;
      } catch (err) {
        // Pure code threw after the model calls. Every stream still ends in `done`, so the page never hangs.
        console.error('[route] pipeline threw', err);
        crashed = true;
        sink({ type: 'error', stage: 'config', code: 'provider_error', message: 'Something went wrong. Try again.' });
        sink({ type: 'done', summary: { run_id, cost_live_usd: 0, cost_replayed_usd: 0, calls: [], total_ms: Date.now() - startedAt, cold, skipped: [], errors: [{ stage: 'config', code: 'provider_error' }] } });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  // Settlement, cache writes, the lock release and the ledger row run after the response ends. With request
  // cancellation on (vercel.json), a client disconnect terminates the stream's own work, so these must not depend
  // on it: after() is the part the platform guarantees. Drain tasks appended while draining (calls still settling).
  after(async () => {
    if (lock && store) await store.unlock(lock.key, lock.token).catch((err) => console.error('[route] unlock failed', (err as Error).message));
    for (let i = 0; i < deferred.length; i++) {
      try {
        await deferred[i]();
      } catch (err) {
        console.error('[route] deferred task failed', (err as Error).message);
      }
    }
    if (replayOnly || !store) return;
    // Written once, after every settle: charged_usd is what the counter really holds for this run.
    const row = {
      ts: new Date().toISOString(),
      epoch: e.spendEpoch,
      source: e.isVercel ? 'vercel' : 'local',
      run_id,
      cold,
      live_flag: live,
      cost_usd: Number((summary?.cost_live_usd ?? 0).toFixed(6)),
      charged_usd: hook ? hook.reservedMicro() / 1e6 : 0,
      calls: (summary?.calls ?? []).map((c) => [c.module, c.source, c.ms]),
      total_ms: summary?.total_ms ?? Date.now() - startedAt,
      errors: summary?.errors ?? [],
      aborted: abort.signal.aborted || (!summary && !crashed),
      crashed,
      store_rtt_ms: lastProbeRttMs(),
    };
    await store.ledger(ledgerKey(), row).catch((err) => console.error('[route] ledger failed', (err as Error).message));
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
