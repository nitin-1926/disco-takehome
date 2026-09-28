# Campaign planner

Describe a business in a sentence; get ranked publishers with a reason for every inclusion and exclusion, one ad per selected persona (reasoning and critic verdict shown), and a campaign config.

**What I built and how to run it.** Hosted: https://disco-takehome-chi.vercel.app (sample chips replay from a committed cache; your text runs live). Local: Node 24, `npm install && npm run dev`; chips need no key, live input needs `OPENAI_API_KEY` in `.env.local`. Every sample's output: `eval/output.md`.

The model judges, code decides. Publisher notes and persona descriptions are free text, so the model scores them on anchored 0-5 rubrics. Age, income, order value and price are numbers, so code scores them, allocates money and builds the config. A cheaper second model critiques each ad; flagged ads are revised. Triage asks if we understood the input and if this catalog can serve it: the dental SaaS gets $0 with every exclusion explained, vague inputs get interpretation chips quoting their own words, a $1,200 handbag gets a 40% test budget, banned categories get $0. `eval/expectations.ts` defines a correct answer per sample (#2, #11, #12 held out), plus invariants on ids, cents, character limits, grounding and prompt injection: 398/398 pass. 90% of 1,368 weight and threshold sets pass every tuning check.

**Config shape, and why.** One draft a human can review and launch. `targeting`; `budget` (total, daily cap, explore share); `bidding` (fixed CPA as a share of price with a starting range, Disco's model; CPC when competing on price); per-publisher `placements` (dollars, impression and conversion ranges, creatives); `measurement`; `exclusions`; `warnings`; `assumptions[]`, so every guess names its source.

**With another week.** Feed outcomes by placement, creative and persona into the conversion prior; score a 20,000-publisher catalog through the retrieval step already wired (`RETRIEVE_K`); then an offline-labelled ranker, taking the model out of the serving path.

**What I cut and why.** A rerank stage (the scoring call already compares neighbours); pacing and dayparting (no data to derive them); auth and image creatives (outside the brief; per-client limits and spend caps bound the public endpoint instead).

**Hard vs easy, and where the engineering lives.** Extraction, structured output and fluent copy are easy. The interesting work is in the code around the model: calibration (scores cluster mid-scale, so "Pawline above Tailcrate" holds only with anchored rubrics, code-owned arithmetic and a test that fails when it flips); knowing when to say no (most samples are traps); and cold start (every economic number is a prior until outcomes replace it, which the 15% explore budget buys).
