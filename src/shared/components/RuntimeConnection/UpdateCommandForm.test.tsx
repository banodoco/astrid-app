// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ platform: 'mac' as 'mac' | 'windows' | 'linux', clipboard: vi.fn(async (_text: string) => true) }));
vi.mock('@/shared/hooks/platformInstall/platformDetection.ts', async (importOriginal) => ({
  ...await importOriginal<object>(), detectPlatform: () => mocks.platform,
}));
vi.mock('@/shared/lib/browser/clipboard.ts', () => ({ writeClipboardTextSafe: mocks.clipboard }));
// A hosted astrid.haus page: the update line is the installer's --update command. A local App shows npm run update.
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => 'https://astrid.test',
}));

import { resolveUpdate, type UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import type { InstallerUpdateView } from '@/shared/lib/updates/useInstallerUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';
import { ASTRID_COMMANDS } from './copy.ts';

/**
 * The one-command copy for each state, on each desktop platform: what the command row shows and what every copy
 * button puts on the clipboard, the "Copy instructions for your agent" brief included.
 */
const PLAIN = /curl -fsSL https:\/\/astrid\.haus\/install \| sh(?! -s -- --update)|irm https:\/\/astrid\.haus\/install\.ps1 \| iex/;
const UPDATE_FORMS = { mac: ASTRID_COMMANDS.macLinuxUpdate, linux: ASTRID_COMMANDS.macLinuxUpdate, windows: ASTRID_COMMANDS.windowsUpdate } as const;

const idle = { available: false, pending: false, fresh: true, error: null, installType: 'installer', status: { available: true, state: 'none' }, start: vi.fn() } as unknown as InstallerUpdateView;
const failed = { ...idle, status: { available: true, self_update: true, state: 'terminal', outcome: 'failed', operation_id: 'op-1', result: 'failed' } } as unknown as InstallerUpdateView;

const behind = { installType: 'installer', installedRelease: 10, servedRelease: 11, releaseBehind: true, updateNowAvailable: false } as const;
/** Hannah's state: Release 1 after a finished storage move, Release 10 served, no self_update. */
const hannah = { installType: 'installer', installedRelease: 1, servedRelease: 10, releaseBehind: true, updateNowAvailable: false } as const;

/** Every state that offers an update with the command. */
const UPDATE_STATES: ReadonlyArray<readonly [string, UpdateResolution]> = [
  ['update available', resolveUpdate(behind, 'settings')],
  ['required update', resolveUpdate({ ...behind, requiredRelease: 11, requiredReason: 'security fix' }, 'settings')],
  ['schema mismatch', resolveUpdate({ ...behind, compatibility: { kind: 'schema', detail: 'Update Astrid to use this page.' } }, 'settings')],
  ['mid-session schema mismatch', resolveUpdate({ ...behind, midSessionSchemaMismatch: true }, 'settings')],
  ['recovery needed without in-app update', resolveUpdate({ ...behind, updateReason: 'recovery-needed' }, 'settings')],
  ['self-update-unavailable', resolveUpdate({ ...behind, updateReason: 'self-update-unavailable' }, 'settings')],
  ['self-update-too-old (Hannah)', resolveUpdate(hannah, 'settings')],
  ['self-update-too-old, required', resolveUpdate({ ...hannah, requiredRelease: 10, requiredReason: 'security fix' }, 'settings')],
  ['self-update-too-old on the page', resolveUpdate({ ...hannah, requiredRelease: 10, requiredReason: 'security fix' }, 'page')],
];

/** The repair states: needs-repair, autostart off (its setup line respects the saved choice) and a failed in-app update. */
const REPAIR_STATES: ReadonlyArray<readonly [string, UpdateResolution, InstallerUpdateView]> = [
  ['needs repair', resolveUpdate({ ...behind, updateReason: 'needs-repair' }, 'settings'), idle],
  ['failed in-app update', resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 10 }, 'settings'), failed],
];

/** The command rows shown and everything each copy button writes to the clipboard. */
async function commandTexts(resolution: UpdateResolution, operation: InstallerUpdateView): Promise<string[]> {
  mocks.clipboard.mockClear();
  render(<UpdateResolutionActions resolution={resolution} operation={operation} context="settings" />);
  const shown = screen.queryAllByRole('code').map((node) => node.textContent ?? '');
  const buttons = screen.queryAllByRole('button').filter((button) => /copy/i.test(`${button.textContent} ${button.getAttribute('aria-label') ?? ''}`));
  for (const button of buttons) fireEvent.click(button);
  await waitFor(() => expect(mocks.clipboard).toHaveBeenCalledTimes(buttons.length));
  const copied = mocks.clipboard.mock.calls.map(([text]) => text);
  cleanup();
  return [...shown, ...copied];
}

afterEach(() => { mocks.platform = 'mac'; });

describe.each(['mac', 'linux', 'windows'] as const)('one-command copy on %s', (platform) => {
  it.each(UPDATE_STATES)('%s: the command and the agent brief use --update and never the plain install line', async (_name, resolution) => {
    mocks.platform = platform;
    const texts = await commandTexts(resolution, idle);
    // At least the shown command, the copied command and the agent brief.
    expect(texts.length).toBeGreaterThanOrEqual(3);
    expect(texts.some((text) => text.includes('Please update my existing Astrid installation'))).toBe(true);
    expect(texts.some((text) => text === UPDATE_FORMS[platform])).toBe(true);
    for (const text of texts) {
      expect(text).toContain('--update');
      expect(text).not.toMatch(PLAIN);
    }
  });

  it.each(REPAIR_STATES)('%s: the plain install line, which is the only place it appears', async (_name, resolution, operation) => {
    mocks.platform = platform;
    const texts = await commandTexts(resolution, operation);
    expect(texts.some((text) => PLAIN.test(text))).toBe(true);
    for (const text of texts) expect(text).not.toContain('--update');
  });
});
