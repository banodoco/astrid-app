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

/** Full-v2 Timeline ABI, restricted to inspected generated contracts. */
export function supportsFullV2Commit(): boolean {
  return PROTOCOL === 'workspace.v1' && (CONTRACT_VERSION as string) === '0.2.14'
    && COMPONENT_MANIFEST_SHA256 === 'sha256:1ad76db27c1d9716bb234f811bf63e1f5898cb3d5f9b835a821765e6cad895e5'
    && [
      'sha256:fce459b4b6639e6cdf310c663b400967a30436eeda2d0382546b79eec73afe81',
      'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c',
      'sha256:4118b1e26d30be43cb1a01649df0065fed6e55a528b8956364df8f4eedb413d2',
      'sha256:867f3553ac0ff264300e5a2596b363cdb4c071842eb6570ad461c093d351708b',
      // Provisional c5991fc5, for focused tests; rebind against the published tuple at I-AP-07.
      'sha256:4af07ba30298fc2f036ec4e631a42a1a8095afca040274b8926905b1d9688671',
    ].includes(SCHEMA_DIGEST)
    && (OPERATIONS as readonly string[]).includes('commitTimeline')
    && (OPERATIONS as readonly string[]).includes('listTimelineCommits');
}
