// Pure controls for the mounted P2 transition request assertion; no browser or Runtime execution.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { expect } from '@playwright/test';
import ts from 'typescript';

const source = readFileSync(new URL('../three-products.p2-tour.spec.ts', import.meta.url), 'utf8');
const helper = source.match(/^function assertTransitionRequestV2\([^]*?^}/m)?.[0];
assert.ok(helper, 'exercise the actual mounted transition assertion helper');
const check = compileFunction(`${ts.transpileModule(helper, {}).outputText}\nreturn assertTransitionRequestV2;`, ['expect'])(expect);

const original = {
  project_id: 'project',
  timeline_id: 'timeline',
  parent_revision: {
    payload: {
      config: {
        clips: [
          { id: 'alpha', transition: { type: 'crossfade', duration: 0.5, opaque: null } },
          { id: 'beta' },
        ],
      },
    },
  },
};

function fixture(ids) {
  const changes = ids.map((id) => ({
    op: 'remove', ref: 'parent', path: ['clips', `id:${id}`, 'transition'],
    before: Object.hasOwn(original.parent_revision.payload.config.clips.find((clip) => clip.id === id), 'transition')
      ? { state: 'present', value: original.parent_revision.payload.config.clips.find((clip) => clip.id === id).transition }
      : { state: 'absent' },
  }));
  const reads = ids.flatMap((id) => {
    const clip = original.parent_revision.payload.config.clips.find((row) => row.id === id);
    return ['id', 'transition'].map((key) => ({
      kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${id}`, key],
      state: Object.hasOwn(clip, key) ? { state: 'present', value: clip[key] } : { state: 'absent' },
    }));
  });
  reads.push({ kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'], state: { state: 'absent' } });
  const body = {
    api_version: 1, project_id: 'project', timeline_id: 'timeline',
    base_revision_id: 'revision', base_publication_id: 'publication',
    commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes } }],
    label: 'Edit timeline',
    steps: [{ id: '00000000-0000-4000-8000-000000000001', label: 'Edit timeline', intent: `Clear transitions: ${ids.join(', ')}`, tags: [], command_ordinals: [0], patch: changes, reads }],
    merge: 'fields', reads, dry_run: false, source: { via: 'app' },
  };
  return { post: { key: 'receipt', body }, changes, ids };
}

test('actual helper accepts the exact single and bulk transition request shapes', () => {
  for (const ids of [['alpha'], ['alpha', 'beta']]) {
    const { post, changes } = fixture(ids);
    check(post, { revision_id: 'revision', publication_id: 'publication' }, original, ids, changes);
  }
});

test('actual helper refuses the old atomic/no-read/generic-intent shape', () => {
  const { post, changes, ids } = fixture(['alpha']);
  const legacy = structuredClone(post);
  legacy.body.merge = 'atomic';
  delete legacy.body.reads;
  delete legacy.body.commands[0].created;
  delete legacy.body.steps[0].reads;
  legacy.body.steps[0].intent = 'Save local editor changes';
  assert.throws(() => check(legacy, { revision_id: 'revision', publication_id: 'publication' }, original, ids, changes));
});

test('actual helper refuses missing/extra/wrong command, created, read, merge, and submitted patch variants', () => {
  const { post, changes, ids } = fixture(['alpha']);
  const variants = [
    (candidate) => { delete candidate.body.commands[0].created; },
    (candidate) => { candidate.body.commands[0].created = ['parent/clip:unexpected']; },
    (candidate) => { candidate.body.reads = [...candidate.body.reads, { kind: 'scope', ref: 'timeline', path: [] }]; },
    (candidate) => { candidate.body.steps[0].reads = candidate.body.reads.slice(0, -1); },
    (candidate) => { candidate.body.merge = 'atomic'; },
    (candidate) => { candidate.body.label = 'Wrong label'; },
    (candidate) => { candidate.body.unexpected = true; },
    (candidate) => { candidate.body.commands[0].op = 'clip.set'; },
    (candidate) => { candidate.body.steps[0].patch = []; },
    (candidate) => { candidate.body.commands[0].args.changes = []; },
    (candidate) => { candidate.body.reads[0].path = ['config', 'clips', 'id:alpha', 'asset']; },
    (candidate) => { candidate.body.reads[1].state = { state: 'absent' }; },
    (candidate) => { candidate.body.reads[1].state.value.duration = 99; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(post);
    mutate(candidate);
    assert.throws(() => check(candidate, { revision_id: 'revision', publication_id: 'publication' }, original, ids, changes));
  }
});
