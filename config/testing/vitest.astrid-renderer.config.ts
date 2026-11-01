import path from 'node:path';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import { resolveAstridSource } from '../vite/astridSource';

const astridSource = resolveAstridSource();
if (!astridSource) {
  throw new Error('ASTRID_CHECKOUT is required for Astrid renderer composition tests');
}

const baseAliases = baseConfig.resolve?.alias;
if (!baseAliases || Array.isArray(baseAliases)) {
  throw new Error('Expected the base Vitest config to define object-form aliases');
}

/**
 * The Astrid composition test imports Astrid's real Remotion composition.
 * Composition's packaged registries supply the defaults; linked host elements
 * use the base config's selected Astrid source.
 */
export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: {
      ...baseAliases,
      '@remotion/three': path.resolve(__dirname, '../../node_modules/@remotion/three'),
      // Astrid's composition sits outside this repo and installs nothing here: resolve its bare `three` to the one App copy.
      three: path.resolve(__dirname, '../../node_modules/three'),
    },
  },
  test: {
    ...baseConfig.test,
    include: ['src/tools/video-editor/runtime/astridSceneComposition.test.tsx'],
    exclude: [],
    server: {
      ...baseConfig.test.server,
      deps: {
        ...baseConfig.test.server?.deps,
        inline: ['remotion', '@banodoco/timeline-composition'],
      },
    },
  },
});
