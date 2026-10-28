import { describe, expect, it } from 'vitest';
import type { Generation, GenerationVariant, ManagedObject, Task } from '@/integrations/runtime/generated.ts';
import { buildProvenanceRecord, formatBytes, receiptFor, receiptJson, shortDigest } from './provenanceModel.ts';
import type { ProvenanceSnapshot } from './types.ts';

const OBJECT_ID = 'sha256:9f3c41b80d7e5a29c41b7ee021da55f0e7d2a1b3c4d5e6f708192a3b4c5d6e7f';

function object(over: Partial<ManagedObject> = {}): ManagedObject {
  return {
    object_id: OBJECT_ID,
    digest: OBJECT_ID,
    media_type: 'image/png',
    size: 2_097_152,
    version: 1,
    created_at: '2026-10-26T15:15:12.026+00:00',
    filename: 'hero-plate.png',
    relation: 'managed',
    ...over,
  };
}

function generation(over: Partial<Generation> = {}): Generation {
  return {
    generation_id: 'generation-task-b165af',
    project_id: 'project-1',
    type: 'image',
    status: 'completed',
    metadata: {},
    version: 1,
    created_at: '2026-10-26T16:31:42.501+00:00',
    updated_at: '2026-10-26T16:31:42.501+00:00',
    ...over,
  };
}

function variant(over: Partial<GenerationVariant> = {}): GenerationVariant {
  return {
    variant_id: 'variant-1',
    generation_id: 'generation-task-b165af',
    object_id: OBJECT_ID,
    variant_type: 'original',
    metadata: {},
    viewed_at: null,
    created_at: '2026-10-26T16:31:42.501+00:00',
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    task_id: 'task-1',
    run_id: 'run-1',
    project_id: 'project-1',
    state: 'succeeded',
    version: 1,
    capability_id: 'rendering.render',
    capability_digest: 'sha256:cap',
    idempotency_key: 'key-1',
    created_at: '2026-10-26T15:22:41.724+00:00',
    updated_at: '2026-10-26T15:23:41.724+00:00',
    attempt_id: 'attempt-1',
    runtime_epoch: 1,
    input_object_ids: [],
    spec: {},
    result: null,
    ...over,
  };
}

function snapshot(over: Partial<ProvenanceSnapshot> = {}): ProvenanceSnapshot {
  return {
    objects: [object()],
    generations: [],
    tasks: [],
    variants: [],
    usage: new Map(),
    ...over,
  };
}

describe('buildProvenanceRecord', () => {
  it('reports an imported generation without inventing a recipe', () => {
    const record = buildProvenanceRecord(object(), snapshot({
      generations: [generation({
        metadata: {
          params: { filename: 'hero-plate.png', width: 1280, height: 720 },
          provenance: { origin: 'imported', source: 'external_upload', actor_id: 'actor-1' },
        },
      })],
      variants: [variant()],
    }));

    expect(record.origin).toBe('imported');
    expect(record.producer.kind).toBe('import');
    expect(record.recipe.map(fact => fact.label)).toEqual(['Width', 'Height']);
    expect(record.gaps).toContain('Imported, not generated — no model or seed exists to show.');
  });

  it('keeps a generated asset’s recipe, seed and full prompt', () => {
    const prompt = 'a hamster turns to camera, warm studio light, shallow depth of field, 35mm, soft rim light';
    const record = buildProvenanceRecord(object(), snapshot({
      generations: [generation({
        metadata: {
          params: { model: 'wan-2.2-t2v-14b', seed: 813442907, steps: 28, cfg_scale: 5, prompt },
          provenance: { origin: 'generated' },
        },
      })],
      variants: [variant(), variant({ variant_id: 'variant-2', object_id: 'sha256:other', viewed_at: '2026-10-27T08:00:00Z' })],
    }));

    expect(record.origin).toBe('generated');
    expect(record.recipe).toEqual(expect.arrayContaining([
      { label: 'Model', value: 'wan-2.2-t2v-14b', mono: false },
      { label: 'Seed', value: '813442907', mono: true },
    ]));
    expect(record.prompt).toBe(prompt);
    expect(record.variants).toHaveLength(2);
  });

  it('prefers the task that settled the bytes and calls a render rendered', () => {
    const output = { digest: OBJECT_ID, filename: 'hello.mp4', role: 'result', media_type: 'video/mp4', name: 'video', ordinal: 0 };
    const record = buildProvenanceRecord(object({ media_type: 'video/mp4' }), snapshot({
      tasks: [task({ input_object_ids: ['sha256:input-a'], result: { outputs: [output] } })],
      objects: [object(), object({ object_id: 'sha256:input-a', filename: 'plate.png' })],
    }));

    expect(record.origin).toBe('rendered');
    expect(record.producer).toMatchObject({
      kind: 'render',
      label: 'rendering.render',
      status: 'succeeded',
      taskId: 'task-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
    });
    expect(record.inputs).toEqual([{ objectId: 'sha256:input-a', filename: 'plate.png' }]);
  });

  it('reads an import task as imported, not as a render', () => {
    const output = { digest: OBJECT_ID, filename: 'hero-plate.png', role: 'result' };
    const record = buildProvenanceRecord(object(), snapshot({
      tasks: [task({ capability_id: 'runtime.media.import.v1', result: { outputs: [output] } })],
    }));

    expect(record.origin).toBe('imported');
    expect(record.producer.kind).toBe('import');
  });

  it('says so when nothing in the workspace produced the bytes', () => {
    const record = buildProvenanceRecord(object(), snapshot());

    expect(record.origin).toBe('unknown');
    expect(record.gaps).toEqual(expect.arrayContaining([
      'No producer record for this file in the workspace.',
      'No input objects recorded.',
    ]));
  });

  it('lists the timelines that mention the object', () => {
    const record = buildProvenanceRecord(object(), snapshot({
      usage: new Map([[OBJECT_ID, [{ timelineId: 'timeline-1', timelineName: 'Main' }]]]),
    }));

    expect(record.uses).toEqual([{ timelineId: 'timeline-1', timelineName: 'Main' }]);
  });
});

describe('receipt', () => {
  it('carries digests and facts but no machine paths', () => {
    const record = buildProvenanceRecord(object(), snapshot());
    const receipt = receiptFor(record);

    expect(receipt.schema).toBe('astrid.provenance.v1');
    expect(receipt.asset.digest).toBe(OBJECT_ID);
    expect(receipt.asset.filename).toBe('hero-plate.png');
    expect(JSON.stringify(receipt)).not.toMatch(/(\/Users\/|\/home\/)/);
    expect(JSON.parse(receiptJson(record)).asset.object_id).toBe(OBJECT_ID);
  });
});

describe('formatting', () => {
  it('prints sizes the way the panel shows them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2_097_152)).toBe('2 MB');
    expect(formatBytes(1_536)).toBe('1.5 KB');
  });

  it('shortens a digest without losing both ends', () => {
    expect(shortDigest(OBJECT_ID)).toBe('9f3c41b8…6e7f');
    expect(shortDigest('sha256:abcd')).toBe('abcd');
  });
});
