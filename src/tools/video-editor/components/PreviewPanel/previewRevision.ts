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
  if (revision.kind === 'committed' && revision.revisionId) {
    return `Committed ${revision.revisionId}`;
  }
  if (revision.kind === 'local') {
    return 'Unsaved local';
  }
  if (revision.kind === 'unavailable') {
    return revision.unavailableTarget ? previewUnavailableLabel(revision.unavailableTarget) : 'Preview unavailable';
  }
  return '';
}

export function previewUnavailableLabel(target: PreviewUnavailableTarget): string {
  return target.targetRevisionId ? `Preview of ${target.targetRevisionId} unavailable` : 'Preview target unavailable';
}
