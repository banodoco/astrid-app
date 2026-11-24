import test from 'node:test';
import assert from 'node:assert/strict';
import {filmFixtureShape, filmShape, filmMediaDurations, parseFixtureOptions} from './film-shape.mjs';
import {prepareFilmImport, planFilmImport} from './film-import.mjs';

const pin = (asset, digit) => ({asset, generation_id: `g-${asset}`, variant_id: `v-${asset}`, object_id: `sha256:${digit.repeat(64)}`});
const video = pin('video', '1'), image = pin('image', '2'), audio = pin('audio', '3');
const content = {schema: 'media.transcript/v1', media_id: audio.object_id, source_id: 'film-line', text: 'repeat repeat w0001 w0002'};
const prepare = (count, contentExtent) => {
  const shape = filmFixtureShape(count, {contentExtent});
  const prepared = prepareFilmImport({projectId: 'project', timelineId: 'film', shape, selections: [video],
    legacyWord: {documentId: 'transcript', content, text: 'w0001', at: 0.1},
    narration: {selection: audio, image, words: [{text: 'w0001', at: 0.1}, {text: 'w0002', at: 1.1},
      {text: 'repeat', at: 0.01}, {text: 'repeat', at: 0.05}], splitAt: {gapStart: 0.2, gapEnd: 0.7},
      ...(shape.narrationTranscriptEnd ? {end: 1.2} : {})}});
  return {shape, prepared, plan: planFilmImport(prepared)};
};
const shotRows = (prepared, index) => prepared.publication.internal_timeline_revisions[index].payload.clips;

test('default shape and short shot-2 children are unchanged without --content-extent', () => {
  assert.deepEqual(filmFixtureShape(23), {...filmShape({ripple: true, clipCount: 21, shotCount: 2}), narrationTranscriptEnd: true});
  assert.equal('contentExtent' in filmFixtureShape(23), false);
  assert.deepEqual(filmFixtureShape(23), filmFixtureShape(23, {contentExtent: false}));
  const {prepared, plan} = prepare(23, false);
  const rows = shotRows(prepared, 1);
  assert.deepEqual([0, 1, 2, 3].map(i => rows.find(row => row.id === `footage-1-${i}`).hold), [0.1, 0.1, 0.1, 0.1]);
  assert.equal(plan.occurrence_extent_seconds, 195.967);
  assert.ok(plan.content_extent_seconds < 30, `default content extent is short: ${plan.content_extent_seconds}`);
  assert.deepEqual([plan.shots, plan.child_clips, plan.parent_clips], [2, 18, 5]);
});

test('--content-extent parses only for film-shaped and is off by default', () => {
  assert.equal(parseFixtureOptions(['--variant', 'film-shaped']).contentExtent, undefined);
  assert.equal(parseFixtureOptions(['--variant', 'film-shaped', '--content-extent']).contentExtent, true);
  assert.throws(() => parseFixtureOptions(['--content-extent']), /requires --variant film-shaped/);
  assert.throws(() => parseFixtureOptions(['--variant', 'film-shaped', '--content-extent', '--content-extent']), /duplicate/);
});

test('--content-extent runs the content to the occurrence extent with the same counts and unique anchors', () => {
  const base = prepare(23, false), extended = prepare(23, true);
  assert.ok(Math.abs(extended.plan.content_extent_seconds - extended.plan.occurrence_extent_seconds) < 0.002, JSON.stringify(extended.plan));
  assert.equal(extended.plan.occurrence_extent_seconds, base.plan.occurrence_extent_seconds);
  for (const key of ['shots', 'child_clips', 'parent_clips']) assert.equal(extended.plan[key], base.plan[key]);
  const rows = shotRows(extended.prepared, 1), duration = extended.prepared.publication.parent_composition.occurrences[1].duration_ms / 1000;
  for (let i = 0; i < 4; i++) {
    const row = rows.find(r => r.id === `footage-1-${i}`);
    assert.ok(Math.abs(row.at + row.hold - duration) < 0.001 && row.at + row.hold <= duration + 1e-9);
    assert.equal(row.to, row.hold);
    if (row.app) assert.equal(row.app.astrid.for, row.hold);
  }
  const anchors = rows.filter(r => r.app?.astrid?.on).map(r => r.app.astrid.on);
  assert.deepEqual(anchors, shotRows(base.prepared, 1).filter(r => r.app?.astrid?.on).map(r => r.app.astrid.on));
  assert.equal(new Set(anchors).size, anchors.length);
});

test('--content-extent narration covers the clip extent and the sources are long enough', () => {
  const {shape, prepared} = prepare(23, true);
  const rows = shotRows(prepared, 1), duration = prepared.publication.parent_composition.occurrences[1].duration_ms / 1000;
  const later = rows.find(row => row.id === 'narration-later');
  const clipEnd = Math.max(...rows.filter(r => r.clipType === 'media').map(r => r.at + r.hold));
  assert.ok(later.at + later.hold <= duration);
  assert.ok(clipEnd - (later.at + later.hold) <= 2 / 30 + 1e-9, 'narration reaches within two frames of the clip extent');
  // The builder's generic transcript path appends an 'ending' word at the narration end (#387 rules).
  assert.equal(shape.narrationTranscriptEnd, undefined);
  const {audioDuration, videoDuration} = filmMediaDurations(shape);
  assert.ok(audioDuration >= duration && videoDuration >= duration);
  assert.deepEqual(filmMediaDurations(filmFixtureShape(23)), {audioDuration, videoDuration});
});

test('config.bundle rows carry both editor and Agent identities', () => {
  const row = prepare(23, false).prepared.publication.parent_composition.config.bundle.transcriptReferences.associations[0];
  assert.deepEqual(row, {assetId: 'audio', documentId: 'transcript', mediaId: audio.object_id, sourceId: 'film-line'});
});
