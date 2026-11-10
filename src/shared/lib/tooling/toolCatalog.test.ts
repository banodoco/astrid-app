import { describe, expect, it } from 'vitest';
import vendoredCatalog from '../../../../vendor/astrid-browser/astrid/tools/catalog.json';
import agentCatalog from './fixtures/astrid-agent-0f792afb1-tools-catalog.json';
import { TOOL_IDS } from './toolIds';
import { ASTRID_TOOL_CATALOG, resolveToolLaunch, type AstridToolCatalog } from './toolCatalog';

// The Video Editor's owner is `rendering` (release-12 Agent 0f792afb1) or the temporary `video_editing` (Plan 39).
const ACCEPTED_OWNERS = [
  { canonical_id: 'rendering.video-editor', pack_id: 'rendering' },
  { canonical_id: 'video_editing.video-editor', pack_id: 'video_editing' },
];

describe('canonical Tool catalog binding', () => {
  it('projects the Video Editor whole-Tool identity and immutable release closure', () => {
    const entry = ASTRID_TOOL_CATALOG.tools.find((candidate) => candidate.id === TOOL_IDS.VIDEO_EDITOR);
    expect(entry).toMatchObject({
      target: 'astrid',
      compatibility: { host: '1' },
      entry: { host_entry: 'video-editor', path: 'ui/video-editor/entry.json' },
    });
    expect(ACCEPTED_OWNERS).toContainEqual({ canonical_id: entry?.canonical_id, pack_id: entry?.pack_id });
    expect(entry?.release_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveToolLaunch(ASTRID_TOOL_CATALOG, TOOL_IDS.VIDEO_EDITOR)).toMatchObject({ available: true });
  });

  it.each([
    ['the vendored Astrid catalog', vendoredCatalog],
    ['the Agent 0f792afb1 catalog (checked-in fixture)', agentCatalog],
  ])('resolves the Video Editor against %s', (_name, catalog) => {
    const resolution = resolveToolLaunch(catalog as AstridToolCatalog, TOOL_IDS.VIDEO_EDITOR);
    expect(resolution).toMatchObject({ available: true });
  });

  it('refuses an owner outside the accepted set', () => {
    const current = ASTRID_TOOL_CATALOG.tools.find((entry) => entry.id === TOOL_IDS.VIDEO_EDITOR)!;
    const catalog = (entry: typeof current) => ({ schema_version: 1, tools: [entry] });
    expect(resolveToolLaunch(catalog({ ...current, canonical_id: 'other.video-editor', pack_id: 'other' }), TOOL_IDS.VIDEO_EDITOR)).toEqual({
      available: false, reason: 'unsupported-canonical-tool-binding',
    });
  });

  it('fails closed for missing, unsupported, incompatible, and stale Tool bindings', () => {
    expect(resolveToolLaunch(ASTRID_TOOL_CATALOG, TOOL_IDS.TRAVEL_BETWEEN_IMAGES)).toEqual({
      available: false, reason: 'missing-catalog-entry',
    });

    const current = ASTRID_TOOL_CATALOG.tools.find((entry) => entry.id === TOOL_IDS.VIDEO_EDITOR)!;
    const catalog = (entry: typeof current) => ({ schema_version: 1, tools: [entry] });
    expect(resolveToolLaunch(catalog({ ...current, compatibility: { host: '2' } }), TOOL_IDS.VIDEO_EDITOR)).toEqual({
      available: false, reason: 'incompatible-host',
    });
    expect(resolveToolLaunch(catalog({ ...current, release_sha256: 'stale' }), TOOL_IDS.VIDEO_EDITOR)).toEqual({
      available: false, reason: 'stale-or-invalid-release-binding',
    });
  });
});
