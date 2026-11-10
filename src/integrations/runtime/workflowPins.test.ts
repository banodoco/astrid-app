import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The App's workflows must test the Agent and Runtime the install manifest pins, not a hard-coded or branch ref.
// Each checkout of the Agent or Runtime reads its ref from the manifest (steps.pins) or a dispatch input override.

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const SIBLING = /repository:\s*banodoco\/astrid-(agent|runtime)\b/;
const HEX40 = /\b[0-9a-f]{40}\b/;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml')).map((name) => path.join(WORKFLOWS, name));
}

describe('App workflows pin the Agent and Runtime from the install manifest', () => {
  it('no workflow hard-codes a 40-character SHA', () => {
    const offenders = workflowFiles().flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').map((line, index) => ({ line, at: `${path.basename(file)}:${index + 1}` }))
        .filter(({ line }) => HEX40.test(line))
        .map(({ at }) => at));
    expect(offenders).toEqual([]);
  });

  it('every Agent or Runtime checkout takes its ref from the manifest pins or an input override', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!SIBLING.test(line)) return;
        const ref = lines.slice(index + 1, index + 4).find((candidate) => /^\s*ref:/.test(candidate)) ?? '';
        // Accepted: the manifest pin, optionally behind a dispatch input override: ${{ inputs.x || steps.pins.outputs.y }}.
        const pinned = /\$\{\{\s*(inputs\.(agent_ref|runtime_ref)\s*\|\|\s*)?steps\.pins\.outputs\.(agent_sha|runtime_sha)\s*\}\}/.test(ref);
        if (!pinned) offenders.push(`${path.basename(file)}:${index + 1} ${ref.trim() || '(no ref)'}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every workflow that reads the pins also declares the step that writes them', () => {
    for (const file of workflowFiles()) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('steps.pins.outputs')) continue;
      expect(text, `${path.basename(file)} writes the pins it reads`).toMatch(/id:\s*pins\b/);
      expect(text, `${path.basename(file)} reads the manifest it pins from`).toMatch(/public\/install-manifest\.json/);
    }
  });
});
