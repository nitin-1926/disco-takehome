# Campaign planner

One sentence in; ranked publishers with reasons, an ad per persona and a config out.

**What I built and how to run it.** Hosted: https://disco-takehome-chi.vercel.app (chips replay from a committed cache; your text runs live). Two views: advertiser (the product) and reviewer (`?view=reviewer`: every score, formula, critic verdict and config JSON). Local: Node 24, `npm install && npm run dev`; chips need no key, live input needs `OPENAI_API_KEY` in `.env.local`.

The model judges, code decides. Free text (publisher notes, persona descriptions) gets anchored 0-5 rubrics from the model; numbers (age, income, order value, price) by code, which allocates money and builds the config; an unstated buyer or price is estimated and labelled assumed. A cheaper model critiques each ad; flagged ads are revised. Triage decides if we understood the input and the catalog can serve it: dental SaaS gets $0, every exclusion explained, vague inputs get chips quoting their words, a $1,200 handbag a 40% test budget. `eval/expectations.ts` holds a correct answer per sample (3 held out) plus invariants (ids, cents, character limits, grounding, injection): 392/393 pass, held-out 7/7; five unseen inputs read cold before shipping.

**Config shape, and why.** One draft a human can review and launch. `targeting`; `budget` (total, daily cap, explore share); `bidding` (fixed CPA as a share of price, Disco's model; CPC when competing on price); `placements` (dollars, conversions and creatives per publisher); `measurement`; `exclusions`; `warnings`; `assumptions[]`, so every guess names its source.

**With another week.** Feed outcomes by placement, creative and persona into the conversion prior; score a 20,000-publisher catalog through the retrieval step already wired (`RETRIEVE_K`); then an offline-labelled ranker, taking the model out of the serving path.

**What I cut and why.** A rerank stage (scoring already compares neighbours); pacing and dayparting (no data to derive them); auth and image creatives (outside the brief; per-client limits and spend caps bound the public endpoint).

**Hard vs easy, and where the engineering lives.** Extraction, structured output and fluent copy are easy; the work is around the model: calibration (scores cluster mid-scale, so "Pawline above Tailcrate" holds only with anchored rubrics, code arithmetic and a test that fails if it flips); saying no (most samples are traps); cold start (every economic number is a prior until outcomes, bought by the 15% explore budget, replace it); and evaluating honestly: an unstated buyer scored audience 1.0 on 13 of 15 samples, and 90% of weight sets passed every check because the dimension never varied; once the buyer is estimated, one blind-era expectation fails by 0.004 and the plateau narrows to 42%. It stays red; hiding it with a threshold is tuning to samples.
