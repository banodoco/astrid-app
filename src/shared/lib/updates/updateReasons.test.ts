import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_SELF_UPDATE_RELEASE, INSTALLER_UPDATE_REASON_MESSAGES, type InstallerUpdateReason } from '@/integrations/runtime/installerUpdateReasons.ts';
import { resolveUpdate } from './resolveUpdate.ts';
import { installerUpdateLine } from './updateOperation.ts';
import { lastRunFromReport, lastUpdateDidNothing } from './lastRun.ts';

/** Reports produced by the Runtime's diagnostics_report from the field states in astrid-runtime tests/fixtures/field_states.json. */
const report = (name: string) => readFileSync(path.resolve(__dirname, '__fixtures__', `${name}.diagnostics.txt`), 'utf8');
const GENERIC = INSTALLER_UPDATE_REASON_MESSAGES['self-update-unavailable'];

/** Hannah's Mac on 8 Nov 2026: Release 1 after a finished storage move, Release 10 served, no self_update. */
const HANNAH = { installType: 'installer', installedRelease: 1, servedRelease: 10, releaseBehind: true, updateNowAvailable: false } as const;

describe('self-update-too-old', () => {
  it('is derived for Hannah\'s state and shows its copy: what happened, that projects are kept, and the one command', () => {
    for (const context of ['page', 'settings'] as const) {
      const resolution = resolveUpdate(HANNAH, context);
      expect(resolution.updateReason).toBe('self-update-too-old');
      expect(resolution.title).toBe('Release 10 is ready');
      expect(resolution.body).toBe("You have Release 1. Releases before 10 can't update from this page, so this one update needs a command. It keeps your projects. After it, future updates are one click here.");
      expect(JSON.stringify(resolution)).not.toContain(GENERIC);
    }
    expect(resolveUpdate(HANNAH, 'settings')).toMatchObject({ primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' } });
  });

  it('replaces the generic fallback reason, and a status Runtime 1 cannot give (self_update missing)', () => {
    expect(resolveUpdate({ ...HANNAH, updateReason: 'self-update-unavailable' }, 'settings').updateReason).toBe('self-update-too-old');
    expect(resolveUpdate({ ...HANNAH, selfUpdate: undefined }, 'settings').updateReason).toBe('self-update-too-old');
  });

  it('is not derived when the Runtime reports self_update, from the first self-updating release, or when nothing is behind', () => {
    expect(resolveUpdate({ ...HANNAH, selfUpdate: true }, 'settings').updateReason).toBeUndefined();
    expect(resolveUpdate({ ...HANNAH, installedRelease: FIRST_SELF_UPDATE_RELEASE, servedRelease: 11 }, 'settings').updateReason).toBeUndefined();
    expect(resolveUpdate({ ...HANNAH, servedRelease: 1, releaseBehind: false }, 'settings').card).toBe('none');
    expect(resolveUpdate({ ...HANNAH, installType: 'pinokio' }, 'settings').updateReason).toBeUndefined();
  });

  it('keeps a reason the Runtime reported', () => {
    expect(resolveUpdate({ ...HANNAH, updateReason: 'busy' }, 'settings')).toMatchObject({ updateReason: 'busy', body: INSTALLER_UPDATE_REASON_MESSAGES.busy });
  });

  it('keeps a required update first, with the too-old line after its reason', () => {
    const resolution = resolveUpdate({ ...HANNAH, requiredRelease: 10, requiredReason: 'security fix' }, 'page');
    expect(resolution).toMatchObject({ card: 'update', title: 'Release 10 is ready', updateReason: 'self-update-too-old', primary: { label: 'Copy instructions for your agent' } });
    expect(resolution.body).toMatch(/^This update is required: security fix You have Release 1\. Releases before 10/);
  });
});

describe('every reason maps to its own line, never the generic one', () => {
  const reasons = Object.keys(INSTALLER_UPDATE_REASON_MESSAGES).filter((reason) => reason !== 'self-update-unavailable' && reason !== 'self-update-too-old') as InstallerUpdateReason[];
  it.each(reasons)('%s', (updateReason) => {
    const resolution = resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 11, releaseBehind: true, updateReason, updateNowAvailable: false }, 'settings');
    expect(resolution.updateReason).toBe(updateReason);
    if (resolution.body !== null) expect(resolution.body).toBe(INSTALLER_UPDATE_REASON_MESSAGES[updateReason]);
    expect(JSON.stringify(resolution)).not.toContain(GENERIC);
  });

  it('the generic line appears only when no reason exists', () => {
    expect(resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 11, releaseBehind: true, updateReason: 'self-update-unavailable', updateNowAvailable: false }, 'settings').body).toBe(GENERIC);
  });

  it('drops an operation status that only gives the generic line when a real reason was resolved', () => {
    const status = { available: true, state: 'none' as const, reason: 'unknown-code' };
    expect(installerUpdateLine(status)).toBe(GENERIC);
    expect(installerUpdateLine(status, 'self-update-too-old')).toBeNull();
    expect(installerUpdateLine({ available: true, state: 'none', reason: 'busy' }, 'self-update-too-old')).toBe(INSTALLER_UPDATE_REASON_MESSAGES.busy);
  });
});

describe('the last update did nothing (run receipt in diagnostics)', () => {
  it('Hannah, receipt not-updated (installer-bug): says so and points to diagnostics', () => {
    const receipt = lastRunFromReport(report('hannah-not-updated'));
    expect(receipt).toMatchObject({ kind: 'not-updated', still: 1, start: 1, target: 10, reason: 'installer-bug' });
    expect(lastUpdateDidNothing(receipt, 1, 10)).toEqual({
      title: "The last update didn't install anything",
      body: 'Astrid is still Release 1; Release 10 is available. This is a problem in Astrid, not something you did. Your projects are safe. Send the diagnostics file to support so we can fix it.',
    });
  });

  it('a not-updated receipt with its own reason gives that reason', () => {
    const receipt = lastRunFromReport(report('hannah-not-updated-disk-space'));
    expect(lastUpdateDidNothing(receipt, 1, 10)?.body).toBe("Astrid is still Release 1; Release 10 is available. Why: there isn't enough free disk space for the update. Your projects are safe.");
  });

  it('says nothing without a receipt, after a successful update, or once Astrid is current', () => {
    expect(lastRunFromReport(report('hannah-before-receipt'))).toBeNull();
    expect(lastUpdateDidNothing(lastRunFromReport(report('normalised-updated')), 10, 10)).toBeNull();
    expect(lastRunFromReport(report('normalised-updated'))).toMatchObject({ kind: 'updated', start: 1, still: 10 });
    expect(lastUpdateDidNothing(lastRunFromReport(report('hannah-not-updated')), 10, 10)).toBeNull();
    expect(lastRunFromReport('Last update result: rolled_back\nInstaller transaction log:\n')).toBeNull();
  });
});
