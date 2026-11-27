import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveEditorPackRevisions } from './appBuild';

it('keeps motion upstream provenance and adds a separately verified tree identity', () => {
  const vendor = mkdtempSync(path.join(tmpdir(), 'motion-editor-build-'));
  const motionRoot = 'astrid/packs/astrid_motion';
  const commit = 'a'.repeat(40);
  const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const motion = { 'pack.yaml': 'manifest\n', 'rendering/elements/effects/am-type/component.tsx': 'component\n' };
  const files = { 'astrid/packs/video_editing/pack.yaml': 'legacy' };
  const entries: Record<string, string> = { ...files };
  try {
    mkdirSync(path.join(vendor, 'astrid/tools'), { recursive: true });
    writeFileSync(path.join(vendor, 'astrid/tools/catalog.json'), JSON.stringify({
      tools: [{ id: 'video-editor', pack_id: 'video_editing', entry: { host_entry: 'video-editor' }, manifest: { path: 'pack.yaml' } }],
    }));
    const digest = sha(Object.entries(motion).sort(([a], [b]) => a.localeCompare(b))
      .map(([relative, bytes]) => relative + '\0' + sha(bytes) + '\n').join(''));
    for (const [relative, bytes] of Object.entries(motion)) {
      const name = motionRoot + '/' + relative;
      mkdirSync(path.dirname(path.join(vendor, name)), { recursive: true });
      writeFileSync(path.join(vendor, name), bytes);
      entries[name] = sha(bytes);
    }
    const provenance = {
      astrid_commit: commit, files: entries,
      motion_projection: {
        schema: 'astrid-motion-projection/v1', pack_id: 'astrid_motion',
        repo: 'https://github.com/banodoco/astrid-agent', upstream_subpath: motionRoot,
        upstream_commit: commit, upstream_tree: 'b'.repeat(40), digest_rule: 'pack-tree-v1',
        upstream_digest: 'c'.repeat(64), alias_only_digest: 'd'.repeat(64), tree_digest: digest, file_count: 2,
      },
    };
    writeFileSync(path.join(vendor, 'provenance.json'), JSON.stringify(provenance));
    expect(resolveEditorPackRevisions(vendor, vendor)).toMatchObject({
      astrid_motion: commit, astrid_motion_tree: digest, video_editing: commit,
    });
    writeFileSync(path.join(vendor, motionRoot, 'pack.yaml'), 'tampered\n');
    expect(resolveEditorPackRevisions(vendor, vendor)).toBeNull();
  } finally {
    rmSync(vendor, { recursive: true, force: true });
  }
});

it('resolves the complete generated direct source with distinct motion and unrelated pack origins', () => {
  const vendor = path.resolve('vendor/astrid-browser');
  const provenance = JSON.parse(readFileSync(path.join(vendor, 'provenance.json'), 'utf8'));
  expect(provenance.motion_projection.schema).toBe('astrid-motion-release-source/v1');
  expect(provenance.motion_projection.upstream_commit).not.toBe(provenance.astrid_commit);
  const resolved = resolveEditorPackRevisions(vendor, vendor);
  expect(resolved).not.toBeNull();
  expect(resolved?.astrid_motion).toBe(provenance.motion_projection.upstream_commit);
  expect(resolved?.astrid_motion_tree).toBe(provenance.motion_projection.tree_digest);
  expect(resolved?.video_editing).toBe(provenance.astrid_commit);
  for (const [id, revision] of Object.entries(resolved ?? {})) {
    if (id !== 'astrid_motion' && id !== 'astrid_motion_tree') expect(revision).toBe(provenance.astrid_commit);
  }
  expect(resolveEditorPackRevisions(path.resolve('.'), vendor)).toBeNull();
});

it('refuses direct component, helper, descriptor, contract, witness and source-commit tampering', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'motion-editor-direct-'));
  const vendor = path.join(temporary, 'vendor');
  cpSync(path.resolve('vendor/astrid-browser'), vendor, { recursive: true });
  const provenancePath = path.join(vendor, 'provenance.json');
  const originalProvenance = readFileSync(provenancePath);
  try {
    expect(resolveEditorPackRevisions(vendor, vendor)).not.toBeNull();
    for (const relative of [
      'astrid/packs/astrid_motion/rendering/elements/effects/am-sprite/component.tsx',
      'astrid/packs/astrid_motion/rendering/elements/_shared/am.tsx',
      'astrid/packs/astrid_motion/rendering/elements/effects/am-type/element.yaml',
      'astrid/packs/rendering/shared/element_contracts.ts',
      'astrid/resources/astrid_motion_release_source.json',
    ]) {
      const file = path.join(vendor, relative), bytes = readFileSync(file);
      writeFileSync(file, Buffer.concat([bytes, Buffer.from('\nchanged\n')]));
      expect(resolveEditorPackRevisions(vendor, vendor), relative).toBeNull();
      writeFileSync(file, bytes);
    }
    const changed = JSON.parse(originalProvenance.toString());
    changed.motion_projection.upstream_commit = '0'.repeat(40);
    writeFileSync(provenancePath, JSON.stringify(changed));
    expect(resolveEditorPackRevisions(vendor, vendor)).toBeNull();
    writeFileSync(provenancePath, originalProvenance);
    expect(resolveEditorPackRevisions(vendor, vendor)).not.toBeNull();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
