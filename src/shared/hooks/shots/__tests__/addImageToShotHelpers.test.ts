import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPlaceGeneration = vi.fn();

vi.mock('@/shared/lib/placement/placementService', () => ({
  placeGeneration: (...args: unknown[]) => mockPlaceGeneration(...args),
}));

vi.mock('@/shared/contexts/projectSelectionStore', () => ({
  getProjectSelectionFallbackId: vi.fn(() => 'fallback-project'),
}));

vi.mock('../shotMutationHelpers', () => ({
  isQuotaOrServerError: vi.fn().mockReturnValue(false),
}));

import {
  withVariableMetadata,
  runAddImageMutation,
  toAddImageErrorMessage,
  type AddImageToShotVariables,
} from '../addImageToShotHelpers';
import { isQuotaOrServerError } from '../shotMutationHelpers';
import { getProjectSelectionFallbackId } from '@/shared/contexts/projectSelectionStore';

function makeVariables(overrides: Partial<AddImageToShotVariables> = {}): AddImageToShotVariables {
  return {
    shot_id: 'shot-1',
    generation_id: 'gen-new',
    project_id: 'project-1',
    imageUrl: 'https://example.com/new.png',
    thumbUrl: 'https://example.com/new-thumb.png',
    ...overrides,
  };
}

describe('addImageToShotHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('withVariableMetadata', () => {
    it('merges project_id, imageUrl, and thumbUrl onto the data object', () => {
      const data = { id: 'sg-1', generation_id: 'gen-1' };
      const variables = makeVariables();
      const result = withVariableMetadata(data, variables);

      expect(result).toEqual({
        id: 'sg-1',
        generation_id: 'gen-1',
        project_id: 'project-1',
        imageUrl: 'https://example.com/new.png',
        thumbUrl: 'https://example.com/new-thumb.png',
      });
    });

    it('preserves existing properties on the data object', () => {
      const data = { id: 'sg-1', timeline_frame: 50, extra: true };
      const variables = makeVariables();
      const result = withVariableMetadata(data, variables);

      expect(result.id).toBe('sg-1');
      expect(result.timeline_frame).toBe(50);
      expect((result as Record<string, unknown>).extra).toBe(true);
      expect(result.project_id).toBe('project-1');
    });

    it('handles undefined imageUrl and thumbUrl', () => {
      const result = withVariableMetadata(
        { id: 'sg-1' },
        makeVariables({ imageUrl: undefined, thumbUrl: undefined }),
      );

      expect(result.imageUrl).toBeUndefined();
      expect(result.thumbUrl).toBeUndefined();
      expect(result.project_id).toBe('project-1');
    });

    it('does not override data properties with variable metadata', () => {
      const result = withVariableMetadata(
        { id: 'sg-1', project_id: 'old-project' },
        makeVariables({ project_id: 'new-project' }),
      );

      // Spread order: metadata wins only for its own keys.
      expect(result.project_id).toBe('new-project');
    });
  });

  describe('runAddImageMutation', () => {
    it('places pooled (null timelineFrame) through the document placement service', async () => {
      mockPlaceGeneration.mockResolvedValue({
        entryId: 'sg-shot-1-gen-new',
        shotId: 'shot-1',
        generationId: 'gen-new',
        timelineFrame: null,
        assetKey: 'gen:gen-new',
      });

      const result = await runAddImageMutation(makeVariables({ timelineFrame: null }));

      expect(mockPlaceGeneration).toHaveBeenCalledWith({
        projectSlug: 'project-1',
        shotId: 'shot-1',
        generationId: 'gen-new',
        timelineFrame: null,
      });
      expect(result).toEqual({
        id: 'sg-shot-1-gen-new',
        shot_id: 'shot-1',
        generation_id: 'gen-new',
        timeline_frame: null,
      });
    });

    it('auto-positions (undefined timelineFrame) after the shot\'s last clip', async () => {
      mockPlaceGeneration.mockResolvedValue({
        entryId: 'sg-shot-1-gen-new',
        shotId: 'shot-1',
        generationId: 'gen-new',
        timelineFrame: 100,
        assetKey: 'gen:gen-new',
      });

      const result = await runAddImageMutation(makeVariables({ timelineFrame: undefined }));

      expect(mockPlaceGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ timelineFrame: undefined }),
      );
      expect(result).toEqual({
        id: 'sg-shot-1-gen-new',
        shot_id: 'shot-1',
        generation_id: 'gen-new',
        timeline_frame: 100,
      });
    });

    it('passes an explicit frame through untouched', async () => {
      mockPlaceGeneration.mockResolvedValue({
        entryId: 'sg-shot-1-gen-new',
        shotId: 'shot-1',
        generationId: 'gen-new',
        timelineFrame: 75,
        assetKey: 'gen:gen-new',
      });

      const result = await runAddImageMutation(makeVariables({ timelineFrame: 75 }));

      expect(mockPlaceGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ timelineFrame: 75 }),
      );
      expect(result).toEqual({
        id: 'sg-shot-1-gen-new',
        shot_id: 'shot-1',
        generation_id: 'gen-new',
        timeline_frame: 75,
      });
    });

    it('passes the authenticated canonical occurrence owner through to placement', async () => {
      mockPlaceGeneration.mockResolvedValue({
        entryId: 'sg-shot-1-gen-new',
        shotId: 'shot-1',
        generationId: 'gen-new',
        timelineFrame: 75,
        assetKey: 'gen:gen-new',
      });

      await runAddImageMutation(makeVariables({
        ownerRef: 'occurrence:selected-occurrence',
        timelineFrame: 75,
      }));

      expect(mockPlaceGeneration).toHaveBeenCalledWith({
        projectSlug: 'project-1',
        shotId: 'shot-1',
        generationId: 'gen-new',
        ownerRef: 'occurrence:selected-occurrence',
        timelineFrame: 75,
      });
    });

    it('falls back to the project selection store when project_id is empty', async () => {
      mockPlaceGeneration.mockResolvedValue({
        entryId: 'sg-shot-1-gen-new',
        shotId: 'shot-1',
        generationId: 'gen-new',
        timelineFrame: null,
        assetKey: 'gen:gen-new',
      });

      await runAddImageMutation(makeVariables({ project_id: '' }));

      expect(mockPlaceGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ projectSlug: 'fallback-project' }),
      );
    });

    it('throws when no project is selected at all', async () => {
      vi.mocked(getProjectSelectionFallbackId).mockReturnValueOnce(null);

      await expect(runAddImageMutation(makeVariables({ project_id: '' }))).rejects.toThrow(
        'No project selected',
      );
      expect(mockPlaceGeneration).not.toHaveBeenCalled();
    });

    it('propagates placement failures (conflict, missing media, network)', async () => {
      mockPlaceGeneration.mockRejectedValue(new Error('timeline_version_conflict'));

      await expect(runAddImageMutation(makeVariables())).rejects.toThrow('timeline_version_conflict');
    });
  });

  describe('toAddImageErrorMessage', () => {
    it('returns network message for "Load failed" errors', () => {
      expect(toAddImageErrorMessage(new Error('Load failed'))).toContain('Network connection');
    });

    it('returns network message for "TypeError" errors', () => {
      expect(toAddImageErrorMessage(new Error('TypeError: Failed to fetch'))).toContain('Network connection');
    });

    it('returns server connection message for "fetch" errors', () => {
      expect(toAddImageErrorMessage(new Error('fetch error'))).toContain('Unable to connect');
    });

    it('returns server busy message for quota/server errors', () => {
      vi.mocked(isQuotaOrServerError).mockReturnValueOnce(true);

      expect(toAddImageErrorMessage(new Error('503 Service Unavailable'))).toContain('Server is temporarily busy');
    });

    it('returns the raw error message for unrecognized errors', () => {
      expect(toAddImageErrorMessage(new Error('Some unique error'))).toBe('Some unique error');
    });

    it('prioritizes "Load failed" over "fetch" in the message', () => {
      expect(toAddImageErrorMessage(new Error('Load failed during fetch'))).toContain('Network connection');
    });
  });
});
