import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixtureTargets, parseFixtureOptions, PROFILE_DOCUMENT_BYTES, STANDARD_MINIMUM_CLIPS,
  SYNTHETIC_DOCUMENT_BYTES_PER_CLIP} from './film-shape.mjs';

test('default document floor scales with the requested clip count and stays below the measured shape', () => {
  const standard = fixtureTargets(616, {});
  assert.equal(standard.documentBytes, 616 * SYNTHETIC_DOCUMENT_BYTES_PER_CLIP);
  // Plan 87 and the qualifier measured 580,654 and 575,879 bytes for 616 generated clips.
  assert.ok(standard.documentBytes < 575_879);
  assert.equal(standard.commitRatio, 15);
  assert.equal(standard.profileDocumentBytes, PROFILE_DOCUMENT_BYTES);
  assert.match(standard.documentBytesSource, /default synthetic floor/);
  assert.equal(fixtureTargets(300, {}).documentBytes, 300 * SYNTHETIC_DOCUMENT_BYTES_PER_CLIP);
});

test('document and ratio targets remain overridable and reject malformed values', () => {
  const custom = fixtureTargets(300, {SAVE_LOOP_DOCUMENT_BYTES: '900000', SAVE_LOOP_COMMIT_RATIO: '10'});
  assert.equal(custom.documentBytes, 900_000);
  assert.equal(custom.documentBytesSource, 'SAVE_LOOP_DOCUMENT_BYTES');
  assert.equal(custom.commitRatio, 10);
  assert.equal(fixtureTargets(616, {SAVE_LOOP_DOCUMENT_BYTES: ''}).documentBytes, 616 * SYNTHETIC_DOCUMENT_BYTES_PER_CLIP);
  assert.equal(fixtureTargets(616, {SAVE_LOOP_DOCUMENT_BYTES: String(PROFILE_DOCUMENT_BYTES)}).documentBytes, 2_600_000);
  for (const value of ['abc', '0', '-1']) assert.throws(() => fixtureTargets(616, {SAVE_LOOP_DOCUMENT_BYTES: value}));
  assert.throws(() => fixtureTargets(616, {SAVE_LOOP_COMMIT_RATIO: 'x'}));
});

test('standard and large-shots builds accept the 300-clip recipe but not fewer than the sweep needs', () => {
  assert.equal(parseFixtureOptions([], {SAVE_LOOP_CLIPS: '300'}).clipCount, 300);
  assert.equal(parseFixtureOptions(['--variant', 'large-shots', '--clips', '300']).clipCount, 300);
  assert.equal(parseFixtureOptions([]).clipCount, 616);
  assert.equal(parseFixtureOptions([], {SAVE_LOOP_CLIPS: String(STANDARD_MINIMUM_CLIPS)}).clipCount, STANDARD_MINIMUM_CLIPS);
  // Ten video and ten audio sweep targets: 6% of the clips are video.
  assert.ok(Math.round(STANDARD_MINIMUM_CLIPS * 0.06) >= 10);
  assert.throws(() => parseFixtureOptions([], {SAVE_LOOP_CLIPS: String(STANDARD_MINIMUM_CLIPS - 1)}), /minimum/);
});

test('large-shots child media is staged like t.add: Runtime-verified and captured', () => {
  const source = fs.readFileSync(new URL('./build-fixture.mjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('def stage_child_media('), source.indexOf('def populate('));
  assert.match(helper, /from astrid\.sdk\.timeline\.media_add import _selection/);
  assert.match(helper, /_selection\(t\.session, t\.bundle, pin\)/);
  assert.match(helper, /'op': 'occurrence\.add-media'/);
  assert.match(helper, /verified_media=verified_media, capture=True/);
  // A raw t.command() starts from the fresh commit session's empty verified media.
  assert.doesNotMatch(source, /t\.command\(\{'schema_version': 1, 'op': 'occurrence\.add-media'/);
  assert.match(source, /stage_child_media\(t, owner, row, pin, kind\)/);
});
