# Campaign planner

An advertiser describes the business in a sentence or two. The app returns publishers ranked with a reason for every inclusion and exclusion, one post-purchase ad per selected shopper persona with the persona reasoning and a critic verdict visible, and a campaign config.

**Hosted:** https://disco-takehome-chi.vercel.app. The 15 sample chips replay from a committed cache (no model calls, under 1.5 s); your own text runs live.
**Local:** Node 24, `OPENAI_API_KEY` in `.env.local`, then `npm install && npm run dev`. `npm test` needs no key; `npm run eval` checks all 15 samples and writes `eval/output.md`. Prompts: one file per step in `prompts/`.

## What I built

The model judges, code decides. Publisher notes and persona descriptions are free text, so the model scores them on anchored 0-5 rubrics (category fit, tone fit, persona fit, conflicts quoted from both sides). Age, gender, income, order value and price are numbers, so code scores them, weighs, bands, allocates money and builds the config. Every score opens into a trace of both halves and the formula.

```
t=0: understand | score 20 publishers (one batched call) | judge 10 personas (parallel calls)
code: fit, gate x weights, red flags, bands, diverse persona pick
per persona: write ad -> critic (cheaper model, 7 rules) -> revise if flagged -> config (pure code)
```

Hosted, a live run is 20-27 calls and about $0.06: first byte under 1 s, p50 17 s, p95 20 s, streamed stage by stage. Triage has two axes: did we understand the input (clear, vague, no signal) and can this catalog serve it (strong, weak, none). The dental SaaS gets $0 and every exclusion explained; "We help people feel better" gets interpretation chips quoting its own words; a $1,200 handbag gets a 40% test budget on the three closest fits. The config follows Disco's public bid model (fixed CPA, CPC when the advertiser competes on price) and lists every guessed number in `assumptions[]` with its source.

Checks: `eval/expectations.ts` states what a correct answer contains per sample (#2, #11, #12 held out), plus invariants on every output (ids, allocations to the cent, Disco's character limits, claims traceable to quoted facts, an injected instruction lifts no excluded publisher). 389/389 pass. A grid of 1,368 weight and threshold sets passes every tuning check in 94% of cases, so the ranking does not hinge on the weights; the category gate and three red flags (category or tone below 3, a stated price far above the shoppers' order value) do the work.

## What I cut and why

- **A rerank stage**: designed, then dropped; the batched scoring call already explains why the top publisher beats the next.
- **Batched persona and critic calls**: measured at 13-16 s and 9-12 s, replaced by parallel per-persona and per-card calls (3-7 s each), so the critic fits inside the 29 s wall.
- **Dayparting, pacing, take rate**: no data to derive them; an advertiser config would not show network margin.
- **Image creative and auth**: outside the brief.

## Hard vs easy

Extraction, structured output and fluent copy are easy now. The hard parts, and the interesting engineering: calibration (pointwise scores cluster mid-scale, so "Pawline above Tailcrate" only holds with anchored rubrics, code-owned arithmetic and a test that fails when it flips); knowing when to say no (most samples are traps for a system that always answers); and cold start (every economic number is a prior until outcomes per publisher and persona replace it, which the 15% explore share is there to buy).

## Next week

Outcome feedback keyed by placement, creative and persona into the conversion prior. Scale the catalog: embedding retrieval is already wired (`RETRIEVE_K`), so at 20,000 publishers the same scoring call runs over parallel batches of 20. Then an offline-labelled ranker so no model sits in the serving path, and publisher controls (blocklists, category exclusions) as filter inputs.
