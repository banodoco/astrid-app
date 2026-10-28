import type { Generation, GenerationVariant, ManagedObject, Task } from '@/integrations/runtime/generated.ts';

/**
 * Where an asset came from, as far as the Runtime can prove.
 * `recorded` means a task settled the bytes but its capability is not one this
 * build describes, so the panel must not pretend either "generated" or "no record".
 */
export type ProvenanceOrigin = 'generated' | 'imported' | 'rendered' | 'recorded' | 'unknown';

export interface ProvenanceRecipeFact {
  label: string;
  value: string;
  mono?: boolean;
}

export interface ProvenanceInput {
  objectId: string;
  /** Null when the object is recorded but outside the page this view loaded. */
  filename: string | null;
  mediaType: string | null;
  loaded: boolean;
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
  kind: 'task' | 'generation' | 'none';
  /** Capability id, or the generation type when no task settled the bytes. */
  label: string;
  capability: string | null;
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
  /** Generation params this build has no label for — the producer-schema gap, made visible. */
  extraFields: ProvenanceRecipeFact[];
  /** The full prompt, when the generation recorded one (recipe keeps only short facts). */
  prompt: string | null;
  inputs: ProvenanceInput[];
  variants: ProvenanceVariant[];
  uses: ProvenanceUse[];
  /** Facts the workspace does not carry. Never a fact the scan simply did not reach. */
  gaps: string[];
  /** What the bounded read could not cover; shown apart from `gaps`. */
  limits: string[];
}

/** Which project-wide reads hit their cap, so the record can say so instead of guessing. */
export interface ProvenanceTruncation {
  objects: boolean;
  generations: boolean;
  tasks: boolean;
  variants: boolean;
  timelines: boolean;
}

/** Everything the record builder needs, already fetched and normalised. */
export interface ProvenanceSnapshot {
  objects: ManagedObject[];
  generations: Generation[];
  tasks: Task[];
  variants: GenerationVariant[];
  /** Object ids per timeline, for the "used in" list. */
  usage: Map<string, ProvenanceUse[]>;
  truncated?: Partial<ProvenanceTruncation>;
}
