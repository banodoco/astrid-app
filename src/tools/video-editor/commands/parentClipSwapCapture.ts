import type { CommandRecord, EditCommand, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  executeParentClipSwapMedia,
  parentClipMediaSelection,
} from './parentClipAddCapture.ts';
import { ClipMoveError, assertFiniteJson, copy, freezeJson, object } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

export type ParentClipSwapMediaBasis = {
  readonly bundle: AuthoredBundle;
  readonly command: EditCommand;
};

/** Capture one raw parent clip replacement against its original authored asset. */
export function captureParentClipSwapMedia(
  bundle: AuthoredBundle, clipId: string, media: MediaSelection, selectedOldMedia?: MediaSelection,
): ParentClipSwapMediaBasis {
  const oldMedia = parentClipMediaSelection(bundle, clipId, selectedOldMedia);
  const command: EditCommand = {
    schema_version: 1,
    op: 'clip.swap-media',
    version: '1',
    select: `parent/clip:${clipId}`,
    args: { old_media: copy(oldMedia), media: copy(media) },
    // Private014 only; public013 stays unsupported and its DTO is unchanged.
    intent: { ownership: 'parent' } as unknown as EditCommand['intent'],
  };
  // Both selections are checked against detached Runtime inputs at finish.
  return freezeJson({ bundle: copy(bundle), command });
}

export function finishParentClipSwapMedia(basis: unknown, verifiedMedia: readonly VerifiedMedia[]): {
  command: EditCommand;
  bundle: AuthoredBundle;
  record: CommandRecord;
} {
  assertFiniteJson(basis);
  if (!object(basis) || !object(basis.bundle) || !object(basis.command) ||
    !object(basis.command.args) || !object(basis.command.args.media)) {
    throw new ClipMoveError('incomplete parent clip.swap-media basis');
  }
  return executeParentClipSwapMedia(
    basis.bundle as AuthoredBundle,
    basis.command as EditCommand,
    verifiedMedia,
  );
}
