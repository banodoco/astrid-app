/** Older Runtime schemas that remain compatible with the current App client. */
export const LEGACY_RUNTIME_SCHEMA_DIGESTS = Object.freeze([
  // Public App baseline (release identity absent, interpreted as release 0) remains compatible during migration.
  'sha256:9061d4982c786e04d99e45470b8ea4f3d9c9ff9855c4a2f83d751a93408c205b',
  // Runtime e6e5273d predates unresolved-effect warning support and remains compatible.
  'sha256:9081570c9d68212906426cfb0290c319849ea3dacaea1a0375d9e7e96d8c5ae9',
  // Runtime fa9cd546 is still pinned by the installer and predates this generated client refresh.
  'sha256:3605a9c517d92031d7702307e256223905784e0800bcd09c87005ce21ee53a47',
  // Before app-state: the Runtime without /v1/app-state stays compatible (the editor tour falls back to its local flag).
  'sha256:53bc985a9ab3dba290c3d2a99c7837460f43c9bb0f0ef486d273eec3e2e44ed0',
  // Before the additive starting state: existing service health remains compatible.
  'sha256:d4b3e46ab6481694810561c7aac99e45356a24a04b08545e53a7257663f007c4',
  // Before service health was added: existing Runtime responses remain compatible.
  'sha256:ec06fbc6567fe28065d22626b040cad81bb2e5318623586ae9187c713794f6b9',
]);

/** A1's resolver action for a schema mismatch on a source checkout. */
export const SOURCE_SCHEMA_MISMATCH_ACTION = 'update your checkouts';
