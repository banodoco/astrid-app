// Source control for the finite three-products placement fixture; no browser or Runtime execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const harnessPath = new URL('./harness.ts', import.meta.url);
const harness = readFileSync(harnessPath, 'utf8');
const placementSpec = readFileSync(new URL('../three-products.p2-elements-assets.spec.ts', import.meta.url), 'utf8');

function callerSources() {
  return execFileSync('git', ['ls-files', 'tests', 'src', 'scripts'], { encoding: 'utf8' })
    .trim().split('\n').filter((file) => /\.(?:mjs|ts|tsx)$/.test(file))
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .flatMap(({ file, source }) => [...source.matchAll(/seedThreeProducts\s*\(([^)]*)\)/g)].map((match) => ({ file, args: match[1] ?? '' })))
    .filter(({ file, args }) => !(file.endsWith('/support/harness.ts') && args.includes('THREE_PRODUCTS_REFERENCE_AT')));
}

test('the actual seed derives occurrence, full plate, and expected occurrence from one host window', () => {
  assert.match(harness, /async seedThreeProducts\(referenceAt = THREE_PRODUCTS_REFERENCE_AT, transitions: '[^']+' \| '[^']+' \| '[^']+' = '[^']+', occurrenceHostWindow = 12\)/);
  assert.match(harness, /occurrence_host_window: occurrenceHostWindow/);
  assert.match(harness, /capture_occurrence_create\([^\n]+duration=case\['occurrence_host_window'\]/);
  assert.equal((harness.match(/'hold': case\['occurrence_host_window'\]/g) ?? []).length, 2);
  assert.match(harness, /'duration_ms': case\['occurrence_host_window'\] \* 1000/);
  assert.match(harness, /parent_registry\['f2-video'\]\['duration'\] = 12/);
});

test('the 17 non-placement callers keep the omitted 12 default', () => {
  const callers = callerSources();
  assert.equal(callers.length, 18);
  assert.deepEqual(callers.filter(({ args }) => args.includes(', 14')).map(({ file }) => file), [
    'tests/e2e/local/three-products.p2-elements-assets.spec.ts',
  ]);
  assert.match(placementSpec, /const test = appTest\.extend<[\s\S]+?seedThreeProducts\(THREE_PRODUCTS_REFERENCE_AT, 'native-none'\)\);/);
  assert.match(placementSpec, /const placementTest = appTest\.extend<[\s\S]+?seedThreeProducts\(THREE_PRODUCTS_REFERENCE_AT, 'native-none', 14\)\);/);
  assert.match(placementSpec, /test\('P2 mounted element edit:[^\n]+async \(\{ page, harness, seed3 \}\)/);
  assert.match(placementSpec, /test\('P2 mounted registerAsset save:[^\n]+async \(\{ page, harness, seed3 \}\)/);
  assert.match(placementSpec, /placementTest\('P2 mounted automatic child placement:[^\n]+async \(\{ page, harness, seed3 \}\)/);
  assert.equal(callers.filter(({ args }) => !args.includes(', 14')).length, 17);
  assert.equal(callers.filter(({ args }) => args.includes(', 14')).length, 1);
});
