// Dropping an image onto a stored timeline that already has content must place it, or say why not.
import { describe, expect, it } from 'vitest';
import { applyPreparedMediaCommand } from '../commands/media.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';

interface StoredDocument { config: Record<string, unknown>; clips?: Array<Record<string, unknown>>; registry: AssetRegistry }
const corpus = Object.entries(import.meta.glob('./__fixtures__/corpus/*.json', { eager: true, import: 'default' }) as Record<string, StoredDocument>)
  .map(([path, document]) => ({ name: path.split('/').pop()!, document }));

const command = (trackId: string) => ({ type: 'place-prepared-media' as const, payload: { at: 0, trackId, asset: {
  assetKey: 'import-image', mediaType: 'image' as const, durationSeconds: null, source: 'registered' as const,
  entry: { file: 'import.png', type: 'image/png' } } } });

async function load(stored: StoredDocument, edit: (config: Record<string, any>) => void = () => {}) {
  const config = { ...structuredClone(stored.config), ...(stored.config.clips ? {} : { clips: structuredClone(stored.clips) }) } as Record<string, any>;
  edit(config);
  return buildTimelineData({ ...config, ...withDefaultTimelineOutput(config as never) } as TimelineConfig, structuredClone(stored.registry));
}
const variants: Array<[string, (config: Record<string, any>) => void]> = [
  ['as stored', () => {}],
  ['no output resolution', config => { delete config.output; }],
  ['partial output', config => { config.output = { fps: 30 }; }],
  ['legacy track scale', config => { for (const track of config.tracks) if (track.kind === 'visual') track.scale = 0.8; delete config.output; }],
];

describe.each(corpus)('drop onto stored document $name', ({ document }) => {
  it.each(variants)('places the image: %s', async (_name, edit) => {
    const built = await load(document, edit);
    const track = (built.config.tracks ?? []).find((item: { kind: string }) => item.kind === 'visual')!.id;
    const failures: unknown[] = [];
    const result = applyPreparedMediaCommand(built, command(track), { onFailure: failure => failures.push(failure) });
    expect(failures).toEqual([]);
    expect(result).not.toBeNull();
  });
});
