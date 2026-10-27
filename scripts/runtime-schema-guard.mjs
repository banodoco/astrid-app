import { readFileSync } from 'node:fs';

export function readGeneratedSchemaDigest(metadataPath) {
  let source;
  try {
    source = readFileSync(metadataPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read generated Runtime metadata at ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const match = source.match(/export const SCHEMA_DIGEST = [\"']([^\"']+)[\"']/);
  if (!match?.[1]) {
    throw new Error(`generated Runtime metadata at ${metadataPath} has no SCHEMA_DIGEST`);
  }
  return match[1];
}

export function schemaDigestMismatch(actual, accepted) {
  const acceptedDigests = Array.isArray(accepted) ? accepted : [accepted];
  if (typeof actual === 'string' && acceptedDigests.includes(actual)) return null;
  return `runtime schema digest ${String(actual)} does not match Astrid generated contract (expected one of ${acceptedDigests.join(', ')}); sync src/integrations/runtime/generated-contract-metadata.ts from the Runtime checkout`;
}
