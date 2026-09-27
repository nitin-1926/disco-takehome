import 'server-only';
import { cosineSimilarity, embed, embedMany } from 'ai';
import { cacheGet, cacheKey, pendingCommitted, redisSet, sha256, type CacheEntry } from './cache';
import { embeddingIndex, publishers } from './data';
import { openaiProvider } from './llm';
import { EMBEDDING_DIMENSIONS, MODEL_IDS, PRICES_USD_PER_M } from './models';
import type { CallRecord, Persona, Publisher, RunContext } from './types';

// Stage 2 retrieval. At K = catalog size this is a pass-through; it exists as the scale unit and feeds
// the trace column and the eval's embedding-scorer baseline. Never on the critical path.

export function publisherText(p: Publisher): string {
  return `${p.name}. Category: ${p.category}; ${p.subcategories.join(', ')}. Audience: ${p.audience.age_skew}, ${Math.round(p.audience.gender_split.female * 100)}% female, ${p.audience.income_tier} income, ${p.audience.top_geos.join('/')}. AOV $${p.avg_order_value_usd}. ${p.notes}`;
}

export function personaText(p: Persona): string {
  return `${p.name}. ${p.description} Affinities: ${p.category_affinities.join(', ')}. Prefers: ${p.messaging_preferences.join(', ')}. Avoids: ${p.disinterested_in.join(', ')}.`;
}

function embeddingModel() {
  return openaiProvider().embedding(MODEL_IDS.embedding);
}

const providerOptions = { openai: { dimensions: EMBEDDING_DIMENSIONS } };

function record(tokens: number, ms: number): CallRecord {
  const price = PRICES_USD_PER_M[MODEL_IDS.embedding];
  return { module: 'embed', model: MODEL_IDS.embedding, source: 'live', ms, inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: (tokens * price.input) / 1_000_000 };
}

export async function embedTexts(values: string[], signal?: AbortSignal): Promise<{ embeddings: number[][]; record: CallRecord }> {
  const started = Date.now();
  const res = await embedMany({ model: embeddingModel(), values, providerOptions, abortSignal: signal });
  return { embeddings: res.embeddings, record: record(res.usage.tokens, Date.now() - started) };
}

export async function embedOne(value: string, signal?: AbortSignal): Promise<{ embedding: number[]; record: CallRecord }> {
  const started = Date.now();
  const res = await embed({ model: embeddingModel(), value, providerOptions, abortSignal: signal });
  return { embedding: res.embedding, record: record(res.usage.tokens, Date.now() - started) };
}

export interface Retrieved {
  id: string;
  similarity: number | null;
}

export function topK(query: number[], index: Record<string, number[]>, k: number): Retrieved[] {
  return Object.entries(index)
    .map(([id, vec]) => ({ id, similarity: cosineSimilarity(query, vec) }))
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
    .slice(0, k);
}

/**
 * Candidates for scoring. Publishers missing from the committed index are embedded at request time;
 * if that fails they are included anyway with a null similarity (retrieval never silently drops a publisher).
 */
export async function retrievePublishers(input: string, k: number, signal?: AbortSignal): Promise<{ candidates: Retrieved[]; records: CallRecord[] }> {
  const records: CallRecord[] = [];
  const index: Record<string, number[]> = { ...embeddingIndex.publishers };
  const missing = publishers.filter((p) => !index[p.id]);
  if (missing.length && embeddingIndex.dimensions === EMBEDDING_DIMENSIONS) {
    try {
      const { embeddings, record } = await embedTexts(missing.map(publisherText), signal);
      missing.forEach((p, i) => (index[p.id] = embeddings[i]));
      records.push(record);
    } catch (e) {
      console.warn('[embed] request-time embedding failed; including unindexed publishers without similarity', (e as Error).message);
    }
  }
  if (Object.keys(index).length === 0) {
    return { candidates: publishers.map((p) => ({ id: p.id, similarity: null })), records };
  }
  const { embedding, record } = await embedOne(input, signal);
  records.push(record);
  const ranked = topK(embedding, index, k);
  const unindexed = publishers.filter((p) => !index[p.id]).map((p) => ({ id: p.id, similarity: null }));
  return { candidates: [...ranked, ...unindexed], records };
}

/**
 * Retrieval through the same cache as the LLM outputs, so a replayed sample never calls the embedding API.
 * Replay-only miss → every publisher with no similarity (retrieval is a trace column, not a gate, at K = catalog).
 */
export async function retrieveCached(input: string, k: number, ctx: RunContext): Promise<{ candidates: Retrieved[]; record: CallRecord | null }> {
  const key = cacheKey({
    module: 'retrieve',
    promptVersion: '1',
    instructionsHash: sha256(publisherIdsFingerprint()),
    model: MODEL_IDS.embedding,
    reasoning: 'none',
    schemaName: `dims-${EMBEDDING_DIMENSIONS}`,
    args: { input, k },
  });
  const hit = await cacheGet(key, ctx.cacheMode);
  if (hit) {
    if (ctx.cacheMode.writeCommitted) pendingCommitted.set(key, hit.entry);
    return {
      candidates: hit.entry.output as Retrieved[],
      record: { module: 'embed', model: hit.entry.model, source: hit.source, ms: 0, ...hit.entry.usage, costUsd: hit.entry.costUsd },
    };
  }
  if (ctx.cacheMode.replayOnly) return { candidates: publishers.map((p) => ({ id: p.id, similarity: null })), record: null };
  const { candidates, records } = await retrievePublishers(input, k, ctx.signal);
  const tokens = records.reduce((n, r) => n + r.inputTokens, 0);
  const cost = records.reduce((n, r) => n + r.costUsd, 0);
  const entry: CacheEntry = {
    output: candidates,
    usage: { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    costUsd: cost,
    model: MODEL_IDS.embedding,
    promptVersion: '1',
    storedAt: new Date().toISOString(),
  };
  ctx.defer(() => redisSet(key, entry));
  if (ctx.cacheMode.writeCommitted) pendingCommitted.set(key, entry);
  return {
    candidates,
    record: { module: 'embed', model: MODEL_IDS.embedding, source: 'live', ms: records.reduce((n, r) => n + r.ms, 0), inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: cost },
  };
}

/** The catalog's ids and indexed ids: a new or re-embedded publisher changes the retrieval key. */
function publisherIdsFingerprint(): string {
  return `${publishers.map((p) => p.id).sort().join(',')}|${Object.keys(embeddingIndex.publishers).sort().join(',')}|${embeddingIndex.model}`;
}
