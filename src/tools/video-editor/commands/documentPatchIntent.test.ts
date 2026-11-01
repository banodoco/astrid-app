// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from '@/integrations/runtime/timeline-commit-types.ts';
import type { OutboxJson } from './commitOutbox.ts';
import { documentPatchIntent, type PhysicalRootBinding } from './documentPatchIntent.ts';
import fixture from './fixtures/authoringBundle.json';

type ObjectValue = { [key: string]: OutboxJson };
type Input = Parameters<typeof documentPatchIntent>[0];
const copy = <T>(value: T): T => structuredClone(value);
const document = () => copy(fixture.cases.find((entry) => entry.name === 'repeated-source')!.document) as CanonicalDocument;
const binding = (doc: CanonicalDocument): PhysicalRootBinding => ({ ref: 'parent',
  revisionId: doc.parent_revision.revision_id, contentDigest: doc.parent_revision.content_digest });
const input = (before = document()): Input => ({ before, after: copy(before), roots: [binding(before)],
  basis: { head: { revisionId: before.parent_revision.revision_id, publicationId: 'original-publication' } },
  label: 'Local edit', step: { id: 'edit-1', label: 'Local edit', intent: 'Authored change', tags: ['editor'] } });
const payload = (doc: CanonicalDocument) => doc.parent_revision.payload as ObjectValue;
const proposal = (value: Input) => documentPatchIntent(value) as ObjectValue;
const present = (value: OutboxJson) => ({ state: 'present', value });
const absent = { state: 'absent' };
const set = (path: string[], before: OutboxJson, value: OutboxJson, ref = 'parent') =>
  ({ op: 'set', ref, path, before: present(before), value });
function clips(doc: CanonicalDocument): ObjectValue[] {
  return payload(doc).clips as ObjectValue[];
}
function mirrorClips(doc: CanonicalDocument) {
  (payload(doc).config as ObjectValue).clips = copy(payload(doc).clips);
}

describe('authored closure → unsent guarded document patch intent', () => {
  it('emits disjoint leaves from real mirrored clips, retaining exact authored guards and basis', () => {
    const edit = input();
    clips(edit.after)[0].hold = 3;
    (payload(edit.after).unknown as ObjectValue).number = 2;
    mirrorClips(edit.after);
    const original = copy(edit);
    const result = proposal(edit);
    expect(result.changes).toEqual([
      set(['clips', 'id:parent-clip', 'hold'], 2, 3),
      set(['unknown', 'number'], 1.25, 2),
    ]);
    expect(result).toMatchObject({ kind: 'document-patch-intent', basis: edit.basis,
      before: edit.before, after: edit.after, roots: edit.roots, label: edit.label, step: edit.step, created: [] });
    expect(result).not.toHaveProperty('reads');
    expect(result).not.toHaveProperty('commands');
    expect(result).not.toHaveProperty('dependencies');
    expect(edit).toEqual(original);
    clips(edit.after)[0].hold = 99;
    expect((result.changes as ObjectValue[])[0].value).toBe(3);
  });

  it('retains caller reads, step reads, merge policy and predecessor basis without inferring dependencies', () => {
    const edit = input();
    edit.basis = { after: 'persisted-predecessor' };
    edit.merge = 'fields';
    edit.reads = [{ kind: 'collection', ref: 'parent', path: ['clips'], members: ['parent-clip'], order: null }];
    edit.step.reads = [{ kind: 'field', ref: 'parent', path: ['bundle'], state: present(null) }];
    payload(edit.after).bundle = { annotation: true };
    const result = proposal(edit);
    expect(result.reads).toEqual(edit.reads);
    expect(result.step).toEqual(edit.step);
    expect(result.basis).toEqual({ after: 'persisted-predecessor' });
    expect(result.merge).toBe('fields');
    edit.reads[0] = null;
    expect(result.reads).not.toEqual(edit.reads);
    const explicitEmpty = { ...edit, reads: [] };
    expect(proposal(explicitEmpty)).toHaveProperty('reads', []);
    delete explicitEmpty.reads;
    expect(proposal(explicitEmpty)).not.toHaveProperty('reads');
  });

  it('captures a new caller-allocated clip ID and a later trim against the authored predecessor', () => {
    const add = input();
    const right = { ...copy(clips(add.before)[0]), id: 'right:stable', at: 3, hold: 1 };
    clips(add.after).push(right);
    mirrorClips(add.after);
    const first = proposal(add);
    expect(first.changes).toEqual([{ op: 'list.insert', ref: 'parent', path: ['clips'], id: 'right:stable',
      before: absent, value: right, order_before: ['parent-clip'], after_id: 'parent-clip' }]);
    expect(first.created).toEqual(['parent/clip:right:stable']);
    const trim = input(copy(add.after));
    trim.basis = { after: 'saved-add-intent' };
    clips(trim.after)[1].hold = 0.5;
    mirrorClips(trim.after);
    const second = proposal(trim);
    expect(second.changes).toEqual([set(['clips', 'id:right:stable', 'hold'], 1, 0.5)]);
    expect(second.created).toEqual([]);
    expect(second.basis).toEqual({ after: 'saved-add-intent' });
    expect(second.before).toEqual(first.after);
    expect(trim.before.parent_revision).toMatchObject({ revision_id: add.before.parent_revision.revision_id,
      content_digest: add.before.parent_revision.content_digest });
  });

  it('uses the original same-field guard even when a different proposal changes that field', () => {
    const first = input();
    payload(first.before).meta = { 'org.example.notes': { note: 'A' } };
    first.after = copy(first.before);
    (payload(first.after).meta as ObjectValue)['org.example.notes'] = { note: 'B' };
    const other = copy(first);
    (payload(other.after).meta as ObjectValue)['org.example.notes'] = { note: 'C' };
    expect(proposal(first).changes).toEqual([set(['meta', 'org.example.notes', 'note'], 'A', 'B')]);
    expect(proposal(other).changes).toEqual([set(['meta', 'org.example.notes', 'note'], 'A', 'C')]);
  });

  it('guards each ordered removal/move/insertion at its sequential input, then edits surviving fields', () => {
    const edit = input();
    const a = { id: 'a', kind: 'visual' };
    const b = { id: 'b', kind: 'visual' };
    const x = { id: 'x', kind: 'visual', opaque: null };
    const c = { id: 'c', kind: 'visual' };
    (payload(edit.before).config as ObjectValue).tracks = [a, b, x];
    (payload(edit.after).config as ObjectValue).tracks = [b, c, { ...a, kind: 'audio' }];
    expect(proposal(edit).changes).toEqual([
      { op: 'list.remove', ref: 'parent', path: ['config', 'tracks'], id: 'x', before: present(x), order_before: ['a', 'b', 'x'] },
      { op: 'list.move', ref: 'parent', path: ['config', 'tracks'], id: 'b', before: present(b), order_before: ['a', 'b'], after_id: null },
      { op: 'list.insert', ref: 'parent', path: ['config', 'tracks'], id: 'c', before: absent,
        value: c, order_before: ['b', 'a'], after_id: 'b' },
      set(['config', 'tracks', 'id:a', 'kind'], 'visual', 'audio'),
    ]);
    expect(proposal(edit).created).toEqual(['parent/track:c']);
  });

  it('moves existing occurrences and addresses their fields by occurrence_id without rewriting ownership', () => {
    const edit = input();
    const rows = payload(edit.before).occurrences as ObjectValue[];
    const nextRows = payload(edit.after).occurrences as ObjectValue[];
    nextRows.reverse();
    nextRows[0].duration_ms = 9000;
    expect(proposal(edit).changes).toEqual([
      { op: 'list.move', ref: 'parent', path: ['occurrences'], id: 'occ-1', before: present(rows[1]),
        order_before: ['occ-0', 'occ-1'], after_id: null },
      set(['occurrences', 'occurrence_id:occ-1', 'duration_ms'], 10000, 9000),
    ]);
  });

  it('preserves absence, null, opaque own keys and id-less order, including id-looking object keys', () => {
    const edit = input();
    const opaque = JSON.parse('{"__proto__":{"keep":null},"constructor":false,"id:x":0,"tags":["rough","review"],"rows":[{"id":"opaque","v":1}]}');
    payload(edit.before).meta = opaque;
    edit.after = copy(edit.before);
    const next = payload(edit.after).meta as ObjectValue;
    next.reviewed = null;
    delete next.constructor;
    next['id:x'] = 1;
    next.tags = ['review', 'rough'];
    next.rows = [{ id: 'opaque', v: 2 }];
    (next.__proto__ as ObjectValue).keep = true;
    expect(proposal(edit).changes).toEqual([
      set(['meta', '__proto__', 'keep'], null, true),
      { op: 'remove', ref: 'parent', path: ['meta', 'constructor'], before: present(false) },
      set(['meta', 'id:x'], 0, 1),
      set(['meta', 'tags'], ['rough', 'review'], ['review', 'rough']),
      set(['meta', 'rows'], [{ id: 'opaque', v: 1 }], [{ id: 'opaque', v: 2 }]),
      { op: 'set', ref: 'parent', path: ['meta', 'reviewed'], before: absent, value: null },
    ]);
    const clear = input(copy(edit.after));
    delete (payload(clear.after).meta as ObjectValue).reviewed;
    expect(proposal(clear).changes).toEqual([{ op: 'remove', ref: 'parent', path: ['meta', 'reviewed'], before: present(null) }]);
  });

  it('sets a complete missing namespace instead of pretending its child ancestors exist', () => {
    const edit = input();
    payload(edit.after).meta = { 'org.example.notes': { note: null } };
    expect(proposal(edit).changes).toEqual([{ op: 'set', ref: 'parent', path: ['meta'],
      before: absent, value: { 'org.example.notes': { note: null } } }]);
  });

  it('returns no proposal for a no-op, including object key reorder', () => {
    const edit = input();
    const config = payload(edit.after).config as ObjectValue;
    payload(edit.after).config = Object.fromEntries(Object.entries(config).reverse());
    expect(documentPatchIntent(edit)).toBeNull();
  });

  it('edits one exact revision when several images share entity IDs and identical bytes', () => {
    const edit = input();
    const shot = edit.before.shot_revisions[0];
    const internal = edit.before.internal_timeline_revisions[0];
    const otherShot = { ...copy(shot), revision_id: 'shot-other', internal_timeline_revision_id: 'internal-other' };
    otherShot.payload.internal_timeline_revision_id = 'internal-other';
    const otherInternal = { ...copy(internal), revision_id: 'internal-other' };
    edit.before.shot_revisions.push(otherShot);
    edit.before.internal_timeline_revisions.push(otherInternal);
    (payload(edit.before).occurrences as ObjectValue[])[1].shot_revision_id = 'shot-other';
    const { payload: _shotPayload, ...shotPin } = otherShot;
    const { payload: _internalPayload, ...internalPin } = otherInternal;
    edit.before.dependency_manifest.shots.push(shotPin);
    edit.before.dependency_manifest.internal_timelines.push(internalPin);
    edit.after = copy(edit.before);
    edit.roots = [{ ref: 'internal-revision:internal-other', revisionId: 'internal-other', contentDigest: internal.content_digest }];
    (edit.after.internal_timeline_revisions[1].payload.clips as ObjectValue[])[0].from = 4;
    expect(proposal(edit).changes).toEqual([set(['clips', 'id:raw-child-clip', 'from'], 2, 4, 'internal-revision:internal-other')]);
    expect(proposal(edit).after).toEqual(edit.after);
    expect(() => proposal({ ...edit, roots: [{ ...edit.roots[0], ref: `internal:${internal.timeline_id}` } as PhysicalRootBinding] }))
      .toThrow('unverified physical binding');
  });

  it('can patch a shared shot payload without forking or remapping display identities', () => {
    const edit = input();
    const shot = edit.before.shot_revisions[0];
    edit.roots = [{ ref: `shot-revision:${shot.revision_id}`, revisionId: shot.revision_id, contentDigest: shot.content_digest }];
    edit.after.shot_revisions[0].payload.name = 'Shared shot note';
    expect(proposal(edit).changes).toEqual([set(['name'], 'Source shot', 'Shared shot note', `shot-revision:${shot.revision_id}`)]);
    expect(proposal(edit).created).toEqual([]);
  });

  it('does not assign parent collection semantics to an internal root extension', () => {
    const edit = input();
    const internal = edit.before.internal_timeline_revisions[0];
    internal.payload.config = { clips: [{ id: 'opaque', value: null }] };
    edit.after = copy(edit.before);
    edit.after.internal_timeline_revisions[0].payload.config = { clips: [{ id: 'opaque', value: false }] };
    edit.roots = [{ ref: `internal-revision:${internal.revision_id}`, revisionId: internal.revision_id, contentDigest: internal.content_digest }];
    expect(proposal(edit).changes).toEqual([set(['config', 'clips'], [{ id: 'opaque', value: null }],
      [{ id: 'opaque', value: false }], `internal-revision:${internal.revision_id}`)]);
  });

  it('refuses unbound roots, wrong pins, duplicate bindings and roots outside the pinned closure', () => {
    const edit = input();
    payload(edit.after).bundle = 'changed';
    expect(() => proposal({ ...edit, roots: [] })).toThrow('lacks explicit physical binding');
    expect(() => proposal({ ...edit, roots: [{ ...edit.roots[0], contentDigest: 'wrong' }] })).toThrow('unverified physical binding');
    expect(() => proposal({ ...edit, roots: [edit.roots[0], edit.roots[0]] })).toThrow('unverified physical binding');
    edit.before.dependency_manifest.shots[0].content_digest = 'wrong';
    edit.after = copy(edit.before);
    expect(() => proposal(edit)).toThrow('shot manifest mismatch');
  });

  it('refuses creation or a different authoring head instead of replacing the captured basis', () => {
    const edit = input();
    payload(edit.after).bundle = 'changed';
    expect(() => proposal({ ...edit, basis: { create: true } } as unknown as Input)).toThrow('authoring basis');
    expect(() => proposal({ ...edit, basis: { head: { revisionId: 'other-revision', publicationId: 'other-publication' } } }))
      .toThrow('authoring basis');
    expect(() => proposal({ ...edit, basis: { after: '' } })).toThrow('authoring basis');
  });

  it.each([
    ['wrapper digest', (doc: CanonicalDocument) => { doc.parent_revision.content_digest = 'invented'; }, 'wrappers'],
    ['root creation', (doc: CanonicalDocument) => { doc.shot_revisions.push(copy(doc.shot_revisions[0])); }, 'wrappers'],
    ['occurrence edge', (doc: CanonicalDocument) => { (payload(doc).occurrences as ObjectValue[])[0].shot_revision_id = 'other'; }, 'managed occurrence'],
    ['occurrence removal', (doc: CanonicalDocument) => { (payload(doc).occurrences as ObjectValue[]).pop(); }, 'managed occurrence'],
    ['occurrence ancestor', (doc: CanonicalDocument) => { payload(doc).occurrences = null; }, 'expected occurrence_id collection'],
    ['conflicting mirror', (doc: CanonicalDocument) => { clips(doc)[0].hold = 4; }, 'mirror'],
    ['config ancestor', (doc: CanonicalDocument) => { payload(doc).config = null; }, 'mirror'],
    ['duplicate ID', (doc: CanonicalDocument) => { clips(doc).push(copy(clips(doc)[0])); mirrorClips(doc); }, 'duplicate id'],
    ['missing ID', (doc: CanonicalDocument) => { delete clips(doc)[0].id; mirrorClips(doc); }, 'missing/duplicate id'],
    ['collection ancestor', (doc: CanonicalDocument) => { payload(doc).clips = null; mirrorClips(doc); }, 'collection replacement'],
    ['nonfinite JSON', (doc: CanonicalDocument) => { payload(doc).bundle = Infinity; }, 'finite JSON'],
  ])('visibly refuses %s instead of overwriting or manufacturing a semantic edit', (_name, change, message) => {
    const edit = input();
    change(edit.after);
    expect(() => proposal(edit)).toThrow(message);
  });

  it('refuses managed shot links even inside ancestor replacement, and unsupported child allocations', () => {
    const edit = input();
    const shot = edit.before.shot_revisions[0];
    const internal = edit.before.internal_timeline_revisions[0];
    edit.roots = [{ ref: `shot-revision:${shot.revision_id}`, revisionId: shot.revision_id, contentDigest: shot.content_digest }];
    edit.after.shot_revisions[0].payload = { name: 'replacement without managed edge' };
    expect(() => proposal(edit)).toThrow('managed shot internal edge');
    edit.after = copy(edit.before);
    edit.roots = [{ ref: `internal-revision:${internal.revision_id}`, revisionId: internal.revision_id, contentDigest: internal.content_digest }];
    (edit.after.internal_timeline_revisions[0].payload.clips as ObjectValue[]).push({ id: 'new-child' });
    expect(() => proposal(edit)).toThrow('allocation join');
  });
});
