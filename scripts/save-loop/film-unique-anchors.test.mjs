import test from 'node:test';
import assert from 'node:assert/strict';
import {filmFixtureShape, parseFixtureOptions} from './film-shape.mjs';
import {prepareFilmImport} from './film-import.mjs';

test('ambiguous anchor omission is an explicit film-only option', () => {
  assert.equal(parseFixtureOptions(['--variant', 'film-shaped']).omitAmbiguousAnchors, undefined);
  assert.equal(parseFixtureOptions(['--variant', 'film-shaped', '--omit-ambiguous-anchors']).omitAmbiguousAnchors, true);
  assert.throws(() => parseFixtureOptions(['--omit-ambiguous-anchors']), /film-shaped/);
  assert.throws(() => parseFixtureOptions(['--variant', 'film-shaped', '--omit-ambiguous-anchors', '--omit-ambiguous-anchors']), /duplicate/);
});

test('opt-in removes only repeat declarations while preserving film structure', () => {
  const pin = (asset, digit) => ({asset, generation_id: `g-${asset}`, variant_id: `v-${asset}`, object_id: `sha256:${digit.repeat(64)}`});
  const video = pin('video', '1'), image = pin('image', '2'), audio = pin('audio', '3');
  const content = {schema: 'media.transcript/v1', media_id: audio.object_id, source_id: 'film-line',
    text: 'repeat repeat w0001 w0002'};
  const options = {projectId: 'project', timelineId: 'film', shape: filmFixtureShape(42), selections: [video],
    legacyWord: {documentId: 'transcript', content, text: 'w0001', at: 0.1},
    narration: {selection: audio, image, words: [{text: 'w0001', at: 0.1}, {text: 'w0002', at: 1.1},
      {text: 'repeat', at: 0.01}, {text: 'repeat', at: 0.05}], splitAt: {gapStart: 0.3, gapEnd: 0.9}}};
  const normal = prepareFilmImport(options);
  const unique = prepareFilmImport({...options, omitAmbiguousAnchors: true});
  assert.deepEqual(normal.transcripts, unique.transcripts);
  assert.deepEqual(normal.publication.parent_composition, unique.publication.parent_composition);
  assert.deepEqual(normal.publication.dependency_manifest.media, unique.publication.dependency_manifest.media);
  const normalRows = normal.publication.internal_timeline_revisions.flatMap(r => r.payload.clips);
  const uniqueRows = unique.publication.internal_timeline_revisions.flatMap(r => r.payload.clips);
  assert.equal(normalRows.length + normal.publication.parent_composition.clips.length, 42);
  assert.equal(uniqueRows.length, normalRows.length);
  assert.deepEqual(normalRows.filter(row => row.app?.astrid?.on === '"repeat"').map(row => row.id), ['footage-0-2', 'footage-0-3']);
  assert.equal(uniqueRows.filter(row => row.app?.astrid?.on === '"repeat"').length, 0);
  assert.deepEqual(uniqueRows.filter(row => row.app?.astrid?.on).map(row => row.app.astrid.on), ['"w0001"', '"w0002"']);
  for (const row of normalRows) if (['footage-0-2', 'footage-0-3'].includes(row.id)) delete row.app;
  assert.deepEqual(uniqueRows, normalRows);
});
