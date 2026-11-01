import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createElementAdmissionsPlugin } from '../vite/astridElementAdmissions';
import { resolveAstridSource, validateAstridToolCatalog } from '../vite/astridSource';
import { CHECKOUT_LANE, assertCheckoutLaneFilesExist } from './lanes';
import SkipGuardReporter from './skipGuardReporter';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const checkoutLane = process.env.VITEST_LANE === 'checkout';
assertCheckoutLaneFilesExist(projectRoot);
const astridSource = resolveAstridSource();
if (astridSource) validateAstridToolCatalog(astridSource.sourceRoot);
const astridPublicSource = resolveAstridSource(
  process.env.ASTRID_PUBLIC_CHECKOUT ?? '',
  'ASTRID_PUBLIC_CHECKOUT',
);
export default defineConfig({
  root: projectRoot,
  plugins: [createElementAdmissionsPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, 'src'),
      '@test-react-refresh': path.resolve(projectRoot, 'node_modules/@vitejs/plugin-react-swc/refresh-runtime.js'),
      '@astrid/editor-sdk': path.resolve(projectRoot, 'src/sdk/index.ts'),
      ...(astridSource ? { '@astrid': astridSource.sourceRoot } : {}),
      ...(astridPublicSource ? { '@astrid-public': astridPublicSource.sourceRoot } : {}),
      'fake-indexeddb': path.resolve(projectRoot, 'vendor/fake-indexeddb/index.js'),
      // Share one React/Remotion runtime with Composition and linked host elements.
      'react': path.resolve(projectRoot, 'node_modules/react'),
      'react-dom': path.resolve(projectRoot, 'node_modules/react-dom'),
      // Edge function tests run the function under Node: Deno's std `serve` becomes a recorder of the handler.
      'https://deno.land/std@0.224.0/http/server.ts': path.resolve(projectRoot, 'supabase/functions/_tests/mocks/denoHttpServer.ts'),
      'npm:groq-sdk@0.26.0': path.resolve(projectRoot, 'supabase/functions/_tests/mocks/groqSdk.ts'),
      'remotion': path.resolve(projectRoot, 'node_modules/remotion'),
      '@remotion/layout-utils': path.resolve(projectRoot, 'node_modules/@remotion/layout-utils'),
      '@remotion/media': path.resolve(projectRoot, 'node_modules/@remotion/media'),
      '@banodoco/timeline-schema': path.resolve(projectRoot, 'src/test/shims/banodoco/timeline-schema.ts'),
      // Resolve vendored Composition registry primitives used by generated modules.
      '@workspace-effects': path.resolve(projectRoot, 'vendor/banodoco-effects'),
      '@workspace-animations': path.resolve(projectRoot, 'vendor/banodoco-animations'),
      '@workspace-transitions': path.resolve(projectRoot, 'vendor/banodoco-transitions'),
    },
    dedupe: [
      'three',
      '@remotion/three',
      'react',
      'react-dom',
      'remotion',
      '@remotion/layout-utils',
      '@banodoco/timeline-composition',
    ],
  },
  server: {
    fs: {
      // Allow Vite to read from sibling banodoco-workspace.
      allow: [
        path.resolve(projectRoot, '..', '..'),
        ...(astridSource ? [astridSource.checkout] : []),
        ...(astridPublicSource ? [astridPublicSource.checkout] : []),
      ],
    },
  },
  test: {
    globals: true,
    // No invisible skips: `.only` fails the run, and SkipGuardReporter fails it on any undeclared skip.
    allowOnly: false,
    reporters: ['default', new SkipGuardReporter()],
    // Hang guard only (testing plan R-10): durations never fail a run, so the
    // per-test and per-hook ceilings are generous; only a genuine hang trips them.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    environment: 'jsdom',
    include: checkoutLane
      ? CHECKOUT_LANE
      : [
        'src/**/*.test.{ts,tsx}',
        // Test files outside src/ that are vitest tests and that this repo owns.
        'config/vite/*.test.ts',
        'supabase/functions/**/*.test.ts',
      ],
    // Deliberately not collected (each is declared here so none is an invisible orphan):
    //  - vendor/*/tests, vendor/*/typescript/tests, vendor/*/dist/tests: vendored copies of upstream packages
    //    (timeline-ops, timeline-schema, timeline-composition, astrid-browser); their suites belong to, and run in,
    //    the producing repos, and the vendor-lock checks in .github/workflows/test.yml pin the copies to them.
    //  - tests/e2e/local/support/quick-descriptor.test.ts and scripts/**/*.test.mjs are node:test files, run by
    //    `npm run test:node`, which `npm test` runs in CI (test.yml); the per-area scripts (test:extension-*,
    //    test:no-remote-hosts, test:remotion-audio-resume-patch) run subsets of the same files.
    //    scripts/installer/bootstrap*.test.mjs fail on a machine without pwsh / with this POSIX installer: see LANES
    //    'node-installer-bootstrap' in skipRegistry.mjs.
    exclude: [
      ...(checkoutLane ? [] : CHECKOUT_LANE),
      // This suite imports Astrid's selected Remotion composition and has its
      // own config so its linked workspace aliases resolve to Astrid's pack.
      'src/tools/video-editor/runtime/astridSceneComposition.test.tsx',
    ],
    // Keep Composition and the test providers on one Remotion context instance.
    server: {
      deps: {
        inline: ['remotion', '@banodoco/timeline-composition'],
      },
    },
    setupFiles: [
      path.resolve(projectRoot, 'src/test/reactRefreshSetup.ts'),
      path.resolve(projectRoot, 'src/test/setup.ts'),
    ],
  },
});
