import { describe, expect, it } from 'vitest';
import type { Generation, GenerationVariant, ManagedObject, ObjectLocation, Task } from '@/integrations/runtime/generated.ts';
import { buildProvenanceRecord, buildProvenanceRecords, formatBytes, receiptFor, receiptJson, shortDigest } from './provenanceModel.ts';
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

function location(over: Partial<ObjectLocation> = {}): ObjectLocation {
  return {
    object_id: OBJECT_ID,
    digest: OBJECT_ID,
    size: 2_097_152,
    media_type: 'image/png',
    filename: 'hero-plate.png',
    local_path: '/Users/someone/Astrid/objects/hero-plate.png',
    storage: 'runtime_cas',
    verified: true,
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

const output = (digest: string, over: Record<string, unknown> = {}) => ({
  digest, filename: 'hero.mp4', role: 'result', media_type: 'video/mp4', is_primary: true, ...over,
});

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
    expect(record.producer.kind).toBe('generation');
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

  it('prefers a primary result over a side output that settled the same bytes', () => {
    const side = task({
      task_id: 'task-side',
      created_at: '2026-10-26T15:00:00.000+00:00',
      result: { outputs: [output(OBJECT_ID, { role: 'preview', is_primary: false, filename: 'preview.mp4' })] },
    });
    const primary = task({
      task_id: 'task-primary',
      created_at: '2026-10-26T16:00:00.000+00:00',
      result: { outputs: [output(OBJECT_ID)] },
    });

    const record = buildProvenanceRecord(object({ media_type: 'video/mp4' }), snapshot({ tasks: [side, primary] }));

    expect(record.producer.taskId).toBe('task-primary');
  });

  it('prefers the first production when both results are primary', () => {
    const first = task({ task_id: 'task-a', created_at: '2026-10-26T15:00:00.000+00:00', result: { outputs: [output(OBJECT_ID)] } });
    const retry = task({ task_id: 'task-b', created_at: '2026-10-26T17:00:00.000+00:00', result: { outputs: [output(OBJECT_ID)] } });

    const record = buildProvenanceRecord(object({ media_type: 'video/mp4' }), snapshot({ tasks: [retry, first] }));

    expect(record.producer.taskId).toBe('task-a');
  });

  it('names an unrecognised capability instead of claiming there is no producer', () => {
    const record = buildProvenanceRecord(object({ media_type: 'video/mp4' }), snapshot({
      tasks: [task({ capability_id: 'pack.acme.upscale', result: { outputs: [output(OBJECT_ID)] } })],
    }));

    expect(record.origin).toBe('recorded');
    expect(record.producer).toMatchObject({ kind: 'task', capability: 'pack.acme.upscale', taskId: 'task-1' });
    expect(record.gaps.join(' ')).toContain('not one this build describes');
    expect(record.gaps.join(' ')).not.toContain('No producer record');
  });

  it('surfaces parameters this build has no label for', () => {
    const record = buildProvenanceRecord(object(), snapshot({
      generations: [generation({ metadata: { params: { model: 'm', custom_strength: 0.7, shot_note: 'night' } } })],
      variants: [variant()],
    }));

    expect(record.extraFields).toEqual([
      { label: 'custom_strength', value: '0.7', mono: false },
      { label: 'shot_note', value: 'night', mono: false },
    ]);
  });

  it('says the producer search was bounded rather than calling the asset unproduced', () => {
    const record = buildProvenanceRecord(object(), snapshot({ truncated: { tasks: true } }));

    expect(record.origin).toBe('unknown');
    expect(record.gaps.join(' ')).not.toContain('No producer record');
    expect(record.limits.join(' ')).toContain('page boundary');
  });

  it('keeps an input that fell outside the loaded page, marked unloaded', () => {
    const record = buildProvenanceRecord(object(), snapshot({
      tasks: [task({
        input_object_ids: ['sha256:missing-input'],
        result: { outputs: [output(OBJECT_ID)] },
      })],
    }));

    expect(record.inputs).toEqual([
      { objectId: 'sha256:missing-input', filename: null, mediaType: null, loaded: false },
    ]);
    expect(record.gaps).not.toContain('No input objects recorded.');
    expect(record.limits.join(' ')).toContain('outside the page');
  });

  it('carries the input’s real media type when it is loaded', () => {
    const record = buildProvenanceRecord(object(), snapshot({
      objects: [object(), object({ object_id: 'sha256:audio-in', filename: 'bed.wav', media_type: 'audio/wav' })],
      tasks: [task({
        input_object_ids: ['sha256:audio-in'],
        result: { outputs: [output(OBJECT_ID)] },
      })],
    }));

    expect(record.inputs[0]).toEqual({
      objectId: 'sha256:audio-in', filename: 'bed.wav', mediaType: 'audio/wav', loaded: true,
    });
  });

  it('says so when nothing in the workspace produced the bytes and the read was complete', () => {
    const record = buildProvenanceRecord(object(), snapshot());

    expect(record.origin).toBe('unknown');
    expect(record.gaps).toEqual(expect.arrayContaining([
      'No producer record for this file in the workspace.',
      'No input objects recorded.',
    ]));
    expect(record.limits).toEqual([]);
  });

  it('lists the timelines that mention the object', () => {
    const record = buildProvenanceRecord(object(), snapshot({
      usage: new Map([[OBJECT_ID, [{ timelineId: 'timeline-1', timelineName: 'Main' }]]]),
    }));

    expect(record.uses).toEqual([{ timelineId: 'timeline-1', timelineName: 'Main' }]);
  });
});

describe('buildProvenanceRecords', () => {
  it('resolves a page of objects the same way the single-object builder does', () => {
    const snap = snapshot({
      objects: [
        object(),
        object({ object_id: 'sha256:second', filename: 'second.png', created_at: '2026-10-27T10:00:00.000+00:00' }),
      ],
      tasks: [task({ result: { outputs: [output(OBJECT_ID)] } })],
    });

    const many = buildProvenanceRecords(snap);

    expect(many).toHaveLength(2);
    expect(many[0].objectId).toBe('sha256:second');
    expect(many.find(record => record.objectId === OBJECT_ID)?.producer.taskId).toBe('task-1');
  });
});

describe('receipt', () => {
  it('drops the local path when the exporter is handed a location', () => {
    const record = buildProvenanceRecord(object(), snapshot());
    const receipt = receiptFor(record, { location: location() });
    const serialized = JSON.stringify(receipt);

    expect(receipt.integrity).toEqual({ storage: 'runtime_cas', size: 2_097_152, verified: true });
    expect(serialized).not.toMatch(/(\/Users\/|\/home\/)/);
    expect(serialized).not.toContain('local_path');
    expect(JSON.parse(receiptJson(record, { location: location() })).integrity.verified).toBe(true);
  });

  it('has no integrity block when no location was read', () => {
    expect(receiptFor(buildProvenanceRecord(object(), snapshot())).integrity).toBeNull();
  });

  it('carries gaps and limits separately so a bound never reads as a fact', () => {
    const receipt = receiptFor(buildProvenanceRecord(object(), snapshot({ truncated: { tasks: true } })));

    expect(receipt.gaps).toEqual([]);
    expect(receipt.limits).toHaveLength(1);
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
