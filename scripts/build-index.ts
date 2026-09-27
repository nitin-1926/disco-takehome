// Embeds every publisher and persona once and commits the vectors to data/index.json.
// Refuses to overwrite the index with fewer rows than it already has.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

import { embedTexts, personaText, publisherText } from '../lib/embed';
import { personas, publishers } from '../lib/data';
import { EMBEDDING_DIMENSIONS, MODEL_IDS } from '../lib/models';

async function main() {
  const path = 'data/index.json';
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { publishers: {}, personas: {} };
  const prevRows = Object.keys(previous.publishers ?? {}).length + Object.keys(previous.personas ?? {}).length;

  const pubTexts = publishers.map(publisherText);
  const perTexts = personas.map(personaText);
  const { embeddings, record } = await embedTexts([...pubTexts, ...perTexts]);

  const index = {
    model: MODEL_IDS.embedding,
    dimensions: EMBEDDING_DIMENSIONS,
    publishers: Object.fromEntries(publishers.map((p, i) => [p.id, embeddings[i].map((x) => Number(x.toFixed(6)))])),
    personas: Object.fromEntries(personas.map((p, i) => [p.id, embeddings[publishers.length + i].map((x) => Number(x.toFixed(6)))])),
  };
  const rows = publishers.length + personas.length;
  if (rows < prevRows) {
    console.error(`Refusing to overwrite: new index has ${rows} rows, committed has ${prevRows}`);
    process.exit(1);
  }
  writeFileSync(path, JSON.stringify(index));
  console.log(`Wrote ${path}: ${rows} vectors × ${EMBEDDING_DIMENSIONS} dims, ${record.inputTokens} tokens, $${record.costUsd.toFixed(5)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
