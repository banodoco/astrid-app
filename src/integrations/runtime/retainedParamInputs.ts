import type { Project, WorkspaceClient } from './generated.ts';
import type { DocumentPin, VerifiedDocument, VerifiedDocumentObject } from './timeline-commit-types.ts';
type ReadPort = Pick<WorkspaceClient, 'getProjectVerifiedDocument' | 'getProjectVerifiedDocumentObject'>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const exactKeys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length
  && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const exactPin = (value: unknown): value is DocumentPin => object(value)
  && exactKeys(value, ['document_id', 'version', 'content_digest']) && text(value.document_id)
  && Number.isSafeInteger(value.version) && Number(value.version) > 0 && digest(value.content_digest);
/** Read the exact retained project-pack inputs used by native PARAM capture. */
export async function readRetainedParamInputs(
  client: ReadPort,
  context: Pick<Project, 'project_id' | 'realm_id'>,
  originalPin: DocumentPin | null | undefined,
  selected: unknown,
): Promise<{ verified: VerifiedDocument; objects: Record<string, VerifiedDocumentObject> }> {
  if (!exactPin(originalPin)) throw new Error('selected pack requires an original exact DocumentPin');
  if (!object(context) || !text(context.project_id) || !text(context.realm_id)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(context.project_id)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(context.realm_id)) {
    throw new Error('selected pack requires authenticated canonical project and realm identities');
  }
  if (!object(selected) || !['packId', 'id', 'kind', 'revision'].every((key) => text(selected[key]))) {
    throw new Error('selected pack requires an admitted owner-qualified element reference');
  }
  const verified = await client.getProjectVerifiedDocument(context.project_id, originalPin);
  if (!object(verified) || !exactPin(verified.pin) || verified.pin.document_id !== originalPin.document_id
    || verified.pin.version !== originalPin.version || verified.pin.content_digest !== originalPin.content_digest) {
    throw new Error('verified document does not match the original exact pin');
  }
  const row = verified.document;
  if (!object(row) || row.kind !== 'astrid.project-pack' || row.project_id !== context.project_id
    || row.document_id !== originalPin.document_id || row.version !== originalPin.version) {
    throw new Error('project pack document does not match the original scoped pin');
  }
  const content = row.content;
  if (!object(content) || content.schema !== 'astrid.project-pack/v1'
    || content.source_binding_key !== 'project-packs' || !Array.isArray(content.admissions)) {
    throw new Error('unsupported project pack payload schema/source binding');
  }
  if (content.pack_id !== selected.packId
    || content.relative_manifest !== `${context.realm_id}/${context.project_id}/packs/${selected.packId}/pack.yaml`) {
    throw new Error('project pack owner or scope does not match selected declaration');
  }
  const admitted = content.admissions.filter((item) => object(item)
    && ['id', 'kind', 'revision'].every((key) => item[key] === selected[key]));
  if (admitted.length !== 1) throw new Error('selected element owner/revision requires exactly one admission');
  const expected = admitted[0].snapshot_object;
  if (!object(expected) || !exactKeys(expected, ['object_id', 'digest', 'size', 'media_type'])
    || !digest(expected.digest) || expected.object_id !== expected.digest
    || !Number.isSafeInteger(expected.size) || Number(expected.size) <= 0 || expected.media_type !== 'application/json') {
    throw new Error('pack snapshot object descriptor is unavailable or invalid');
  }
  const snapshot = await client.getProjectVerifiedDocumentObject(context.project_id, originalPin, expected.object_id);
  if (!object(snapshot) || !exactKeys(snapshot, ['object_id', 'digest', 'size', 'media_type', 'bytes_base64'])
    || typeof snapshot.bytes_base64 !== 'string'
    || (['object_id', 'digest', 'size', 'media_type'] as const).some((key) => snapshot[key] !== expected[key])) {
    throw new Error('pack snapshot object does not match selected admission');
  }
  return { verified, objects: { [snapshot.object_id as string]: snapshot as VerifiedDocumentObject } };
}
