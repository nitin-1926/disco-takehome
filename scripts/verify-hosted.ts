// Evidence against the hosted app (plan U10), over plain HTTP so it needs no browser:
//   npm run verify:hosted -- https://<host>              every committed input replays with zero model calls in < 3 s,
//                                                        the gates answer, one client gets one in-flight live run
//   npm run verify:hosted -- https://<host> --live       + five live advertisers not in the samples, one ?live=1 run,
//                                                        one run cancelled mid-stage
// Prints a markdown report; screenshots are taken separately.

import { committedCache } from '../lib/data';

const host = process.argv[2]?.replace(/\/$/, '');
if (!host?.startsWith('http')) throw new Error('usage: verify-hosted <https://host> [--live]');
const live = process.argv.includes('--live');
/** Only the cancellation check (it spends one partial live run); for re-checking after a fix without the full suite. */
const cancelOnly = process.argv.includes('--cancel');

interface Outcome {
  status: number;
  ms: number;
  firstByteMs: number | null;
  understandMs: number | null;
  error?: string;
  errors: string[];
  calls: number;
  liveCalls: number;
  costLive: number;
  totalMs: number | null;
  cold: boolean | null;
  unverified: number;
  perCall: string;
}

async function run(body: Record<string, unknown>, opts: { abortAfter?: 'understand' } = {}): Promise<Outcome> {
  const ac = new AbortController();
  const t0 = Date.now();
  const res = await fetch(`${host}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json', origin: host }, body: JSON.stringify(body), signal: ac.signal });
  const base = { status: res.status, errors: [], calls: 0, liveCalls: 0, costLive: 0, totalMs: null, cold: null, unverified: 0, perCall: '', firstByteMs: null, understandMs: null };
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ...base, ms: Date.now() - t0, error: j.error };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let firstByteMs: number | null = null;
  let understandMs: number | null = null;
  const events: { type: string; stage?: string; status?: string; code?: string; payload?: { creatives?: { error: string | null; critic: { unverified: boolean } | null }[] }; summary?: { calls: { module: string; source: string; ms: number }[]; cost_live_usd: number; total_ms: number; cold: boolean } }[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      firstByteMs ??= Date.now() - t0;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const e = JSON.parse(line.slice(6));
        events.push(e);
        if (e.type === 'stage' && e.stage === 'understand' && e.status === 'done') {
          understandMs ??= Date.now() - t0;
          if (opts.abortAfter === 'understand') ac.abort();
        }
      }
    }
  } catch {
    /* aborted on purpose */
  }
  const done = events.find((e) => e.type === 'done')?.summary;
  const lastCards = [...events].reverse().find((e) => e.payload?.creatives)?.payload?.creatives ?? [];
  return {
    ...base,
    ms: Date.now() - t0,
    firstByteMs,
    understandMs,
    errors: events.filter((e) => e.type === 'error').map((e) => `${e.stage}:${e.code}`),
    calls: done?.calls.length ?? 0,
    liveCalls: done?.calls.filter((c) => c.source === 'live').length ?? 0,
    costLive: done?.cost_live_usd ?? 0,
    totalMs: done?.total_ms ?? null,
    cold: done?.cold ?? null,
    unverified: lastCards.filter((c) => !c.error && c.critic?.unverified).length,
    perCall: done ? summarizeCalls(done.calls) : '',
  };
}

function summarizeCalls(calls: { module: string; ms: number }[]): string {
  const by = new Map<string, number[]>();
  for (const c of calls) by.set(c.module, [...(by.get(c.module) ?? []), c.ms]);
  return [...by].map(([m, ms]) => `${m} ${ms.length > 1 ? `max ${Math.max(...ms)}` : ms[0]}`).join(', ');
}

/** Cancel mid-stage; the platform must stop the run and release the lock so the next run is admitted. */
async function cancelCheck(L: string[], check: (ok: boolean, what: string) => void) {
  // live: true so the calls are really in flight (a cached input would finish before the cancel lands).
  const cut = await run({ input: 'Hand-bound leather journals from a bindery in Vermont, $60.', live: true }, { abortAfter: 'understand' });
  L.push(`- cancelled after understand at ${s(cut.understandMs)}`);
  await new Promise((r) => setTimeout(r, 4000));
  const next = await run({ input: 'Small-batch granola with no added sugar, sold in 1 lb bags.' });
  check(next.status === 200, `after a cancelled run the next live run is admitted (${next.status})`);
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : 0);
const s = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

async function main() {
  const L: string[] = [`# Hosted verification`, '', `${host}, ${new Date().toISOString()}`, ''];
  let fails = 0;
  const check = (ok: boolean, what: string) => {
    if (!ok) fails++;
    L.push(`- ${ok ? 'PASS' : 'FAIL'} ${what}`);
  };

  if (cancelOnly) {
    await cancelCheck(L, check);
    L.push('', fails ? `${fails} check(s) failed.` : 'All checks passed.');
    console.log(L.join('\n'));
    process.exit(fails ? 1 : 0);
  }

  // Every committed input: sample chips, chip follow-ups, the injection twin.
  L.push('## Committed inputs replay', '', '| input | status | model calls | live | time |', '|---|---|---|---|---|');
  const replays: Outcome[] = [];
  for (const [input, label] of Object.entries(committedCache.inputs)) {
    const o = await run({ input });
    replays.push(o);
    L.push(`| ${label} | ${o.status} | ${o.calls} | ${o.liveCalls} | ${s(o.ms)} |`);
  }
  L.push('');
  check(replays.every((o) => o.status === 200 && o.liveCalls === 0 && o.errors.length === 0), `all ${replays.length} committed inputs replay with zero model calls and no errors`);
  check(replays.every((o) => o.ms < 3000), `every replay completes under 3 s (max ${s(Math.max(...replays.map((o) => o.ms)))})`);

  // Gates.
  check((await run({ input: 'x'.repeat(501) })).status === 400, 'over-length input returns 400 before any stream');
  const cross = await fetch(`${host}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"input":"x"}' });
  check(cross.status === 403, 'cross-site request returns 403');

  if (live) {
    const inputs = [
      'Carbon-neutral merino running socks, sold in 3-packs for $36.',
      'A meal-planning app for families with food allergies. $8 a month after a free trial.',
      'Handmade ceramic planters for apartment dwellers, $45 to $120, shipped from Portland.',
      "Kids' reusable water bottles that glow in the dark. Dishwasher safe, $22.",
      'Organic baby skincare: fragrance-free lotion, balm and wash for sensitive skin.',
    ];
    L.push('', '## Live runs', '', '| input | first byte | understand | done | calls | cost | cold | critic skipped | errors | slowest calls |', '|---|---|---|---|---|---|---|---|---|---|');
    const lives: Outcome[] = [];
    for (const input of inputs) {
      const o = await run({ input });
      lives.push(o);
      L.push(`| ${input.slice(0, 48)}... | ${s(o.firstByteMs)} | ${s(o.understandMs)} | ${s(o.ms)} | ${o.liveCalls}/${o.calls} | $${o.costLive.toFixed(4)} | ${o.cold ? 'yes' : 'no'} | ${o.unverified} | ${o.errors.join(', ') || '-'} | ${o.perCall} |`);
    }
    const done = lives.map((o) => o.ms);
    L.push('', `Live wall: p50 ${s(pct(done, 50))}, p95 ${s(pct(done, 95))}, max ${s(Math.max(...done))}; first byte max ${s(Math.max(...lives.map((o) => o.firstByteMs ?? 0)))}.`, '');
    check(lives.every((o) => o.status === 200 && o.errors.length === 0 && o.calls > 0), 'five live advertisers complete with no stage errors');
    check(pct(done, 95) <= 30_000, `live p95 within 30 s (${s(pct(done, 95))})`);

    // ?live=1 on a sample: every call live even though the sample is committed.
    const lf = await run({ input: Object.keys(committedCache.inputs)[0], live: true });
    L.push(`- ?live=1 on sample #1: ${lf.liveCalls}/${lf.calls} live, ${s(lf.ms)}, $${lf.costLive.toFixed(4)}`);
    check(lf.status === 200 && lf.liveCalls === lf.calls && lf.calls > 0, '?live=1 bypasses the cache and completes');

    // One client, two concurrent live runs: the second is refused while the first holds the lock.
    const [a, b] = await Promise.all([run({ input: 'Waxed canvas tote bags made in Maine, $95.' }), (async () => (await new Promise((r) => setTimeout(r, 1500)), run({ input: 'Loose-leaf oolong tea from a Taiwanese family farm.' })))()]);
    check(a.status === 200 && b.status === 429 && b.error === 'rate_limited', `same client, concurrent live runs: first streams (${a.status}), second refused (${b.status} ${b.error ?? ''})`);

    await cancelCheck(L, check);
  }

  L.push('', fails ? `${fails} check(s) failed.` : 'All checks passed.');
  console.log(L.join('\n'));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
