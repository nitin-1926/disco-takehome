# Campaign planner: publishers, persona creatives, config from one sentence

An advertiser describes the business in a sentence or two. The app returns publishers ranked with a reason for every inclusion and exclusion, one post-purchase ad per selected shopper persona with the persona reasoning and a critic verdict visible, and a campaign config.

**Hosted:** HOSTED_URL (sample chips replay instantly from a committed cache; typing your own text runs live).
**Run locally:** Node 24, `OPENAI_API_KEY` in `.env.local`, then `npm install && npm run dev`. Without Upstash env the spend cap and limiter fall back to memory.
**Check it:** `npm test` (unit and trap tests, no key needed), `npm run eval` (all 15 samples against `eval/expectations.ts`, report in `eval/output.md`), `npm run run -- --sample 3` (one run in the terminal). Every prompt is one file in `prompts/`.

## How it works

The model judges, code decides. Publisher notes and persona descriptions are free text, so the model scores them on anchored 0-5 rubrics (category fit, tone fit, persona fit, conflicts quoted from both sides). Age, gender, income, AOV and price are numbers, so code scores them, applies the weights, bands, allocates money and builds the config. Every score opens into a trace: model dims, code dims, the formula with its weights, and the prompt file.

```
t=0   understand ─┐   score 20 publishers (1 batched call) ─┐   judge 10 personas (10 parallel calls) ─┐
                  └──────────── code: fit, gate × weights, red flags, bands, persona pick (MMR) ◄───────┘
per picked persona: write ad → critic (cheaper model, 7 rules) → revise if it failed        → config (pure code)
```

Understand, scoring and personas all read the advertiser's words directly, so they start together; each picked persona then runs its own write, check, revise chain. A clear input costs 19-26 model calls and about $0.05, measured at p50 20 s and p95 27 s over the 15 samples run live (HOSTED_LATENCY). Stages stream over SSE as they land. The critic and revise must finish inside a 29 s wall or the card is marked unverified.

Triage has two axes: did we understand the input (clear, vague, no signal) and can this catalog serve it (strong, weak, none). The model's verdict is cross-checked against the scores. "B2B SaaS for dental practices" is clear and unservable: $0, every exclusion explained, nothing written. "We help people feel better" is vague: interpretation chips that quote the words they came from. A $1,200 handbag against publishers whose shoppers spend $120 is a weak fit: a 40% test budget on the three closest fits, not a launch.

## Evaluation

`eval/expectations.ts` states what a correct answer contains for each sample (for example: Pawline above Ruffco above Tailcrate for senior dog food; no creatives for the dental SaaS; the Gifter flagged against "ships in 6 weeks"). #2, #11 and #12 are held out. Invariants run on every output: ids exist, allocations sum to the cent, 3-5 creatives when viable, Disco character limits and CTA presets, every claim traceable to a quoted fact, no discount language without an offer, and a prompt-injection twin of sample #1 lifts no excluded publisher into the recommended band. Current run: 389/389 checks.

Weights were grid-searched on the stored model scores (1,368 weight and threshold combinations, no model calls). 94% of the grid passes every tuning check, so the result does not hinge on the weights. What does the work is the category gate and three red flags that keep a publisher out of "recommended" however high its score: category fit below 3, tone fit below 3, or a stated price far above that audience's order value. Before the red flags, a perfect tone score could buy back a 9x price gap.

## Campaign config

Campaign, flight, budget and bid, targeting, placements with share, allocation, conversion range and inventory used, creatives, personas, exclusions, measurement (target CPA and ROAS, 14-day attribution) and a launch checklist. The bid follows Disco's public model (fixed CPA for new customers, a CPC alternative when the advertiser competes on price). Every guessed number sits in `assumptions[]` with its source: CPA at 30% of price, a 1% conversion prior (band 0.5-2%), the 40% weak-fit factor.

## Hard vs easy

Easy: extraction, structured output, copy that reads well. Hard: (1) calibration, since pointwise model scores cluster mid-scale and "Pawline above Tailcrate" only stays true with anchored rubrics, code-owned arithmetic and a test that fails when it flips; (2) knowing when to say no, because most of the 15 samples are traps for a system that always answers; (3) cold start, since every economic number is a prior until outcome data per publisher and persona replaces it, which is what the 15% explore share buys.

## Changed or cut after measuring

A batched persona call (13-16 s) became ten parallel calls (3-7 s). A batched critic (9-12 s) became one check per card, so a slow card never holds the others. A separate rerank stage was designed and dropped: the batched scoring call already explains the top of the list. Dayparting and pacing: no data to derive them. Image creative: out of scope.

## At scale

The scoring function is the unit: at 20,000 publishers, embedding retrieval (already wired, `RETRIEVE_K`) picks candidates and the same call runs over batches of 20 in parallel. Next: outcome feedback into the conversion prior, an offline-labelled ranker so no model sits in the serving path, and Disco's publisher controls (blocklists, category exclusions) as filter inputs.
