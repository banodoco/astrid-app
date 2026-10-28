/**
 * Compatibility metadata for the one generated Runtime client.
 * Runtime remains the wire/schema authority.
 */

import { PROTOCOL, SCHEMA_DIGEST, COMPONENT_MANIFEST_SHA256 } from './generated-contract-metadata.ts';
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
