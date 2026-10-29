import { describe, expect, it } from 'vitest';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '../../../integrations/runtime/contract-metadata.ts';
import { resolveUpdate } from './resolveUpdate.ts';

// Digests from the checked-in metadata at the pinned real Runtime revisions.
const preUpdater = 'sha256:9061d4982c786e04d99e45470b8ea4f3d9c9ff9855c4a2f83d751a93408c205b'; // 11443b0b5b34bd5b36725504fb083146192a759d
const candidate = 'sha256:5d229bf66ffaeb0b4937844a3c2b08ddd21f97cbcc305101a5cc19a95c971194'; // 2b57de0482961509d22fe01d886922ae6e803c3f

describe('pinned Runtime skew decisions', () => {
  it('admits the pre-updater digest and rejects the candidate digest', () => {
    expect(RUNTIME_ACCEPTED_SCHEMA_DIGESTS).toContain(preUpdater);
    expect(RUNTIME_ACCEPTED_SCHEMA_DIGESTS).not.toContain(candidate);
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'schema digest mismatch' } })).toMatchObject({ card: 'update', title: 'Update Astrid' });
  });
  it('decides newer and required releases for installed Runtimes and suppresses both for source', () => {
    expect(resolveUpdate({ installType: 'installer', installedRelease: 5, servedRelease: 4 })).toMatchObject({ card: 'newer', primary: null });
    expect(resolveUpdate({ installType: 'installer', installedRelease: 4, servedRelease: 5, requiredRelease: 5, requiredReason: 'test' })).toMatchObject({ card: 'update', body: 'This update is required: test' });
    expect(resolveUpdate({ installType: 'source', installedRelease: 5, servedRelease: 4 }).card).toBe('none');
    expect(resolveUpdate({ installType: 'source', installedRelease: 4, servedRelease: 5, requiredRelease: 5 }).card).toBe('none');
  });
});
