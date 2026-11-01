import type { ClipSetParamsArgs, EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import { assertFiniteJson, copy, equal, has, object } from './clipMovePrimitives.ts';

export type ClipParamsArgs = ClipSetParamsArgs;

/** Structural checks only; Agent owns selected-pack schema validation. */
export function selectedParamsCommand(select: string, args: ClipParamsArgs): EditCommand {
  assertFiniteJson(args);
  if (!/^(?:parent|occurrence:[^/]+)\/clip:[^/]+$/.test(select) || select.includes('::')) {
    throw new Error('Clip parameters require a stable scoped clip identity');
  }
  if (!object(args) || !equal(Object.keys(args).sort(), ['clear', 'schema_source', 'values'])
    || !object(args.values) || !Array.isArray(args.clear) || args.clear.some((key) => typeof key !== 'string')
    || new Set(args.clear).size !== args.clear.length || args.clear.some((key) => has(args.values, key))
    || (!Object.keys(args.values).length && !args.clear.length)) {
    throw new Error('Clip parameters require literal values or explicit clears and an exact schema_source');
  }
  const pin = args.schema_source;
  if (!object(pin) || !equal(Object.keys(pin).sort(), ['content_digest', 'document_id', 'version'])
    || typeof pin.document_id !== 'string' || !pin.document_id.trim()
    || !Number.isSafeInteger(pin.version) || pin.version <= 0
    || typeof pin.content_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pin.content_digest)) {
    throw new Error('Selected pack requires an exact DocumentPin');
  }
  return { schema_version: 1, op: 'clip.set-params', version: '1', select, args: copy(args) };
}
