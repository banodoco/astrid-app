import { describe, expect, it } from 'vitest';
import { SETTINGS_IDS } from '@/shared/lib/settingsIds';
import { TOOL_IDS } from '@/shared/lib/tooling/toolIds';
import { toolRuntimeManifest, toolsUIManifest } from '@/shared/lib/tooling/toolManifest';
import { ASTRID_TOOL_CATALOG, VIDEO_EDITOR_TOOL_LAUNCH } from '@/shared/lib/tooling/toolCatalog';
import { TOOL_ROUTES } from '@/shared/lib/tooling/toolRoutes';
import { toolDefaultsRegistry } from '@/tooling/toolDefaultsRegistry';
import { toolsManifest } from '@/tools';
import { videoEditorSettings } from '@/tools/video-editor/settings/videoEditorDefaults';

describe('video-editor registration', () => {
  it('is registered across tool ids, defaults, manifest, routes, and settings ids', () => {
    expect(TOOL_IDS.VIDEO_EDITOR).toBe('video-editor');
    expect(toolRuntimeManifest.some((tool) => tool.id === TOOL_IDS.VIDEO_EDITOR && tool.path === '/tools/video-editor')).toBe(true);
    expect(toolsUIManifest.some((tool) => tool.id === TOOL_IDS.VIDEO_EDITOR)).toBe(true);
    expect(toolsUIManifest.some((tool) => tool.id === TOOL_IDS.TRAVEL_BETWEEN_IMAGES)).toBe(true);
    expect(VIDEO_EDITOR_TOOL_LAUNCH).toMatchObject({
      available: true,
      entry: { canonical_id: expect.stringMatching(/^(rendering|video_editing)\.video-editor$/), target: 'astrid', entry: { host_entry: 'video-editor' } },
    });
    expect(ASTRID_TOOL_CATALOG.tools.find((entry) => entry.id === TOOL_IDS.VIDEO_EDITOR)?.release_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(TOOL_ROUTES.VIDEO_EDITOR).toBe('/tools/video-editor');
    expect(toolsManifest).toContain(videoEditorSettings);
    expect(toolDefaultsRegistry[TOOL_IDS.VIDEO_EDITOR]).toEqual(videoEditorSettings.defaults);
    expect(SETTINGS_IDS.VIDEO_EDITOR).toBe(TOOL_IDS.VIDEO_EDITOR);
  });
});
