import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { aggregateFixtureFailures, assertSourceVersionsUnchanged, verifyFileGraph } from './harness';
import { resolveReviewedPackHostHelper, startRealPackHost } from './bootstrap';
import { mediaHash } from './media';
import { playerBrowserProfile } from './browser-profile';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viewing-parity-graph-'));
  await Promise.all(Object.entries(files).map(async ([path, contents]) => {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents);
  }));
  return root;
}

async function helperCarrier(immutable: boolean): Promise<string> {
  assert.ok(process.env.ASTRID_PACK_HOST_HELPER_CHECKOUT, 'helper carrier must be configured');
  const root = await mkdtemp(join(tmpdir(), 'viewing-parity-helper-carrier-'));
  const helper = join(root, 'tests/packs/rendering/real_pack_host.py');
  await mkdir(join(root, 'tests/packs/rendering'), { recursive: true });
  await writeFile(helper, await readFile(join(process.env.ASTRID_PACK_HOST_HELPER_CHECKOUT!, 'tests/packs/rendering/real_pack_host.py')));
  if (immutable) {
    await Promise.all([
      chmod(root, 0o555), chmod(join(root, 'tests'), 0o555), chmod(join(root, 'tests/packs'), 0o555),
      chmod(join(root, 'tests/packs/rendering'), 0o555), chmod(helper, 0o444),
    ]);
  }
  return root;
}

async function releaseImmutableCarrier(root: string): Promise<void> {
  await Promise.all([
    chmod(root, 0o755), chmod(join(root, 'tests'), 0o755), chmod(join(root, 'tests/packs'), 0o755),
    chmod(join(root, 'tests/packs/rendering'), 0o755), chmod(join(root, 'tests/packs/rendering/real_pack_host.py'), 0o644),
  ]);
}

async function gitStub(dirty: boolean): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), 'viewing-parity-git-'));
  const executable = join(root, 'git');
  await writeFile(executable, `#!/bin/sh
case "$*" in
  *"status --porcelain --untracked-files=all"*) ${dirty ? "printf '%s\\n' '?? dirty.txt'" : ':'} ;;
  *"rev-parse HEAD^{tree}"*) printf '%s\\n' '687f077c4771e3dbb66bfb7ff2b98f310ac054b6' ;;
  *"rev-parse HEAD"*) printf '%s\\n' 'b70b9d569b2c80885d72734c61cd57e64c3715a8' ;;
  *) exit 1 ;;
esac
`);
  await chmod(executable, 0o755);
  return { root, env: { ASTRID_PACK_HOST_HELPER_CHECKOUT: '', PATH: `${root}${delimiter}${process.env.PATH ?? ''}` } };
}

class FailedHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  closed = false;

  constructor() {
    super();
    this.stdin.on('finish', () => {
      this.closed = true;
      this.stdout.end();
      this.stderr.end();
      setImmediate(() => this.emit('close', 1));
    });
  }

  kill(): boolean {
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

class ReadyHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor() {
    super();
    this.stdin.on('finish', () => {
      this.stdout.write(`${JSON.stringify({ status: 'stopped', host_pid: 42 })}\n`);
      this.stdout.end();
      this.stderr.end();
      setImmediate(() => this.emit('close', 0));
    });
  }

  kill(): boolean {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

test('accepts only the reviewed committed pack-host helper carrier', async () => {
  assert.ok(process.env.ASTRID_CHECKOUT, 'ASTRID_CHECKOUT must select the frozen Agent source');
  assert.ok(process.env.ASTRID_PACK_HOST_HELPER_CHECKOUT,
    'ASTRID_PACK_HOST_HELPER_CHECKOUT must select the reviewed helper carrier');
  const helper = await resolveReviewedPackHostHelper(process.env.ASTRID_CHECKOUT!);
  assert.equal(helper, join(await realpath(process.env.ASTRID_PACK_HOST_HELPER_CHECKOUT!), 'tests/packs/rendering/real_pack_host.py'));
});

test('refuses a dirty helper carrier before reading the helper', async () => {
  const carrier = await helperCarrier(true);
  const stub = await gitStub(true);
  try {
    await assert.rejects(
      resolveReviewedPackHostHelper(process.cwd(), {
        ...stub.env, ASTRID_PACK_HOST_HELPER_CHECKOUT: carrier,
      }),
      /Reviewed Agent pack-host helper carrier is dirty/,
    );
  } finally {
    await releaseImmutableCarrier(carrier);
    await Promise.all([rm(carrier, { recursive: true, force: true }), rm(stub.root, { recursive: true, force: true })]);
  }
});

test('refuses a writable helper carrier', async () => {
  const carrier = await helperCarrier(false);
  const stub = await gitStub(false);
  try {
    await assert.rejects(
      resolveReviewedPackHostHelper(process.cwd(), {
        ...stub.env, ASTRID_PACK_HOST_HELPER_CHECKOUT: carrier,
      }),
      /Reviewed Agent pack-host helper carrier must be immutable regular files and directories/,
    );
  } finally {
    await Promise.all([rm(carrier, { recursive: true, force: true }), rm(stub.root, { recursive: true, force: true })]);
  }
});

test('refuses a missing or wrong pack-host helper carrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewing-parity-helper-'));
  const stub = await gitStub(false);
  try {
    await assert.rejects(
      resolveReviewedPackHostHelper(process.cwd(), { ASTRID_PACK_HOST_HELPER_CHECKOUT: join(root, 'missing') }),
      /Reviewed Agent pack-host helper carrier is unavailable/,
    );
    await mkdir(join(root, 'tests/packs/rendering'), { recursive: true });
    await writeFile(join(root, 'tests/packs/rendering/real_pack_host.py'), 'wrong helper');
    await Promise.all([
      chmod(root, 0o555), chmod(join(root, 'tests'), 0o555), chmod(join(root, 'tests/packs'), 0o555),
      chmod(join(root, 'tests/packs/rendering'), 0o555), chmod(join(root, 'tests/packs/rendering/real_pack_host.py'), 0o444),
    ]);
    await assert.rejects(
      resolveReviewedPackHostHelper(process.cwd(), {
        ...stub.env, ASTRID_PACK_HOST_HELPER_CHECKOUT: root,
      }),
      /Reviewed Agent pack-host helper bytes changed/,
    );
  } finally {
    await releaseImmutableCarrier(root);
    await Promise.all([rm(root, { recursive: true, force: true }), rm(stub.root, { recursive: true, force: true })]);
  }
});

test('preserves a safe helper failure when startup cleanup also fails', async () => {
  const carrier = await helperCarrier(true);
  const stub = await gitStub(false);
  const helper = new FailedHelper();
  const env = {
    ...stub.env,
    ASTRID_CHECKOUT: process.cwd(),
    ASTRID_RUNTIME_CHECKOUT: process.cwd(),
    ASTRID_PYTHON: '/parent/python',
    ASTRID_PACK_HOST_HELPER_CHECKOUT: carrier,
  };
  const spawnHelper = ((..._args: Parameters<typeof spawn>) => {
    setImmediate(() => {
      helper.stderr.write('do-not-print credentials');
      helper.stdout.write(`${JSON.stringify({
        status: 'failed', error_type: 'RuntimeError', error_location: '/trusted/helper.py:321',
        secret: 'do-not-print',
      })}\n`);
    });
    return helper as unknown as ChildProcessWithoutNullStreams;
  }) as typeof spawn;
  try {
    await assert.rejects(
      startRealPackHost({
        tmp: carrier, realmDir: join(carrier, 'realm'), supportDir: join(carrier, 'support'),
        runtimeInstanceId: 'instance-exact',
      }, async () => {}, { env, spawn: spawnHelper, startupTimeoutMs: 100, stopTimeoutMs: 100 }),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message,
          /Pack-host helper reported failure \(error_type=RuntimeError, error_location=\/trusted\/helper\.py:321\)/);
        assert.match(error.message, /pack-host startup cleanup failed$/);
        assert.doesNotMatch(error.message, /do-not-print|secret|credential/i);
        return true;
      },
    );
    assert.equal(helper.closed, true);
  } finally {
    await releaseImmutableCarrier(carrier);
    await Promise.all([rm(carrier, { recursive: true, force: true }), rm(stub.root, { recursive: true, force: true })]);
  }
});

test('clears loader overrides only for the real pack-host child', async () => {
  const carrier = await helperCarrier(true);
  const stub = await gitStub(false);
  const helper = new ReadyHelper();
  const env = {
    ...stub.env,
    ASTRID_CHECKOUT: process.cwd(),
    ASTRID_RUNTIME_CHECKOUT: process.cwd(),
    ASTRID_PYTHON: '/parent/python',
    ASTRID_PACK_HOST_HELPER_CHECKOUT: carrier,
    ASTRID_RUNTIME_CREDENTIAL: '/trusted/credential',
    ASTRID_RUNTIME_SOURCE_MANIFEST: '/trusted/source-manifest',
    ASTRID_RUNTIME_ROLE: 'product',
    ASTRID_RUNTIME_LEASE_ID: 'lease-exact',
    NODE_OPTIONS: '--max-old-space-size=8192',
    NODE_PATH: '/usr/local/lib/node_modules_global',
  };
  const parentSentinels = {
    NODE_OPTIONS: env.NODE_OPTIONS,
    NODE_PATH: env.NODE_PATH,
  };
  let childEnv: NodeJS.ProcessEnv | undefined;
  const spawnHelper = ((...args: Parameters<typeof spawn>) => {
    childEnv = args[2]?.env;
    setImmediate(() => helper.stdout.write(`${JSON.stringify({
      status: 'ready', host_pid: 42, host_status: 'ready', host_ready_capabilities: ['rendering.render'],
    })}\n`));
    return helper as unknown as ChildProcessWithoutNullStreams;
  }) as typeof spawn;
  try {
    const session = await startRealPackHost(
      { tmp: carrier, realmDir: join(carrier, 'realm'), supportDir: join(carrier, 'support'), runtimeInstanceId: 'instance-exact' },
      async () => {},
      { env, spawn: spawnHelper, startupTimeoutMs: 100, stopTimeoutMs: 100 },
    );
    assert.ok(childEnv);
    assert.equal(childEnv.NODE_OPTIONS, undefined);
    assert.equal(childEnv.NODE_PATH, undefined);
    for (const key of ['ASTRID_CHECKOUT', 'ASTRID_RUNTIME_CHECKOUT', 'ASTRID_PYTHON', 'ASTRID_PACK_HOST_HELPER_CHECKOUT',
      'ASTRID_RUNTIME_CREDENTIAL', 'ASTRID_RUNTIME_SOURCE_MANIFEST', 'ASTRID_RUNTIME_ROLE', 'ASTRID_RUNTIME_LEASE_ID', 'PATH']) {
      assert.equal(childEnv[key], env[key], `${key} must be preserved for the helper child`);
    }
    assert.deepEqual({ NODE_OPTIONS: env.NODE_OPTIONS, NODE_PATH: env.NODE_PATH }, parentSentinels);
    await session.stop();
  } finally {
    await releaseImmutableCarrier(carrier);
    await Promise.all([rm(carrier, { recursive: true, force: true }), rm(stub.root, { recursive: true, force: true })]);
  }
});

test('verifies independent consumer graphs against frozen file bytes', async () => {
  const app = await fixture({ 'remotion/player.js': 'app-player', 'remotion/audio.js': 'app-audio' });
  const agent = await fixture({ 'remotion/player.js': 'agent-player', 'remotion/audio.js': 'agent-audio' });
  try {
    const appExpected = {
      'remotion/player.js': mediaHash(Buffer.from('app-player')),
      'remotion/audio.js': mediaHash(Buffer.from('app-audio')),
    };
    const agentExpected = {
      'remotion/player.js': mediaHash(Buffer.from('agent-player')),
      'remotion/audio.js': mediaHash(Buffer.from('agent-audio')),
    };
    assert.deepEqual(await verifyFileGraph(app, appExpected, 'App', { exact: true }), appExpected);
    assert.deepEqual(await verifyFileGraph(agent, agentExpected, 'Agent', { exact: true }), agentExpected);
  } finally {
    await Promise.all([rm(app, { recursive: true, force: true }), rm(agent, { recursive: true, force: true })]);
  }
});

test('fails closed when a frozen target is missing', async () => {
  const root = await fixture({ 'remotion/player.js': 'player' });
  try {
    await assert.rejects(
      verifyFileGraph(root, {
        'remotion/player.js': mediaHash(Buffer.from('player')),
        'remotion/audio.js': mediaHash(Buffer.from('audio')),
      }, 'Agent'),
      /Agent: missing or non-regular target remotion\/audio\.js/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when installed bytes or the exact package set changes', async () => {
  const root = await fixture({ 'remotion/player.js': 'changed', 'remotion/extra.js': 'unexpected' });
  try {
    await assert.rejects(
      verifyFileGraph(root, { 'remotion/player.js': mediaHash(Buffer.from('original')) }, 'App', { exact: true }),
      /App: installed file set differs/,
    );
    await rm(join(root, 'remotion/extra.js'));
    await assert.rejects(
      verifyFileGraph(root, { 'remotion/player.js': mediaHash(Buffer.from('original')) }, 'App'),
      /App: remotion\/player\.js has .* expected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails postflight when a declared dependency graph changes', () => {
  const before = {
    compositionFiles: { app: { 'package/index.js': 'sha256:composition' } },
    renderGraphHashes: { app: { 'node_modules/remotion.js': 'sha256:app' } },
    playerBrowser: playerBrowserProfile(),
    exportBrowserHash: 'sha256:export',
  } as const;
  assertSourceVersionsUnchanged(before, before);
  assert.throws(
    () => assertSourceVersionsUnchanged(before, {
      ...before,
      renderGraphHashes: { app: { 'node_modules/remotion.js': 'sha256:changed' } },
    }),
    /source dependency graph changed during browser fixture: renderGraphHashes/,
  );
});

test('keeps both fixture failures visible without replacing their original errors', () => {
  const cause = new Error('underlying source failure');
  const first = new Error('Player launch failed');
  const second = new Error('source postflight failed', { cause });
  const aggregate = aggregateFixtureFailures('Player fixture failed', [first, second]);

  assert.ok(aggregate instanceof AggregateError);
  assert.match(aggregate.message, /1: Player launch failed/);
  assert.match(aggregate.message, /2: source postflight failed/);
  assert.doesNotMatch(aggregate.message, /underlying source failure/);
  assert.deepEqual([...aggregate.errors], [first, second]);
  assert.equal(second.cause, cause);
});

test('fails postflight when the selected browser profile or executable bytes change', () => {
  const before = {
    compositionFiles: {}, renderGraphHashes: {}, playerBrowser: playerBrowserProfile(), exportBrowserHash: 'export',
  };
  for (const after of [
    { ...before, playerBrowser: playerBrowserProfile('native-codec-chrome155') },
    { ...before, playerBrowser: { ...before.playerBrowser, sha256: 'changed' } },
    { ...before, exportBrowserHash: 'changed' },
  ]) {
    assert.throws(() => assertSourceVersionsUnchanged(before, after), /source dependency graph changed/);
  }
});
