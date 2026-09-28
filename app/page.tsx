import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RunApp, type SampleChip } from '@/components/RunApp';
import { sampleAdvertisers } from '@/lib/data';
import { EXPECTATIONS } from '@/eval/expectations';

// Static shell: the samples and their trap labels are read at build time; everything else streams in the client.
export default function Page() {
  const texts = sampleAdvertisers(readFileSync(path.join(process.cwd(), 'data/example_advertisers.txt'), 'utf8'));
  const samples: SampleChip[] = texts.map((text, i) => ({ n: i + 1, text, trap: EXPECTATIONS.find((e) => e.sample === i + 1)?.trap ?? 'sample' }));
  return <RunApp samples={samples} />;
}
