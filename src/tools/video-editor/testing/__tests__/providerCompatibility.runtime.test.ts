/** Runtime uses verified command bases; the numeric snapshot-write contract is retired. */
import { describe, expect, it } from 'vitest';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { TimelineNotFoundError, TimelineSaveError } from '@/tools/video-editor/data/DataProvider.ts';
import { createDefaultTimelineConfig } from '@/tools/video-editor/lib/defaults.ts';
import { PROJECT_ID, TIMELINE_ID, json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';

describe('RuntimeDataProvider compatibility (runtimeFixture)', () => {
  it('loads canonical config and its physical head without a numeric-write adapter', async () => {
    const config = createDefaultTimelineConfig();
    const registry = { assets: {} };
    const fixture = runtimeFixture({ parentComposition: { config, registry, clips: [], occurrences: [] } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixture.transport });
    const loaded = await provider.loadTimeline(TIMELINE_ID);
    expect(loaded.config.clips).toEqual([]);
    expect(loaded.config.tracks).toEqual(config.tracks);
    expect(loaded.head).toMatchObject({ headRevisionId: 'parent-r1', headPublicationId: 'publication-current' });
    expect(await provider.loadAssetRegistry(TIMELINE_ID)).toEqual(registry);
  });

  it('refuses numeric snapshot saves without sending a retired write', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixture.transport });
    await expect(provider.saveTimeline(TIMELINE_ID, createDefaultTimelineConfig(), 1)).rejects.toBeInstanceOf(TimelineSaveError);
    expect(fixture.requests).toEqual([]);
    expect(fixture.read().headRevisionId).toBe('parent-r1');
  });

  it('maps an unknown public timeline to TimelineNotFoundError', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (method, path, headers, body) => {
      if (path.includes('/timelines/unknown')) return { status: 404, headers: {}, body: json({ code: 'not_found', message: 'timeline not found' }) };
      return fixture.transport(method, path, headers, body);
    } });
    await expect(provider.loadTimeline('unknown')).rejects.toBeInstanceOf(TimelineNotFoundError);
  });
});
