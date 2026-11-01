import { describe, expect, it } from 'vitest';
import {
  RUNTIME_ACCEPTED_SCHEMA_DIGESTS,
  RUNTIME_SCHEMA_DIGEST,
  supportsFullV2Commit,
} from './contract-metadata.ts';
import { CONTRACT_VERSION, OPERATIONS, PROTOCOL, SCHEMA_DIGEST } from './generated-contract-metadata.ts';
import { LEGACY_RUNTIME_SCHEMA_DIGESTS } from './runtime-update-contract.mjs';

// Runtime origin/int/r1 at 3b12fface79a3be029f3b6623765a7f3e1e5e24f.
const PUBLISHED_RUNTIME_DIGEST = 'sha256:a36913ece941dce500344487aec682ce692411a4922c0382afc380b6caa959e0';

describe('Runtime compatibility metadata', () => {
  it('accepts the published additive R1+M contract and existing supported contracts only', () => {
    expect(RUNTIME_SCHEMA_DIGEST).toBe(SCHEMA_DIGEST);
    expect(RUNTIME_ACCEPTED_SCHEMA_DIGESTS).toEqual([
      SCHEMA_DIGEST,
      ...LEGACY_RUNTIME_SCHEMA_DIGESTS,
      PUBLISHED_RUNTIME_DIGEST,
    ]);
    expect(RUNTIME_ACCEPTED_SCHEMA_DIGESTS as readonly string[]).not.toContain(
      'sha256:7ea06a0280135541d9989d8e959382b86de31cb137811a9424fd25212b0a9fe9',
    );
  });

  it('enables the inspected provisional Timeline ABI without claiming a published Runtime pin', () => {
    expect(PROTOCOL).toBe('workspace.v1');
    expect(CONTRACT_VERSION).toBe('0.2.14');
    expect(OPERATIONS as readonly string[]).toContain('commitTimeline');
    expect(OPERATIONS as readonly string[]).toContain('listTimelineCommits');
    expect(supportsFullV2Commit()).toBe(true);
  });
});
