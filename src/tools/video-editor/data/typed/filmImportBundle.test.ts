import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { prepareFilmImport } from '../../../../../scripts/save-loop/film-import.mjs';
// @ts-expect-error plain ESM script without types
import { filmFixtureShape } from '../../../../../scripts/save-loop/film-shape.mjs';
import { parseTimelineBundle } from './timelineBundle.ts';

const pin = (asset: string, digit: string) => ({ asset, generation_id: `g-${asset}`, variant_id: `v-${asset}`, object_id: `sha256:${digit.repeat(64)}` });
const video = pin('video', '1'), image = pin('image', '2'), audio = pin('audio', '3');
const content = { schema: 'media.transcript/v1', media_id: audio.object_id, source_id: 'film-line', text: 'repeat repeat w0001 w0002' };
const options = (count: number) => ({
  projectId: 'project', timelineId: 'film', shape: filmFixtureShape(count), selections: [video],
  legacyWord: { documentId: 'transcript', content, text: 'w0001', at: 0.1 },
  narration: { selection: audio, image, words: [{ text: 'w0001', at: 0.1 }, { text: 'w0002', at: 1.1 }, { text: 'repeat', at: 0.01 }, { text: 'repeat', at: 0.05 }], splitAt: { gapStart: 0.2, gapEnd: 0.7 }, end: 1.2 },
});

describe('film-import config.bundle', () => {
  it('parses with the editor TimelineBundle parser and resolves its asset in the parent registry', () => {
    const { publication } = prepareFilmImport(options(23));
    const parent = publication.parent_composition;
    const bundle = parseTimelineBundle(parent.config.bundle);
    // Both identities: assetId/documentId for the editor, mediaId/sourceId for the Agent. The optional
    // keys parse only with astrid-app PR #392 (release/15/transcript-refs-schema).
    expect(bundle.transcriptReferences?.associations).toEqual([
      { assetId: 'audio', documentId: 'transcript', mediaId: content.media_id, sourceId: content.source_id },
    ]);
    expect(parent.registry.assets.audio.media_id).toBe(content.media_id);
  });
  it('omits the bundle when no legacy word is declared', () => {
    const { legacyWord: _l, ...rest } = options(23);
    expect(prepareFilmImport(rest).publication.parent_composition.config.bundle).toBeUndefined();
  });
});
