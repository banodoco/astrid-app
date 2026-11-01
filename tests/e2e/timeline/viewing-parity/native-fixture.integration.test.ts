import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { test } from 'node:test';
import { EXPLICIT_CANVAS_640, NORMAL_PROFILE_NATIVE1920, ORIGINAL_640, type ParityCanvas } from './canvas';

const FROZEN_SOURCES = {
  runtimeServer: {
    root: '/home/user/banodoco/banodoco-workspace-runtime',
    commit: '8f105c26e3b62f9c2683f717a9773a12bc775a8e',
    tree: 'b7f456d5135cba6049980ebc43a91c7a72ab8f7e',
    archiveSha256: 'aeaf5a0e1f7190d4962db36dfa38f3a3f563890c78d3b3948eba7d67779d7ca3',
  },
  runtimeProducer: {
    root: '/home/user/banodoco/banodoco-workspace-runtime',
    commit: '2c4ac180c2220bdad966bc01e95ad230e99ce26a',
    tree: '7ab412cc4bcbe517efcfa806e092336390312e18',
    archiveSha256: 'eed22a1b0d1af2045f823ec9f71dbd7cd862ba7935edfd5199171656e3ff1669',
  },
  agent: {
    root: '/home/user/peteromallet/astrid-agent',
    commit: 'd0a5072bbe7b7ce9489f43aa0a81027ec400343b',
    tree: '6adb4a1190dfb2874e101565f37eccd392b1ae2f',
    archiveSha256: 'd10fcb33d8842ee03dd813f2a1ee55b0c649930b41dae2fc93aec1b8b7e8e7f8',
  },
} as const;

type FrozenSource = (typeof FROZEN_SOURCES)[keyof typeof FROZEN_SOURCES];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function sourceManifest(root: string): Promise<{ files: number; sha256: string }> {
  const entries: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else {
        assert.equal(entry.isFile(), true, `frozen source contains non-file ${absolute}`);
        const digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
        entries.push(`${relative(root, absolute)}\0${digest}`);
      }
    }
  }
  await visit(root);
  entries.sort();
  return { files: entries.length, sha256: createHash('sha256').update(entries.join('\n')).digest('hex') };
}

async function archiveFrozenSources(directory: string) {
  const archived = {} as Record<keyof typeof FROZEN_SOURCES, {
    root: string;
    tree: string;
    archiveSha256: string;
    manifest: { files: number; sha256: string };
  }>;
  for (const [name, source] of Object.entries(FROZEN_SOURCES) as Array<[keyof typeof FROZEN_SOURCES, FrozenSource]>) {
    assert.equal(git(source.root, 'rev-parse', source.commit), source.commit, `${name} frozen commit is unavailable`);
    const tree = git(source.root, 'rev-parse', `${source.commit}^{tree}`);
    assert.equal(tree, source.tree, `${name} frozen tree changed`);
    const archive = execFileSync('git', ['-C', source.root, 'archive', '--format=tar', source.commit], { maxBuffer: 512 * 1024 * 1024 });
    const archiveSha256 = createHash('sha256').update(archive).digest('hex');
    assert.equal(archiveSha256, source.archiveSha256, `${name} frozen archive changed`);
    const root = join(directory, name);
    await mkdir(root, { recursive: true });
    execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
    archived[name] = { root, tree, archiveSha256, manifest: await sourceManifest(root) };
  }
  return archived;
}

function pythonSourceProof(python: string, runtime: string, agent: string) {
  const output = execFileSync(python, ['-B', '-c', [
    'import astrid, json, runtime_protocol, sys',
    'print(json.dumps({"astrid": astrid.__file__, "runtime_protocol": runtime_protocol.__file__, "sys_path": sys.path}))',
  ].join(';')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [runtime, agent].join(delimiter) },
    encoding: 'utf8',
  });
  const proof = JSON.parse(output.trim()) as { astrid: string; runtime_protocol: string; sys_path: string[] };
  assert.equal(proof.astrid.startsWith(`${agent}/`), true, `Agent module escaped frozen archive: ${proof.astrid}`);
  assert.equal(proof.runtime_protocol.startsWith(`${runtime}/`), true,
    `Runtime module escaped frozen archive: ${proof.runtime_protocol}`);
  assert.deepEqual(proof.sys_path.filter(path => path === runtime || path === agent), [runtime, agent]);
  return proof;
}

async function assertNativeFixtureRestoresThroughV1(canvas: ParityCanvas): Promise<void> {
  const sourceTemp = await mkdtemp(join(tmpdir(), 'native-frame-frozen-pair-'));
  const previousEnv = { ...process.env };
  let harness: import('../../local/support/harness').DirectHarness | undefined;
  try {
    const archived = await archiveFrozenSources(sourceTemp);
    const runtimePython = process.env.ASTRID_RUNTIME_PYTHON ?? '/home/user/work/venv-runtime/bin/python';
    const agentPython = process.env.ASTRID_PYTHON ?? '/home/user/work/venv-agent/bin/python';
    assert.equal(await readFile(runtimePython).then(() => true).catch(() => false), true, `Runtime Python missing: ${runtimePython}`);
    assert.equal(await readFile(agentPython).then(() => true).catch(() => false), true, `Agent Python missing: ${agentPython}`);
    process.env.ASTRID_RUNTIME_CHECKOUT = archived.runtimeServer.root;
    process.env.ASTRID_CHECKOUT = archived.agent.root;
    process.env.ASTRID_RUNTIME_PYTHON = runtimePython;
    process.env.ASTRID_PYTHON = agentPython;
    const moduleProof = pythonSourceProof(runtimePython, archived.runtimeServer.root, archived.agent.root);
    const { DirectHarness } = await import('../../local/support/harness');
    const { assertCanonicalNativeMedia, nativeFrameParitySetup, prepareFrameParityFixture, prepareNativeFrameParityRealm, readRuntimeJson, timelineBase } = await import('./fixture');
    const before = {
      app: { source: 'App test source is the current integration snapshot; no App source archive is substituted' },
      runtimeServer: { commit: FROZEN_SOURCES.runtimeServer.commit, tree: archived.runtimeServer.tree,
        archiveSha256: archived.runtimeServer.archiveSha256, manifest: archived.runtimeServer.manifest },
      runtimeProducer: { commit: FROZEN_SOURCES.runtimeProducer.commit, tree: archived.runtimeProducer.tree,
        archiveSha256: archived.runtimeProducer.archiveSha256, manifest: archived.runtimeProducer.manifest },
      agent: { commit: FROZEN_SOURCES.agent.commit, tree: archived.agent.tree,
        archiveSha256: archived.agent.archiveSha256, manifest: archived.agent.manifest },
      moduleProof,
    };
    assert.notEqual(before.runtimeServer.commit, before.runtimeProducer.commit,
      'Runtime server and official producer must remain separate identities');
    console.log(`[native-frame-source-proof] before ${JSON.stringify(before)}`);
    harness = new DirectHarness();
    await harness.start({ seed: false, beforeRuntimeStart: async current => {
      await prepareNativeFrameParityRealm(current, canvas);
    }});
    const python = process.env.ASTRID_PYTHON;
    assert.ok(python, 'ASTRID_PYTHON must select the accepted current Agent source');
    await harness.enableTimelineAuthoring(python);

    const setup = nativeFrameParitySetup(harness);
    const empty = await readRuntimeJson<{ project_id: string; timeline_id: string; head_revision_id: string | null; head_publication_id: string | null }>(
      harness, `${timelineBase({ projectId: setup.projectId, timelineId: setup.timelineId })}`);
    assert.deepEqual({
      project_id: empty.project_id,
      timeline_id: empty.timeline_id,
      head_revision_id: empty.head_revision_id,
      head_publication_id: empty.head_publication_id,
    }, {
      project_id: setup.projectId,
      timeline_id: setup.timelineId,
      head_revision_id: setup.head.revision_id,
      head_publication_id: setup.head.publication_id,
    });

    const fixture = await prepareFrameParityFixture(harness, canvas, setup);
    assert.equal(fixture.media.length, 3);
    assert.deepEqual(fixture.media.map(pin => pin.name), ['image', 'video', 'audio']);
    assert.equal(fixture.sourceVideoMediaId, fixture.media.find(pin => pin.name === 'video')!.objectId);
    assert.deepEqual(fixture.parent.payload.config, setup.document.parent_revision.payload.config);
    assert.deepEqual(setup.document.dependency_manifest.media,
      fixture.media.map(pin => ({ media_id: pin.objectId, content_digest: pin.digest }))
        .sort((a, b) => a.media_id.localeCompare(b.media_id)));
    assertCanonicalNativeMedia(fixture, canvas);

    // Setup is native and the only accepted mutation is the ordinary restore command.
    assert.equal(harness.audit().filter(entry => entry.method === 'POST' && entry.path.endsWith('/composition-revisions')).length, 0);

    const objectsBefore = (await readRuntimeJson<{ items: unknown[] }>(harness,
      `/v1/projects/${fixture.projectId}/objects?limit=50`)).items;
    const forged = await harness.runtimeJson('POST', '/v1/tasks', {
      project: fixture.projectId,
      capability_id: 'rendering.render',
      capability_digest: `sha256:${'0'.repeat(64)}`,
      input_object_ids: [],
      spec: {
        authority_context: {
          mode: 'composed_capture', project_id: fixture.projectId, timeline_id: fixture.timelineId,
          revision_id: fixture.headRevisionId,
          capture_snapshot: { config: { clips: [{ id: 'forged', hold: 999 }] }, registry: {} },
        },
        inputs: { filmstrip_authority: '{}' },
      },
    });
    assert.notEqual(forged.status, 201);
    const objectsAfter = (await readRuntimeJson<{ items: unknown[] }>(harness,
      `/v1/projects/${fixture.projectId}/objects?limit=50`)).items;
    assert.deepEqual(objectsAfter, objectsBefore);
    assert.equal(harness.audit().filter(entry => entry.method === 'POST' && entry.path.endsWith('/composition-revisions')).length, 0);
    await harness.stop();
    harness = undefined;
    const after = {
      runtimeServer: await sourceManifest(archived.runtimeServer.root),
      runtimeProducer: await sourceManifest(archived.runtimeProducer.root),
      agent: await sourceManifest(archived.agent.root),
    };
    assert.deepEqual(after.runtimeServer, before.runtimeServer.manifest);
    assert.deepEqual(after.runtimeProducer, before.runtimeProducer.manifest);
    assert.deepEqual(after.agent, before.agent.manifest);
    console.log(`[native-frame-source-proof] after ${JSON.stringify(after)}`);
  } finally {
    await harness?.stop();
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
    await rm(sourceTemp, { recursive: true, force: true });
  }
}

test('native retained frame fixture restores through /v1 with immutable media pins', async () => {
  await assertNativeFixtureRestoresThroughV1(ORIGINAL_640);
});

test('native retained frame fixture restores through /v1 with the actual default native1920 profile', async () => {
  await assertNativeFixtureRestoresThroughV1(NORMAL_PROFILE_NATIVE1920);
});

test('native retained frame fixture restores through /v1 with an explicit theme canvas640 profile', async () => {
  await assertNativeFixtureRestoresThroughV1(EXPLICIT_CANVAS_640);
});
