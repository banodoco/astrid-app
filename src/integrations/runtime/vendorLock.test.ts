import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = 'scripts/vendor-lock.mjs';
const LOCKS = ['runtime.lock.json', 'config/astrid-cli-surface/vendor.lock.json'];
const hash = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

type VendorLock = {
  files: Record<string, { from: string; sha256: string }>;
  manifest: string;
  producer: string;
  producer_version: string;
  source_commit: string;
};
type Fixture = { base: string; consumer: string; producer: string; lockFile: string; lock: VendorLock; commit: string };

function fixture(options: { manifestHashMatches?: boolean; twoArtifacts?: boolean; d39Responses?: boolean } = {}): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'vendor-lock-'));
  const consumer = path.join(base, 'consumer');
  const producer = path.join(base, 'producer');
  mkdirSync(path.join(consumer, 'scripts'), { recursive: true });
  mkdirSync(producer, { recursive: true });
  cpSync(path.join(ROOT, SCRIPT), path.join(consumer, SCRIPT));
  const first = Buffer.from('committed artifact A\n');
  const second = Buffer.from('committed artifact B\n');
  writeFileSync(path.join(producer, 'a.txt'), first);
  if (options.twoArtifacts) writeFileSync(path.join(producer, 'b.txt'), second);
  const artifacts: Record<string, string> = { 'a.txt': hash(first) };
  if (options.d39Responses) {
    mkdirSync(path.join(producer, 'conformance/responses'), { recursive: true });
    for (const [name, status] of [['commit_conflict_409', 409], ['retired_route_410', 410]] as const) {
      const file = `conformance/responses/${name}.json`;
      const bytes = JSON.stringify({ case: name, status });
      writeFileSync(path.join(producer, file), bytes);
      artifacts[file] = hash(bytes);
    }
  }
  if (options.twoArtifacts) artifacts['b.txt'] = options.manifestHashMatches === false ? hash('incorrect') : hash(second);
  const manifest = { producer: 'test-producer', version: hash('version one'), artifacts };
  writeFileSync(path.join(producer, 'artifacts.json'), `${JSON.stringify(manifest)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: producer });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: producer });
  execFileSync('git', ['config', 'user.name', 'Vendor Lock Test'], { cwd: producer });
  execFileSync('git', ['add', '.'], { cwd: producer });
  execFileSync('git', ['commit', '-qm', 'producer fixture'], { cwd: producer });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: producer, encoding: 'utf8' }).trim();

  const files: Record<string, { from: string; sha256: string }> = { 'consumer/a.txt': { from: 'a.txt', sha256: hash(first) } };
  if (options.twoArtifacts) files['consumer/b.txt'] = { from: 'b.txt', sha256: hash(second) };
  const lock = { files, manifest: 'artifacts.json', producer: 'test-producer', producer_version: manifest.version, source_commit: commit };
  mkdirSync(path.join(consumer, 'consumer'), { recursive: true });
  writeFileSync(path.join(consumer, 'consumer/a.txt'), first);
  if (options.twoArtifacts) writeFileSync(path.join(consumer, 'consumer/b.txt'), second);
  const lockFile = path.join(consumer, 'runtime.lock.json');
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  return { base, consumer, producer, lockFile, lock, commit };
}

function run(f: Fixture, command: 'check' | 'update', withProducer = true): { status: number; output: string } {
  const args = [path.join(f.consumer, SCRIPT), command, f.lockFile];
  if (withProducer) args.push('--producer', f.producer);
  try { return { status: 0, output: execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (error) {
    const failed = error as { status: number; stderr: Buffer | string };
    return { status: failed.status, output: failed.stderr.toString() };
  }
}

function runWithoutProducerArgument(f: Fixture): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync('node', [path.join(f.consumer, SCRIPT), 'update', f.lockFile, '--producer'], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const failed = error as { status: number; stderr: Buffer | string };
    return { status: failed.status, output: failed.stderr.toString() };
  }
}

function clean(f: Fixture) { rmSync(f.base, { recursive: true, force: true }); }

describe('runtime.lock.json', () => {
  it('consolidates generated types, timeline schema, and every response fixture under the Runtime pin', () => {
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'runtime.lock.json'), 'utf8')) as VendorLock;
    expect(lock.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(lock.files)).toHaveLength(14);
    expect(Object.keys(lock.files).filter((file) => file.startsWith('src/integrations/runtime/fixtures/responses/'))).toHaveLength(10);
    expect(Object.keys(lock.files)).toEqual(expect.arrayContaining([
      'src/integrations/runtime/generated-contract-metadata.ts',
      'src/integrations/runtime/generated.ts',
      'src/integrations/runtime/timeline-commit-types.ts',
      'vendor/timeline-schema/python/banodoco_timeline_schema/timeline.schema.json',
      'src/integrations/runtime/fixtures/responses/events_page_1_200.json',
      'src/integrations/runtime/fixtures/responses/validation_error_422.json',
      'src/integrations/runtime/fixtures/responses/commit_conflict_409.json',
      'src/integrations/runtime/fixtures/responses/retired_route_410.json',
    ]));
    expect(Object.values(lock.files).some((entry) => entry.from === 'conformance/responses/publish_conflict_409.json')).toBe(false);
    expect([
      'src/integrations/runtime/vendor.lock.json',
      'src/integrations/runtime/fixtures/responses/vendor.lock.json',
      'vendor/timeline-schema/vendor.lock.json',
    ].every((file) => !existsSync(path.join(ROOT, file)))).toBe(true);
  });

  it.each([true, false])('sync migrates D39 response mappings and restores the lock on failure (producer ready: %s)', (d39Responses) => {
    const f = fixture({ d39Responses });
    try {
      cpSync(path.join(ROOT, 'scripts/sync-runtime-client.mjs'), path.join(f.consumer, 'scripts/sync-runtime-client.mjs'));
      const prefix = 'src/integrations/runtime/fixtures/responses/';
      const historical = `${prefix}publish_conflict_409.json`;
      f.lock.files = { [historical]: { from: 'conformance/responses/publish_conflict_409.json', sha256: hash('historical') } };
      writeFileSync(f.lockFile, JSON.stringify(f.lock));
      mkdirSync(path.join(f.consumer, prefix), { recursive: true });
      writeFileSync(path.join(f.consumer, historical), 'historical');
      const before = readFileSync(f.lockFile);
      const sync = () => execFileSync(process.execPath, [path.join(f.consumer, 'scripts/sync-runtime-client.mjs'), f.producer], { stdio: 'pipe' });
      if (d39Responses) {
        sync();
        expect(run(f, 'check')).toMatchObject({ status: 0 });
        const updated = readFileSync(f.lockFile);
        const lock = JSON.parse(updated.toString()) as VendorLock;
        expect(Object.keys(lock.files).sort()).toEqual([`${prefix}commit_conflict_409.json`, `${prefix}retired_route_410.json`]);
        for (const name of ['commit_conflict_409', 'retired_route_410']) {
          expect(readFileSync(path.join(f.consumer, prefix, `${name}.json`))).toEqual(readFileSync(path.join(f.producer, `conformance/responses/${name}.json`)));
        }
        sync();
        expect(readFileSync(f.lockFile)).toEqual(updated);
      } else {
        expect(sync).toThrow();
        expect(readFileSync(f.lockFile)).toEqual(before);
        expect(existsSync(path.join(f.consumer, prefix, 'commit_conflict_409.json'))).toBe(false);
      }
      expect(readFileSync(path.join(f.consumer, historical), 'utf8')).toBe('historical');
    } finally { clean(f); }
  });

  it('pins the entire Astrid public boundary and CLI export under one separate commit', () => {
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'config/astrid-cli-surface/vendor.lock.json'), 'utf8')) as VendorLock;
    const bundle = JSON.parse(readFileSync(path.join(ROOT, 'config/astrid-public-boundary/bundle.json'), 'utf8')) as {
      producer: string; files: Record<string, string>;
    };
    expect(lock.producer).toBe(bundle.producer);
    expect(lock.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.values(lock.files).map((entry) => entry.from).sort()).toEqual([
      'schemas/public-boundary/README.md',
      'schemas/public-boundary/bundle.json',
      ...Object.values(bundle.files),
    ].sort());
  });

  it('checks all consumer locks locally', () => {
    expect(LOCKS).toContain('config/astrid-cli-surface/vendor.lock.json');
    for (const lock of LOCKS) {
      const local = { ...fixture(), lockFile: path.join(ROOT, lock), consumer: ROOT } as Fixture;
      try { expect(run(local, 'check', false)).toMatchObject({ status: 0 }); }
      finally { clean(local); }
    }
  });

  it('rejects a different checkout commit even when artifact bytes are identical', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.producer, 'unrelated.txt'), 'same artifact bytes');
      execFileSync('git', ['add', '.'], { cwd: f.producer });
      execFileSync('git', ['commit', '-qm', 'new head, same artifact'], { cwd: f.producer });
      const result = run(f, 'check');
      expect(result.status).toBe(1);
      expect(result.output).toContain('does not match pinned source_commit');
    } finally { clean(f); }
  });

  it('rejects producer metadata that differs from the lock', () => {
    const f = fixture();
    try {
      f.lock.producer_version = hash('other version');
      writeFileSync(f.lockFile, JSON.stringify(f.lock));
      const versionMismatch = run(f, 'check');
      expect(versionMismatch.status).toBe(1);
      expect(versionMismatch.output).toContain('version sha256:');
      expect(versionMismatch.output).toContain('does not match lock producer_version');
      f.lock.producer_version = hash('version one');
      f.lock.producer = 'another-producer';
      writeFileSync(f.lockFile, JSON.stringify(f.lock));
      expect(run(f, 'check').output).toContain('does not match lock producer');
    } finally { clean(f); }
  });

  it('rejects missing and unlisted producer artifacts', () => {
    const missing = fixture();
    try {
      missing.lock.files['consumer/missing.txt'] = { from: 'missing.txt', sha256: hash('missing') };
      writeFileSync(missing.lockFile, JSON.stringify(missing.lock));
      expect(run(missing, 'check').output).toContain('missing from producer checkout');
    } finally { clean(missing); }

    const unlisted = fixture();
    try {
      const manifestPath = path.join(unlisted.producer, 'artifacts.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.artifacts = {};
      writeFileSync(manifestPath, JSON.stringify(manifest));
      execFileSync('git', ['add', 'artifacts.json'], { cwd: unlisted.producer });
      execFileSync('git', ['commit', '-qm', 'unlisted artifact'], { cwd: unlisted.producer });
      unlisted.lock.source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: unlisted.producer, encoding: 'utf8' }).trim();
      writeFileSync(unlisted.lockFile, JSON.stringify(unlisted.lock));
      expect(run(unlisted, 'check').output).toContain('unlisted in producer manifest');
    } finally { clean(unlisted); }
  });

  it('rejects producer working bytes that differ from the pinned commit', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.producer, 'a.txt'), 'dirty producer artifact');
      expect(run(f, 'check').output).toContain('producer manifest hash does not match pinned bytes');
    } finally { clean(f); }
  });

  it('rejects a producer manifest changed in the working tree', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.producer, 'artifacts.json'), 'dirty manifest');
      expect(run(f, 'check').output).toContain('producer working bytes differ from pinned commit');
    } finally { clean(f); }
  });

  it('requires a producer argument for update', () => {
    const f = fixture();
    try {
      const result = runWithoutProducerArgument(f);
      expect(result.status).toBe(1);
      expect(result.output).toContain('usage: vendor-lock.mjs');
    } finally { clean(f); }
  });

  it('names locally edited consumer bytes', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.consumer, 'consumer/a.txt'), 'edited consumer bytes');
      expect(run(f, 'check', false)).toMatchObject({ status: 1 });
      expect(run(f, 'check', false).output).toContain('consumer/a.txt: edited locally');
    } finally { clean(f); }
  });

  it('updates successfully from the pinned commit and then passes check', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.consumer, 'consumer/a.txt'), 'old bytes');
      f.lock.files['consumer/a.txt'].sha256 = hash('old bytes');
      f.lock.producer_version = hash('old version');
      writeFileSync(f.lockFile, JSON.stringify(f.lock));
      expect(run(f, 'update')).toMatchObject({ status: 0 });
      expect(run(f, 'check')).toMatchObject({ status: 0 });
      expect(readFileSync(path.join(f.consumer, 'consumer/a.txt'), 'utf8')).toBe('committed artifact A\n');
    } finally { clean(f); }
  });

  it('rejects stale producer metadata before changing consumer files or lock', () => {
    const f = fixture({ twoArtifacts: true, manifestHashMatches: false });
    try {
      writeFileSync(path.join(f.consumer, 'consumer/a.txt'), 'old consumer A');
      writeFileSync(path.join(f.consumer, 'consumer/b.txt'), 'old consumer B');
      const beforeLock = readFileSync(f.lockFile);
      const beforeA = readFileSync(path.join(f.consumer, 'consumer/a.txt'));
      const beforeB = readFileSync(path.join(f.consumer, 'consumer/b.txt'));
      const result = run(f, 'update');
      expect(result.status).toBe(1);
      expect(result.output).toContain('producer manifest hash does not match pinned bytes');
      expect(readFileSync(f.lockFile).equals(beforeLock)).toBe(true);
      expect(readFileSync(path.join(f.consumer, 'consumer/a.txt')).equals(beforeA)).toBe(true);
      expect(readFileSync(path.join(f.consumer, 'consumer/b.txt')).equals(beforeB)).toBe(true);
    } finally { clean(f); }
  });

  it('rejects update from a different producer commit without changing consumer files or lock', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.producer, 'unrelated.txt'), 'another commit');
      execFileSync('git', ['add', '.'], { cwd: f.producer });
      execFileSync('git', ['commit', '-qm', 'different producer revision'], { cwd: f.producer });
      writeFileSync(path.join(f.consumer, 'consumer/a.txt'), 'old consumer bytes');
      const beforeLock = readFileSync(f.lockFile);
      const beforeArtifact = readFileSync(path.join(f.consumer, 'consumer/a.txt'));
      const result = run(f, 'update');
      expect(result.status).toBe(1);
      expect(result.output).toContain('does not match pinned source_commit');
      expect(readFileSync(f.lockFile).equals(beforeLock)).toBe(true);
      expect(readFileSync(path.join(f.consumer, 'consumer/a.txt')).equals(beforeArtifact)).toBe(true);
    } finally { clean(f); }
  });
});
