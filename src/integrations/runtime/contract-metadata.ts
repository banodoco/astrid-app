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
  // Runtime int/r1 3b12fface: R1 contract plus additive M operations and fields.
  'sha256:a36913ece941dce500344487aec682ce692411a4922c0382afc380b6caa959e0',
] as const;
export const RUNTIME_COMPONENT_MANIFEST_SHA256 = COMPONENT_MANIFEST_SHA256;
export const RUNTIME_TARGETED_EXECUTION_CAPABILITY = 'execution_binding.targeted.v1' as const;

/** Full-v2 Timeline ABI, restricted to the published round-1b generated contract. */
export function supportsFullV2Commit(): boolean {
  return PROTOCOL === 'workspace.v1' && (CONTRACT_VERSION as string) === '0.2.14'
    && COMPONENT_MANIFEST_SHA256 === 'sha256:7b74a8df08c86bbd8168d11272f13abd3e76becc2bcb4cbed799f11dc2f85f34'
    && SCHEMA_DIGEST === 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c'
    && (OPERATIONS as readonly string[]).includes('commitTimeline')
    && (OPERATIONS as readonly string[]).includes('listTimelineCommits');
}
