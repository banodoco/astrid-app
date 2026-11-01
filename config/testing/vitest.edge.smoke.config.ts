import { defineConfig } from 'vitest/config';
import { createEdgeVitestTestConfig } from './vitest.edge.shared';

const EDGE_SMOKE_INCLUDE = [
  'supabase/functions/_tests/harness/**/*.test.ts',
  'supabase/functions/_tests/**/*.test.ts',
] as const;

export default defineConfig({
  test: createEdgeVitestTestConfig({
    include: EDGE_SMOKE_INCLUDE,
  }),
});
