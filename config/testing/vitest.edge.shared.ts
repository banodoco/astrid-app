import type { InlineConfig } from 'vitest';

interface EdgeConfigOptions {
  include: readonly string[];
  exclude?: readonly string[];
}

export function createEdgeVitestTestConfig(options: EdgeConfigOptions): NonNullable<InlineConfig['test']> {
  return {
    environment: 'node',
    include: [...options.include],
    ...(options.exclude ? { exclude: [...options.exclude] } : {}),
    globals: true,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30_000,
    hookTimeout: 180_000,
  };
}
