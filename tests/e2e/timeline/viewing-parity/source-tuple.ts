import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

export const PEER_FILES = [
  'node_modules/remotion/dist/cjs/audio/shared-audio-tags.js',
  'node_modules/remotion/dist/esm/index.mjs',
  'node_modules/@remotion/player/dist/cjs/use-player-methods.js',
  'node_modules/@remotion/player/dist/esm/index.mjs',
  'node_modules/@remotion/player/dist/cjs/use-playback.js',
  'node_modules/@remotion/player/dist/cjs/PlayerUI.js',
] as const;

export interface SourcePin { root: string; commit: string; tree: string }
export interface FrameSourceTuple {
  schema: 'timeline.viewing.next-five-case/v1';
  frozen: true;
  sources: Record<'app' | 'agent' | 'runtime' | 'composition', SourcePin>;
  appSource: { files: number; sha256: string };
  remotionProject: string;
  peers: Record<'app' | 'agent', Record<string, string>>;
  client: {
    official: true;
    producerCommit: string;
    producerTree: string;
    producerVersion: string;
    artifactCount: number;
    files: Record<string, string>;
  };
}

/** Release owners supply pins; never derive expected hashes from a selected install. */
export function assertFrameSourceTuple(value: unknown): asserts value is FrameSourceTuple {
  const tuple = value as FrameSourceTuple | undefined;
  assert.equal(tuple?.schema, 'timeline.viewing.next-five-case/v1', 'final source tuple is owner-pending');
  assert.equal(tuple.frozen, true, 'manager source freeze is pending');
  for (const name of ['app', 'agent', 'runtime', 'composition'] as const) {
    const source = tuple.sources?.[name];
    assert.ok(source && typeof source.root === 'string' && isAbsolute(source.root), `${name} source root pending`);
    assert.match(source.commit, /^[a-f0-9]{40}$/, `${name} actual commit pending`);
    assert.match(source.tree, /^[a-f0-9]{40}$/, `${name} actual tree pending`);
  }
  assert.ok(Number.isSafeInteger(tuple.appSource?.files) && tuple.appSource.files > 0, 'App content freeze pending');
  assert.match(tuple.appSource.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(typeof tuple.remotionProject === 'string' && isAbsolute(tuple.remotionProject));
  for (const consumer of ['app', 'agent'] as const) {
    const files: Record<string, string> | undefined = tuple.peers?.[consumer];
    assert.deepEqual(Object.keys(files ?? {}).sort(), [...PEER_FILES].sort(), `${consumer} six-file peer pins pending`);
    for (const hash of Object.values(files ?? {})) assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(tuple.client?.official, true, 'official generated client is pending');
  assert.match(tuple.client.producerCommit, /^[a-f0-9]{40}$/, 'official artifact producer source pending');
  assert.match(tuple.client.producerTree, /^[a-f0-9]{40}$/, 'official artifact producer tree pending');
  assert.match(tuple.client.producerVersion, /^sha256:[a-f0-9]{64}$/, 'official artifact version pending');
  assert.ok(Number.isSafeInteger(tuple.client.artifactCount) && tuple.client.artifactCount > 0,
    'official artifact count pending');
  assert.ok(Object.hasOwn(tuple.client.files ?? {}, 'src/integrations/runtime/generated.ts'), 'official generated client byte pin pending');
  for (const [path, hash] of Object.entries(tuple.client.files)) {
    assert.ok(path && !path.startsWith('/') && !path.split('/').includes('..'), 'unsafe client pin path');
    assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  }
}
