import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve('node_modules/@banodoco/timeline-composition');
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

describe('installed timeline-composition exports', () => {
  it.each(['registry', 'effects', 'animations', 'transitions'])('ships the %s generated registry without workspace imports', async (family) => {
    const subpath = `./${family}.generated`;
    const target = manifest.exports[subpath]?.import;
    expect(target).toBeTruthy();
    const file = path.join(packageRoot, target);
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/@workspace-(effects|animations|transitions)/);
    const module = await import(/* @vite-ignore */ file);
    expect(Object.keys(module).length).toBeGreaterThan(0);
    if (family !== 'registry') expect(source).toMatch(/(?:import|from|require\()/);
  });
});
