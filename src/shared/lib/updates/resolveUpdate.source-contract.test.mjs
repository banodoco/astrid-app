import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '../../../integrations/runtime/contract-metadata.ts';
import { LEGACY_RUNTIME_SCHEMA_DIGESTS, SOURCE_SCHEMA_MISMATCH_ACTION } from '../../../integrations/runtime/runtime-update-contract.mjs';
import { resolveUpdate } from './resolveUpdate.ts';

test('A1 source update contract shares its compatibility data with the local launcher', () => {
  assert.deepEqual(RUNTIME_ACCEPTED_SCHEMA_DIGESTS.slice(1), LEGACY_RUNTIME_SCHEMA_DIGESTS);
});

test('A1 source resolver provides the mismatch action used by the local launcher', () => {
  assert.deepEqual(
    resolveUpdate({ compatibility: { kind: 'schema', detail: 'schema mismatch' }, installType: 'source' }).primary,
    { label: SOURCE_SCHEMA_MISMATCH_ACTION },
  );
});
