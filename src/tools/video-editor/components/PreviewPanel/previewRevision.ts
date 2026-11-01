export type PreviewUnavailableTarget = Readonly<{
  targetRevisionId?: string;
  reason: string;
}>;

export type PreviewRevision = Readonly<{
  kind: 'committed' | 'local' | 'unavailable' | 'unknown';
  revisionId?: string;
  baseRevisionId?: string | null;
  unavailableTarget?: PreviewUnavailableTarget;
  reason?: string;
}>;

export function previewRevisionLabel(revision: PreviewRevision): string {
  if (revision.kind === 'local') {
    return 'Unsaved local';
  }
  if (revision.kind === 'unavailable') {
    return 'Preview unavailable';
  }
  return '';
}

export function previewUnavailableLabel(_target: PreviewUnavailableTarget): string {
  return 'Preview unavailable';
}
