import { existsSync } from 'node:fs';
import path from 'node:path';

// Test lanes (testing plan UP.3, R-5). Tests listed here need files outside this
// repository: another repo's checkout. The default run excludes them;
// `npm run test:checkout` runs exactly them, so the two lanes together are the
// whole suite.
export const CHECKOUT_LANE = [
  // Reads Runtime's conformance vectors from a sibling Runtime worktree.
  'src/tools/video-editor/data/portableVisualSeamIntent.test.ts',
  'src/tools/video-editor/data/visualSeamSharedCases.test.ts',
  // Runs Astrid's pack-owned scene-authoring test through @astrid (ASTRID_CHECKOUT).
  // Astrid has no JS runner, so this wrapper is the only place that test executes.
  'src/tools/video-editor/runtime/astridSceneAuthoring.test.ts',
  // Checks the extension catalog against the selected Astrid checkout.
  'src/tools/video-editor/dev/localExtensions.catalog.test.ts',
  // Builds an installed effect with explicitly selected Agent/Runtime roots,
  // then exercises their real browser transport and the open editor renderer.
  'src/tools/video-editor/runtime/runtimePackRefresh.integration.test.ts',
];

/**
 * A renamed or deleted file would otherwise drop out of both lanes without a sound (the default run excludes the list,
 * the checkout lane includes only it). Every vitest config load checks that each listed file exists.
 */
export function assertCheckoutLaneFilesExist(repoRoot: string): void {
  const missing = CHECKOUT_LANE.filter((file) => !existsSync(path.join(repoRoot, file)));
  if (missing.length > 0) {
    throw new Error(`CHECKOUT_LANE (config/testing/lanes.ts) lists files that do not exist: ${missing.join(', ')}`);
  }
}
