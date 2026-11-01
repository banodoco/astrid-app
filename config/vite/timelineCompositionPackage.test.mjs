import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveConfig } from 'vite';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageName = '@banodoco/timeline-composition';
const packageRoot = path.join(appRoot, 'node_modules', packageName);
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const peerVersions = { ...manifest.peerDependencies, three: '0.185.1', '@remotion/three': '4.0.509' };
const configs = [
  'config/vite/vite.config.ts',
  'config/testing/vitest.config.ts',
  'config/testing/vitest.boundary.config.ts',
  'config/testing/vitest.astrid-renderer.config.ts',
  'config/testing/vitest.edge.config.ts',
  'scripts/astrid-landing/public-host-browser/vite.config.ts',
  'examples/embed-demo/vite.config.ts',
];

test('root and lock use the approved immutable source-commit artifact', () => {
  const artifact = 'vendor/artifacts/banodoco-timeline-composition-a5908fac2b43c5d7b17a45cd4687d7caccf1806451e1f081aee3e912fe64ca89.tgz';
  const bytes = fs.readFileSync(path.join(appRoot, artifact));
  const root = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
  const installed = lock.packages[`node_modules/${packageName}`];
  assert.equal(bytes.length, 73235);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a5908fac2b43c5d7b17a45cd4687d7caccf1806451e1f081aee3e912fe64ca89');
  assert.equal(root.dependencies[packageName], `file:${artifact}`);
  assert.equal(lock.packages[''].dependencies[packageName], root.dependencies[packageName]);
  assert.equal(installed.version, '0.0.15');
  assert.equal(installed.resolved, `file:${artifact}`);
  assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.equal(root.devDependencies['@remotion/layout-utils'], '4.0.509');
});

for (const configFile of configs) {
  test(`${configFile} resolves Composition public exports and shared peers`, async () => {
    const previousCheckout = process.env.ASTRID_CHECKOUT;
    const previousPublicCheckout = process.env.ASTRID_PUBLIC_CHECKOUT;
    const checkout = previousCheckout || path.join(appRoot, 'vendor/astrid-browser');
    process.env.ASTRID_CHECKOUT = checkout;
    process.env.ASTRID_PUBLIC_CHECKOUT = previousPublicCheckout || checkout;
    try {
      const config = await resolveConfig({ configFile: path.join(appRoot, configFile) }, 'build');
      const resolve = config.createResolver();
      const importers = [
        path.join(appRoot, 'src/tools/video-editor/compositions/TimelineRenderer.tsx'),
        path.join(checkout, 'remotion/src/ThreeTimelineComposition.tsx'),
      ];
      assert.equal(manifest.version, '0.0.15');
      for (const [subpath, entry] of Object.entries(manifest.exports)) {
        if (subpath === './package.json') continue;
        const specifier = packageName + subpath.slice(1);
        for (const importer of importers) {
          const resolved = await resolve(specifier, importer);
          assert.ok(resolved, `${specifier} from ${importer}`);
          // The edge lane deliberately keeps its source aliases. Production
          // Vite uses the pinned archive's public export map for every
          // Composition subpath, including the generated registries and theme.
          if (configFile === 'config/testing/vitest.edge.config.ts') {
            assert.ok(path.resolve(resolved).startsWith(path.resolve(appRoot, 'vendor/timeline-composition')));
          } else {
            const expectedPath = path.join(packageRoot, entry.import);
            if (fs.existsSync(resolved)) {
              assert.equal(fs.realpathSync(resolved), fs.realpathSync(expectedPath));
            } else {
              assert.equal(path.resolve(resolved), path.resolve(packageRoot, subpath.slice(2)));
              assert.ok(fs.existsSync(expectedPath), `${specifier} archive target`);
            }
          }
        }
      }
      for (const [peer, version] of Object.entries(peerVersions)) {
        const peerRoot = path.join(appRoot, 'node_modules', peer);
        assert.equal(JSON.parse(fs.readFileSync(path.join(peerRoot, 'package.json'), 'utf8')).version, version);
        const appPeer = await resolve(peer, importers[0]);
        const linkedPeer = await resolve(peer, importers[1]);
        const compositionPeer = await resolve(peer, path.join(packageRoot, manifest.main));
        assert.ok(appPeer, peer);
        assert.equal(linkedPeer, appPeer, `${peer} must share one runtime`);
        assert.equal(compositionPeer, appPeer, `${peer} inside Composition must share the App runtime`);
      }
    } finally {
      if (previousCheckout === undefined) delete process.env.ASTRID_CHECKOUT;
      else process.env.ASTRID_CHECKOUT = previousCheckout;
      if (previousPublicCheckout === undefined) delete process.env.ASTRID_PUBLIC_CHECKOUT;
      else process.env.ASTRID_PUBLIC_CHECKOUT = previousPublicCheckout;
    }
  });
}

test('diagnostic reports all Composition peer resolution divergences', async () => {
  const divergences = [];
  for (const configFile of configs) {
    const previousCheckout = process.env.ASTRID_CHECKOUT;
    const previousPublicCheckout = process.env.ASTRID_PUBLIC_CHECKOUT;
    const checkout = previousCheckout || path.join(appRoot, 'vendor/astrid-browser');
    process.env.ASTRID_CHECKOUT = checkout;
    process.env.ASTRID_PUBLIC_CHECKOUT = previousPublicCheckout || checkout;
    try {
      const config = await resolveConfig({ configFile: path.join(appRoot, configFile) }, 'build');
      const resolve = config.createResolver();
      const importers = {
        app: path.join(appRoot, 'src/tools/video-editor/compositions/TimelineRenderer.tsx'),
        linked: path.join(checkout, 'remotion/src/ThreeTimelineComposition.tsx'),
        composition: path.join(packageRoot, manifest.main),
      };
      for (const [peer] of Object.entries(peerVersions)) {
        const resolved = {};
        for (const [importer, source] of Object.entries(importers)) {
          const result = await resolve(peer, source);
          resolved[importer] = result ? fs.realpathSync(result) : undefined;
        }
        for (const [importer, actual] of Object.entries(resolved)) {
          if (!actual || actual !== resolved.app) {
            divergences.push({ configFile, peer, importer, actual, expected: resolved.app });
          }
        }
      }
    } finally {
      if (previousCheckout === undefined) delete process.env.ASTRID_CHECKOUT;
      else process.env.ASTRID_CHECKOUT = previousCheckout;
      if (previousPublicCheckout === undefined) delete process.env.ASTRID_PUBLIC_CHECKOUT;
      else process.env.ASTRID_PUBLIC_CHECKOUT = previousPublicCheckout;
    }
  }
  assert.deepEqual(divergences, []);
});

test('Node SSR can import the public Composition consumer subpaths', async () => {
  const [evaluation, themeApi, registry] = await Promise.all([
    import(`${packageName}/evaluation`),
    import(`${packageName}/theme-api`),
    import(`${packageName}/registry.generated`),
  ]);
  assert.equal(typeof evaluation.encodedEnvelopeSource, 'function');
  assert.equal(typeof themeApi.composeAnimations, 'function');
  assert.ok(themeApi.DEFAULT_THEME);
  assert.ok(registry.THEME_PACKAGE_REGISTRY);
});
