import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { readGeneratedSchemaDigest, schemaDigestMismatch } from './runtime-schema-guard.mjs';

describe('Runtime schema guard', () => {
  it('reads the generated digest and accepts a matching health response', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'astrid-runtime-schema-'));
    try {
      const metadataPath = join(dir, 'generated-contract-metadata.ts');
      writeFileSync(metadataPath, 'export const SCHEMA_DIGEST = "sha256:latest";\n');
      const expected = readGeneratedSchemaDigest(metadataPath);
      assert.equal(expected, 'sha256:latest');
      assert.equal(schemaDigestMismatch('sha256:latest', expected), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a Runtime health response from a different contract', () => {
    assert.match(
      schemaDigestMismatch('sha256:stale', 'sha256:latest'),
      /does not match Astrid generated contract \(expected one of sha256:latest\)/,
    );
  });

  it('accepts a shared compatible digest and rejects absent or malformed values', () => {
    const accepted = ['sha256:latest', 'sha256:older-compatible'];
    assert.equal(schemaDigestMismatch('sha256:older-compatible', accepted), null);
    assert.match(schemaDigestMismatch(undefined, accepted), /expected one of sha256:latest, sha256:older-compatible/);
    assert.match(schemaDigestMismatch('not-a-digest', accepted), /does not match Astrid generated contract/);
  });
});
