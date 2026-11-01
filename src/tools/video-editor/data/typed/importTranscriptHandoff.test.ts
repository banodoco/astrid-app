import { describe, it, expect } from 'vitest';
import {
  parseTranscriptDocument,
  resolveAssociatedAssetId,
  assertRegisteredTranscriptMedia,
  createTranscriptImportCallback,
} from './importTranscriptHandoff.ts';
import { buildTimelineData } from '../../lib/timeline-data.ts';
describe('external transcript handoff admission', () => {
  it('parses rich fields, optional legacy IDs and word alias without altering source seconds', () => {
    const d = parseTranscriptDocument(
      JSON.stringify({
        assetId: 'media',
        sourceId: 'source',
        segments: [
          {
            id: 's',
            start: 1,
            end: 3,
            text: 'Hello',
            speaker: 'Speaker',
            words: [{ id: 'w', start: 1, end: 2, word: 'Hello' }],
          },
        ],
      }),
    );
    expect(d).toMatchObject({
      assetId: 'media',
      sourceId: 'source',
      segments: [
        {
          id: 's',
          start: 1,
          end: 3,
          text: 'Hello',
          speaker: 'Speaker',
          words: [{ id: 'w', start: 1, end: 2, word: 'Hello' }],
        },
      ],
    });
  });
  it.each([
    'invalid',
    '[]',
    '{}',
    '{"segments":[]}',
    '{"segments":[{"start":-1,"end":1,"text":"x"}]}',
    '{"segments":[{"start":2,"end":1,"text":"x"}]}',
    '{"segments":[{"start":0,"end":1,"text":"x","words":[{"start":0,"end":1,"text":"a","word":"b"}]}]}',
  ])('rejects malformed source %s', (text) => {
    expect(() => parseTranscriptDocument(text)).toThrow();
  });
  it('requires an explicit media association and rejects mismatched assets', () => {
    expect(() => resolveAssociatedAssetId(undefined, undefined)).toThrow(
      'assetId',
    );
    expect(resolveAssociatedAssetId(undefined, 'media')).toBe('media');
    expect(() => resolveAssociatedAssetId('first', 'second')).toThrow(
      'selected',
    );
  });
  it('rejects a supplied source media pin that differs from the selected media', () => {
    expect(() => parseTranscriptDocument({
      mediaId: 'sha256:' + 'b'.repeat(64),
      segments: [{ start: 0, end: 1, text: 'source' }],
    })).not.toThrow();
    expect(() => parseTranscriptDocument({
      mediaId: 'not-a-runtime-media-pin',
      segments: [{ start: 0, end: 1, text: 'source' }],
    })).toThrow(/media_id/);
  });
  it('rejects absent and non-media registry entries', async () => {
    const data = await buildTimelineData(
      {
        output: { resolution: '1920x1080', fps: 30, file: 'out' },
        tracks: [],
        clips: [],
      },
      { assets: { image: { file: 'image.png', type: 'image/png' } } },
      (f) => f,
    );
    expect(() => assertRegisteredTranscriptMedia(data, 'missing')).toThrow(
      'not registered',
    );
    expect(() => assertRegisteredTranscriptMedia(data, 'image')).toThrow(
      'audio or video',
    );
  });
  it('never presents a timeline-only write as a durable project import', async () => {
    const data = await buildTimelineData(
      {
        output: { resolution: '1920x1080', fps: 30, file: 'out' },
        tracks: [],
        clips: [],
      },
      { assets: {} },
      (f) => f,
    );
    const commits: unknown[] = [];
    const callback = createTranscriptImportCallback({
      dataRef: { current: data },
      commitData: (next) => {
        commits.push(next);
      },
    });
    await expect(
      callback({
        document: { segments: [{ start: 0, end: 1, text: 'source' }] },
        associationAssetId: 'media',
      }),
    ).rejects.toThrow('Runtime');
    expect(commits).toEqual([]);
  });
  it('rejects a malformed source pin without mutating the supplied document', () => {
    const malformed = {
      mediaId: 'not-a-runtime-media-pin',
      segments: [{ start: 0, end: 1, text: 'source' }],
    };
    const before = structuredClone(malformed);

    expect(() => parseTranscriptDocument(malformed)).toThrow(/media_id/);
    expect(malformed).toEqual(before);
  });
});
