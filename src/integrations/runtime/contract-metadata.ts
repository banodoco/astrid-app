/**
 * Compatibility metadata for the one generated Runtime client.
 * Runtime remains the wire/schema authority.
 */

import { CONTRACT_VERSION, PROTOCOL, SCHEMA_DIGEST, COMPONENT_MANIFEST_SHA256, OPERATIONS } from './generated-contract-metadata.ts';
import { LEGACY_RUNTIME_SCHEMA_DIGESTS } from './runtime-update-contract.mjs';

export const RUNTIME_PROTOCOL = PROTOCOL;
/** The current generated Runtime contract; compatible older contracts are listed below. */
export const RUNTIME_SCHEMA_DIGEST = SCHEMA_DIGEST;
export const RUNTIME_ACCEPTED_SCHEMA_DIGESTS = [
  RUNTIME_SCHEMA_DIGEST,
  ...LEGACY_RUNTIME_SCHEMA_DIGESTS,
] as const;
export const RUNTIME_COMPONENT_MANIFEST_SHA256 = COMPONENT_MANIFEST_SHA256;
export const RUNTIME_TARGETED_EXECUTION_CAPABILITY = 'execution_binding.targeted.v1' as const;

/** Full-v2 Timeline ABI, restricted to the reviewed C2 Runtime contract at 2d490617691c64c054a7c59c5c6ca9898c613c50. */
export function supportsFullV2Commit(): boolean {
  return PROTOCOL === 'workspace.v1' && (CONTRACT_VERSION as string) === '0.2.14'
    && COMPONENT_MANIFEST_SHA256 === 'sha256:7b74a8df08c86bbd8168d11272f13abd3e76becc2bcb4cbed799f11dc2f85f34'
    && SCHEMA_DIGEST === 'sha256:9c9e746eb5138f5e92baf5bcd87e8598c6aa92597c92083956b24517c4071923'
    && (OPERATIONS as readonly string[]).includes('commitTimeline')
    && (OPERATIONS as readonly string[]).includes('listTimelineCommits');
}
