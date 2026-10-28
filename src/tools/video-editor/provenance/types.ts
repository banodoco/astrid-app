import type { Generation, GenerationVariant, ManagedObject, Task } from '@/integrations/runtime/generated.ts';

/**
 * Where an asset came from, as far as the Runtime can prove.
 * `rendered` is a timeline render, `unknown` means the workspace holds the bytes
 * but no record of their producer — which is a state worth showing, not hiding.
 */
export type ProvenanceOrigin = 'generated' | 'imported' | 'rendered' | 'unknown';

export interface ProvenanceRecipeFact {
  label: string;
  value: string;
  mono?: boolean;
}

export interface ProvenanceInput {
  objectId: string;
  filename: string | null;
}

export interface ProvenanceVariant {
  generationId: string;
  objectId: string;
  viewedAt: string | null;
}

export interface ProvenanceUse {
  timelineId: string;
  timelineName: string;
}

export interface ProvenanceProducer {
  kind: 'generation' | 'render' | 'import' | 'unknown';
  /** Capability or generation type, e.g. `generation.generate_image`. */
  label: string;
  status: string | null;
  createdAt: string | null;
  taskId: string | null;
  runId: string | null;
  attemptId: string | null;
  generationId: string | null;
}

export interface ProvenanceRecord {
  objectId: string;
  filename: string;
  mediaType: string;
  size: number;
  digest: string;
  createdAt: string | null;
  origin: ProvenanceOrigin;
  producer: ProvenanceProducer;
  recipe: ProvenanceRecipeFact[];
  /** The full prompt, when the generation recorded one (recipe keeps only short facts). */
  prompt: string | null;
  inputs: ProvenanceInput[];
  variants: ProvenanceVariant[];
  uses: ProvenanceUse[];
  /** Facts the Runtime does not carry for this asset; shown instead of blank rows. */
  gaps: string[];
}

/** Everything the record builder needs, already fetched and normalised. */
export interface ProvenanceSnapshot {
  objects: ManagedObject[];
  generations: Generation[];
  tasks: Task[];
  variants: GenerationVariant[];
  /** Object ids per timeline, for the "used in" list. */
  usage: Map<string, ProvenanceUse[]>;
}
