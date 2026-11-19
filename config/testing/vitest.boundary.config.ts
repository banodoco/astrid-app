import CeilingVitest from '../../scripts/ci/ceiling_vitest';
import SkipGuardReporter from './skipGuardReporter';
import { SDK_VITEST_INCLUDE } from './vitestIncludes.mjs';
import { defineConfig } from 'vitest/config';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');
export default defineConfig({
  root: projectRoot,
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, 'src'),
      '@astrid/editor-sdk': path.resolve(projectRoot, 'src/sdk'),
      'fake-indexeddb': path.resolve(projectRoot, 'vendor/fake-indexeddb/index.js'),
      // Share one React/Remotion runtime with Composition and linked host elements.
      'react': path.resolve(projectRoot, 'node_modules/react'),
      'react-dom': path.resolve(projectRoot, 'node_modules/react-dom'),
      'remotion': path.resolve(projectRoot, 'node_modules/remotion'),
      '@remotion/layout-utils': path.resolve(projectRoot, 'node_modules/@remotion/layout-utils'),
      '@remotion/media': path.resolve(projectRoot, 'node_modules/@remotion/media'),
      '@banodoco/timeline-schema': path.resolve(projectRoot, 'vendor/timeline-schema/typescript/dist/src/index.js'),
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
      allow: [path.resolve(projectRoot, '..', '..')],
    },
  },
  test: {
    globals: true,
    allowOnly: false,
    includeTaskLocation: true,
    reporters: process.env.VITEST_JUNIT_OUTPUT
      ? ['default', new CeilingVitest(), new SkipGuardReporter({ resultsFile: `${process.env.VITEST_JUNIT_OUTPUT}.jsonl` }), ['junit', { outputFile: process.env.VITEST_JUNIT_OUTPUT }]]
      : ['default', new CeilingVitest(), new SkipGuardReporter()],
    environment: 'jsdom',
    include: SDK_VITEST_INCLUDE,
    setupFiles: [path.resolve(projectRoot, 'src/test/setup.ts')],
  },
});
