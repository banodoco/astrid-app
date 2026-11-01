import { describe, expect, it } from 'vitest';
import { previewRevisionLabel, previewUnavailableLabel } from './previewRevision';

describe('preview captions', () => {
  const revisionId = `authoring-parent-revision-${'a'.repeat(64)}`;
  const target = { targetRevisionId: revisionId, reason: 'Preview could not be loaded' };

  it('leaves saved previews unlabelled and keeps revision ids out of status captions', () => {
    expect(previewRevisionLabel({ kind: 'committed', revisionId })).toBe('');
    expect(previewRevisionLabel({ kind: 'unknown' })).toBe('');
    expect(previewRevisionLabel({ kind: 'local', baseRevisionId: revisionId })).toBe('Unsaved local');
    expect(previewRevisionLabel({ kind: 'unavailable', unavailableTarget: target })).toBe('Preview unavailable');
    expect(previewUnavailableLabel(target)).toBe('Preview unavailable');
  });
});
