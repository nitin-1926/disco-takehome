import publishersJson from '@/data/publishers.json';
import personasJson from '@/data/shopper_personas.json';
import indexJson from '@/data/index.json';
import committedJson from '@/data/cache/committed.json';
import type { Persona, Publisher } from './types';

// Typed access to the static catalog and the committed artefacts. Static imports so Vercel bundles them.

export const publishers: Publisher[] = publishersJson as Publisher[];
export const personas: Persona[] = personasJson as Persona[];

export function publisherById(id: string): Publisher | undefined {
  return publishers.find((p) => p.id === id);
}

export function personaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}

export interface EmbeddingIndex {
  model: string;
  dimensions: number;
  publishers: Record<string, number[]>;
  personas: Record<string, number[]>;
}

export const embeddingIndex: EmbeddingIndex = indexJson as EmbeddingIndex;

export interface CommittedEntry {
  output: unknown;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
  costUsd: number;
  model: string;
  promptVersion: string;
  storedAt: string;
}

export interface CommittedCache {
  version: number;
  /** normalised input text -> sample label (the 15 samples and their chip follow-ups). */
  inputs: Record<string, string>;
  /** cache key -> stored LLM output. */
  entries: Record<string, CommittedEntry>;
}

export const committedCache: CommittedCache = committedJson as CommittedCache;

/** The 15 sample one-liners, in file order (1-based numbering matches the brief). */
export function sampleAdvertisers(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => l.replace(/^\d+\.\s*/, ''));
}
