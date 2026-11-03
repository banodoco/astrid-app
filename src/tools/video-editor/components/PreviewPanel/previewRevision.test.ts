import { describe, expect, it } from 'vitest';
import { previewRevisionLabel, previewUnavailableLabel } from './previewRevision';

describe('preview captions', () => {
  const revisionId = `authoring-parent-revision-${'a'.repeat(64)}`;
  const target = { targetRevisionId: revisionId, reason: 'Preview could not be loaded' };

  it('labels the delivered committed revision and unavailable target', () => {
    expect(previewRevisionLabel({ kind: 'committed', revisionId })).toBe(`Committed ${revisionId}`);
    expect(previewRevisionLabel({ kind: 'committed' })).toBe('');
    expect(previewRevisionLabel({ kind: 'unknown' })).toBe('');
    expect(previewRevisionLabel({ kind: 'local', baseRevisionId: revisionId })).toBe('Unsaved local');
    expect(previewRevisionLabel({ kind: 'unavailable', unavailableTarget: target })).toBe(`Preview of ${revisionId} unavailable`);
    expect(previewUnavailableLabel(target)).toBe(`Preview of ${revisionId} unavailable`);
    expect(previewRevisionLabel({ kind: 'unavailable' })).toBe('Preview unavailable');
    expect(previewUnavailableLabel({ reason: target.reason })).toBe('Preview target unavailable');
  });
});
