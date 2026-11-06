import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = JSON.parse(readFileSync(path.join(root, 'src/pages/Home/vision.generated.json'), 'utf8'));
const gapIds = new Set(page.gaps.map(gap => gap.id));
const pillarIds = new Set(page.pillars.map(p => 'pillar:' + p.id));
const principleIds = new Set(page.principles.map(p => 'principle:' + p.id));

test('the public page has a pinned, single-source revision', () => {
  assert.match(page.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(page.source.repository, 'banodoco/astrid-dev');
  assert.ok(page.vision.title.length > 10);
  assert.ok(page.vision.introMarkdown.length > 20);
});

test('four distinct pillars and three operating principles come from the snapshot', () => {
  assert.equal(page.pillars.length, 4);
  assert.equal(page.principles.length, 3);
  assert.equal(pillarIds.size, 4);
  assert.equal(principleIds.size, 3);
  for (const item of [...page.pillars, ...page.principles]) {
    assert.ok(item.title);
    assert.ok(item.bodyMarkdown);
  }
  for (const pillar of page.pillars) assert.ok(pillar.descriptor);
});

test('gaps are complete, unique and link back to source', () => {
  assert.equal(page.gaps.length, gapIds.size);
  for (const gap of page.gaps) {
    assert.match(gap.id, /^[A-Z]{1,3}-\d{3}$/);
    assert.ok(gap.desiredMarkdown && gap.currentMarkdown && gap.missingMarkdown);
    assert.ok(['open', 'closed', 'partially evidenced', 'needs recheck'].includes(gap.assessment));
    assert.ok(gap.appliesTo.length);
    for (const ref of gap.appliesTo) assert.ok(pillarIds.has(ref) || principleIds.has(ref), ref);
    assert.ok(gap.githubUrl.includes('/blob/' + page.source.revision + '/visions/gaps/'));
  }
});

test('all projects have source links, canonical priority and valid gap IDs', () => {
  assert.ok(page.projects.length > 0);
  const ids = new Set();
  for (const [index, project] of page.projects.entries()) {
    assert.ok(!ids.has(project.id), 'duplicate project ' + project.id);
    ids.add(project.id);
    assert.equal(project.priorityOrder, index + 1);
    assert.ok(project.title && project.goalMarkdown);
    assert.ok(['active', 'queued', 'blocked', 'paused', 'done', 'cancelled'].includes(project.status));
    assert.ok(project.githubUrl.includes('/blob/' + page.source.revision + '/plans/' + project.id + '/plan.md'));
    for (const gapId of project.gapIds) assert.ok(gapIds.has(gapId), gapId);
  }
});

test('the open projects list is not a list of completed work', () => {
  const open = page.projects.filter(project => !['done', 'cancelled'].includes(project.status));
  assert.ok(open.length >= 12);
  assert.equal(open[0].status, 'active');
  assert.ok(open.every(project => project.status !== 'done' && project.status !== 'cancelled'));
});
