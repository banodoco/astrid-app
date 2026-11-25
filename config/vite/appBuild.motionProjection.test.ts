import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
