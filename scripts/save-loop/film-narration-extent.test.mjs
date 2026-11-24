import test from 'node:test';
import assert from 'node:assert/strict';
import {filmFixtureShape} from './film-shape.mjs';
import {prepareFilmImport} from './film-import.mjs';

const pin = (asset, digit) => ({asset, generation_id: `g-${asset}`, variant_id: `v-${asset}`, object_id: `sha256:${digit.repeat(64)}`});
const video = pin('video', '1'), image = pin('image', '2'), audio = pin('audio', '3');
const content = {schema: 'media.transcript/v1', media_id: audio.object_id, source_id: 'film-line', text: 'repeat repeat w0001 w0002'};
const options = count => ({projectId: 'project', timelineId: 'film', shape: filmFixtureShape(count), selections: [video],
  legacyWord: {documentId: 'transcript', content, text: 'w0001', at: 0.1},
  narration: {selection: audio, image, words: [{text: 'w0001', at: 0.1}, {text: 'w0002', at: 1.1},
    {text: 'repeat', at: 0.01}, {text: 'repeat', at: 0.05}], splitAt: {gapStart: 0.2, gapEnd: 0.7}, end: 1.2}});

test('split narration ends at the transcript extent for both film sizes', () => {
  for (const count of [23, 621]) {
    const prepared = prepareFilmImport(options(count));
    const rows = prepared.publication.internal_timeline_revisions.flatMap(row => row.payload.clips);
    const earlier = rows.find(row => row.id === 'narration');
    const later = rows.find(row => row.id === 'narration-later');
    assert.equal(earlier.to, 0.2);
    assert.equal(later.from, 0.7);
    assert.equal(later.to, 1.2);
    assert.equal(later.at + later.hold, 1.2);
    assert.equal(rows.length + prepared.publication.parent_composition.clips.length, count);
    assert.deepEqual(rows.filter(row => row.app?.astrid?.on).map(row => row.app.astrid.on),
      ['"repeat"', '"repeat"', '"w0001"', '"w0002"']);
  }
});

test('split narration rejects an end outside its shot or cut', () => {
  for (const end of [0.7, 0, Infinity, 1000]) {
    const input = options(621);
    input.narration.end = end;
    assert.throws(() => prepareFilmImport(input), /invalid narration end/);
  }
});
