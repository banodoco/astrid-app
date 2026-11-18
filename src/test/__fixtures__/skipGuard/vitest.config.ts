import path from 'node:path';
import { defineConfig } from 'vitest/config';
import SkipGuardReporter from '../../../../config/testing/skipGuardReporter';

// Runs the fixtures next to this file with the same guard settings as config/testing/vitest.config.ts.
export default defineConfig({
  root: __dirname,
  resolve: { alias: { '@': path.resolve(__dirname, '../../..') } },
  test: { include: ['*.fixture.ts'], allowOnly: false, includeTaskLocation: true, reporters: ['default', new SkipGuardReporter()] },
});
