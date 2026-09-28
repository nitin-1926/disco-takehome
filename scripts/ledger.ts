// Ops view of the hosted spend state: counter per epoch, latest ledger rows, Redis round trip.
//   npm run ledger            (needs KV_REST_API_URL/TOKEN in .env.local; `vercel env pull` provides them)
//   npm run ledger -- v1 10   (epoch, rows)
import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

import { getRedis } from '../lib/cache';

async function main() {
  const r = getRedis();
  if (!r) throw new Error('No Upstash env: set KV_REST_API_URL and KV_REST_API_TOKEN.');
  const epoch = process.argv[2] ?? 'v1';
  const n = Number(process.argv[3] ?? 5);
  const t0 = Date.now();
  await r.ping();
  const rtt = Date.now() - t0;
  const spent = Number((await r.get(`spend:${epoch}`)) ?? 0) / 1e6;
  const cap = Number(process.env.SPEND_CAP_USD ?? 25);
  const rows = await r.lrange(`ledger:${epoch}`, 0, n - 1);
  console.log(`epoch ${epoch}: $${spent.toFixed(4)} counted (cap $${cap}, ${((spent / cap) * 100).toFixed(1)}% used); Redis RTT from here ${rtt} ms`);
  for (const x of rows) {
    const o = (typeof x === 'string' ? JSON.parse(x) : x) as { ts: string; source: string; cost_usd: number; reserved_usd: number; calls: unknown[]; total_ms: number; cold: boolean; errors: { stage: string; code: string }[]; aborted: boolean; store_rtt_ms?: number | null };
    console.log(`  ${o.ts} ${o.source} $${o.cost_usd.toFixed(4)} (reserved $${o.reserved_usd.toFixed(4)}) ${o.calls.length} calls ${o.total_ms} ms${o.cold ? ' cold' : ''}${o.store_rtt_ms != null ? ` redis ${o.store_rtt_ms} ms` : ''}${o.aborted ? ' ABORTED' : ''}${o.errors.length ? ` errors ${o.errors.map((e) => `${e.stage}:${e.code}`).join(',')}` : ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
