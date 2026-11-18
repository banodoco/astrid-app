// The runner and the expected-failure scanner share the same include patterns.
// Node's .test.mjs files keep their existing node:test lane.
export const DEFAULT_VITEST_INCLUDE = [
  'src/**/*.test.{ts,tsx,js,jsx}',
  'config/vite/*.test.{ts,tsx,js,jsx}',
  'supabase/functions/**/*.test.{ts,tsx,js,jsx}',
];
export const SDK_VITEST_INCLUDE = ['src/sdk/__tests__/*.test.{ts,tsx,js,jsx}'];
export const RUNTIME_RESTORE_INCLUDE = ['tests/integration/runtimeRestore.test.ts'];
export const ALL_VITEST_INCLUDE = [...DEFAULT_VITEST_INCLUDE, ...SDK_VITEST_INCLUDE, ...RUNTIME_RESTORE_INCLUDE];
