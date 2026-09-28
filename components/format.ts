import personasJson from '@/data/shopper_personas.json';
import publishersJson from '@/data/publishers.json';
import type { Persona, Publisher, Stage } from '@/lib/types';

export const PUBLISHERS = publishersJson as Publisher[];
export const PERSONAS = personasJson as Persona[];

export const publisher = (id: string) => PUBLISHERS.find((p) => p.id === id);
export const persona = (id: string) => PERSONAS.find((p) => p.id === id);
export const pubName = (id: string) => publisher(id)?.name ?? id;
export const personaName = (id: string) => persona(id)?.name ?? id;

export const usd = (n: number, cents = false) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const secs = (ms: number) => (ms < 100 ? '<0.1 s' : `${(ms / 1000).toFixed(1)} s`);

export const STAGE_LABEL: Record<Stage, string> = {
  understand: 'Read the brief',
  score_publishers: 'Score publishers',
  score_personas: 'Judge personas',
  creative: 'Write creatives',
  critic: 'Critic check',
  revise: 'Revise',
  config: 'Build config',
};

export const RULE_LABEL: Record<string, string> = {
  grounded: 'Grounded in the facts',
  persona_fit: 'Fits the persona',
  publisher_sensitivity: 'Respects publisher notes',
  leads_with_outcome: 'Leads with the outcome',
  one_thought: 'One continuous thought',
  no_friction_words: 'No friction words',
  no_health_claims: 'No health claims',
};

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign';
