import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CanonicalDocument, EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import corpus from '../../../../tests/fixtures/p1-feasibility/cases.json';
import appTrim from './fixtures/recipe_m2_clip_trim.json';
import appMove from './fixtures/recipe_m1_move.json';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { executeClipMove } from './clipMoveCapture.ts';
import { executeClipTrim } from './clipTrimCapture.ts';
import { environment, scope } from './__tests__/commitSessionEnvironment.ts';

type CorpusCase = (typeof corpus.cases)[number];
type Source = CorpusCase['source'];
type JsonObject = Record<string, unknown>;

const appRoot = resolve(import.meta.dirname, '../../../../');
const mutableHarnessSourceKind = 'e2e-seed-and-harness';
const mutableHarnessSourcePath = 'tests/e2e/local/support/harness.ts';

function sourceRoot(source: Source): string {
  return source.repo === 'app' ? appRoot : resolve('/home/user/work/agent');
}

function sourcePath(source: Source): string {
  return resolve(sourceRoot(source), source.path);
}

function readSource(source: Source): JsonObject {
  return JSON.parse(readFileSync(sourcePath(source), 'utf8')) as JsonObject;
}

function sourceSha(source: Source): string {
  const bytes = execFileSync('git', ['-C', sourceRoot(source), 'show', `${source.commit}:${source.path}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return createHash('sha256').update(bytes).digest('hex');
}

function currentSourceSha(source: Source): string {
  return createHash('sha256').update(readFileSync(sourcePath(source))).digest('hex');
}

function isMutableHarnessSource(entry: CorpusCase): boolean {
  return entry.kind === mutableHarnessSourceKind
    && entry.source.repo === 'app'
    && entry.source.path === mutableHarnessSourcePath
    && 'journey_sources' in entry;
}

function parentClip(bundle: JsonObject, id: string): JsonObject {
  const parent = bundle.parent as JsonObject;
  const clips = parent.clips as JsonObject[];
  const clip = clips.find((candidate) => candidate.id === id);
  if (!clip) throw new Error(`Missing parent clip ${id}`);
  return clip;
}

function expectSource(entry: CorpusCase): void {
  const { source } = entry;
  expect(sourceSha(source), source.path).toBe(source.sha256);
  if (isMutableHarnessSource(entry)) {
    expect(readFileSync(sourcePath(source)).byteLength, source.path).toBeGreaterThan(0);
    return;
  }
  expect(currentSourceSha(source), `current ${source.path}`).toBe(source.sha256);
}

describe('P1 feasibility corpus', () => {
  it.each(corpus.cases)('keeps exact provenance for $id', (entry) => {
    expectSource(entry);
    expect(entry.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('validates real App trim document effects and the created-id handoff source', async () => {
    const document = appTrim.input as unknown as CanonicalDocument;
    const bundle = await authoringBundleFromDocument(document);
    const command = appTrim.commands[0] as EditCommand;
    const result = executeClipTrim(bundle, command);
    const clip = parentClip(result.bundle, 'clip-a');

    expect(command).toMatchObject(corpus.cases[0].command);
    expect(clip).toMatchObject({ from: 1, to: 5, hold: 4, speed: 2 });
    expect((clip.app as JsonObject).astrid).toEqual({ opaque: [null, false] });
    expect((result.record.writes ?? []).map((write) => write.path.join('.'))).toEqual(expect.arrayContaining([
      'from', 'to', 'hold', 'app',
    ]));

    const split = readSource(corpus.cases.find((entry) => entry.id === 'agent-split-created-id')!.source);
    const splitCommand = (split.commands as JsonObject[])[0];
    expect(splitCommand).toMatchObject({ op: 'clip.split', args: { right_id: 'right' } });
    expect((splitCommand.args as JsonObject).right_id).toBe('right');
    // This is the deliberate cross-product handoff: App can trim the mapped id,
    // but this branch has no App split port that can produce it on the wire.
  });

  it('validates the real App move fixture and preserves disjoint authored fields', async () => {
    const bundle = appMove.bundle;
    const command = appMove.command as EditCommand;
    const result = executeClipMove(bundle, command);
    const clip = parentClip(result.bundle, 'c');

    expect(command).toMatchObject(corpus.cases[2].command);
    expect(clip).toMatchObject({ at: 4.004, from: 2, to: 6, speed: 2 });
    expect(clip.app).toMatchObject({ opaque: { keep: true }, astrid: { cut: 'old-cut', fixed_start: true, for: 2 } });
  });

  it('describes every H3 reply disposition and records the unavailable seams', () => {
    expect(corpus.h3_chain.status).toBe('authored-not-go');
    expect(corpus.h3_chain.steps.map((step) => step.event ?? step.op)).toEqual([
      'clip.split', 'clip.trim', 'track.set', 'lost acknowledgement', 'restart and recover',
    ]);
    expect(corpus.h3_chain.replies.map((reply) => reply.kind)).toEqual(['accepted', 'merged', 'refused']);
    expect(corpus.h3_chain.replies.map((reply) => reply.runtime_wire)).toEqual(['accepted', 'rebased', 'refused/conflict']);
    expect(corpus.h3_chain.required_seams).toEqual(expect.arrayContaining([
      'App split capture/submit port for clip.split and created-id binding',
      'A2 dependent revalidation or rollback after predecessor refusal',
      'R1 doc.patch execution and field-level conflict/previous-value details',
    ]));
  });

  it('proves the available App outbox leg: Agent head change, lost ACK, restart, and dependent replay', async () => {
    const env = await environment();
    const first = await env.mount();
    const network = env.pause();
    env.move(first, 5);
    await vi.waitFor(() => expect(env.commits()).toHaveLength(1));
    const original = structuredClone(env.commits()[0]);
    env.move(first, 7);
    await first.dispose();
    const [saved] = await env.outboxes.list(scope);
    expect(saved.intents).toHaveLength(2);

    await env.external((document) => {
      const payload = document.parent_revision.payload as Record<string, unknown>;
      const config = payload.config as Record<string, unknown>;
      const tracks = config.tracks as Array<Record<string, unknown>>;
      tracks[0].label = 'Agent edit while App ACK was in flight';
    });
    env.setFault('lost');

    const reopened = await env.mount();
    const recovering = reopened.recover(saved.ownerId);
    network.resolve();
    await recovering;

    expect(env.commits()[1]).toEqual(original);
    expect(env.commits()[2].body).toMatchObject({
      base_publication_id: 'p1',
      commands: [{ args: { on: 7 } }],
    });
    expect(env.commits()[2].key).not.toBe(original.key);
    expect(env.current().config.tracks[0]).toMatchObject({ label: 'Agent edit while App ACK was in flight' });
    const recovered = (await env.outboxes.list(scope))[0];
    expect(recovered.intents).toEqual([]);
    expect(recovered.pending).toBeUndefined();
    await reopened.dispose();
  });
});
