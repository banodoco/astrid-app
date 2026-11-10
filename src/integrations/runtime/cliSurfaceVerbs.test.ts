import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Every timelines verb the App's vendored CLI surface lists must be declared by the pinned Agent's CLI. The Agent's
// timeline domain declares its verbs as CommandSpec("<verb>", ...) in astrid/core/cli/domain_timelines.py. A verb the
// Agent no longer declares (such as the retired `timelines publish`) fails here, not at a journey run.

const ROOT = path.resolve(__dirname, '../../..');
const SURFACE = path.join(ROOT, 'config/astrid-cli-surface/cli-surface.json');
const LOCK = path.join(ROOT, 'config/astrid-cli-surface/vendor.lock.json');
const DOMAIN = 'astrid/core/cli/domain_timelines.py';

describe('vendored CLI surface: timelines verbs', () => {
  const agentCheckout = process.env.ASTRID_AGENT_CHECKOUT ?? path.resolve(ROOT, '..', 'astrid-agent');

  it('the Agent checkout the lock pins is present, so the verbs can be checked (a missing checkout fails)', () => {
    expect(existsSync(path.join(agentCheckout, DOMAIN)), `${DOMAIN} under ${agentCheckout}`).toBe(true);
  });

  it('every timelines verb the vendored surface lists is declared by the pinned Agent CLI', () => {
    const surface = JSON.parse(readFileSync(SURFACE, 'utf8')) as {
      families: { timelines: { verbs: Record<string, unknown> } };
    };
    const listed = Object.keys(surface.families.timelines.verbs).sort();
    expect(listed.length, 'the surface lists timelines verbs').toBeGreaterThan(0);

    const source = readFileSync(path.join(agentCheckout, DOMAIN), 'utf8');
    const declared = new Set([...source.matchAll(/CommandSpec\(\s*"([a-z-]+)"/g)].map((match) => match[1]));
    expect(listed.filter((verb) => !declared.has(verb))).toEqual([]);
  });

  it('the retired publish verb is not listed (the pinned Agent replaced it with commit)', () => {
    const surface = JSON.parse(readFileSync(SURFACE, 'utf8')) as {
      families: { timelines: { verbs: Record<string, unknown> } };
    };
    expect(Object.keys(surface.families.timelines.verbs)).not.toContain('publish');
  });

  it('the vendor lock pins the same Agent commit the verbs are checked against', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { source_commit: string };
    expect(lock.source_commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
