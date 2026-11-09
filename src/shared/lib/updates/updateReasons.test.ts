import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_SELF_UPDATE_RELEASE, INSTALLER_UPDATE_REASON_MESSAGES, type InstallerUpdateReason } from '@/integrations/runtime/installerUpdateReasons.ts';
import { resolveUpdate } from './resolveUpdate.ts';
import { installerUpdateLine, installerUpdateReasonOf, installerUpdateStatusMessage } from './updateOperation.ts';
import { lastRunFromReport, lastRunNotice } from './lastRun.ts';

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
  it('Hannah, receipt not-updated (installer-bug): says so and points to diagnostics, with the update command to try again', () => {
    const receipt = lastRunFromReport(report('hannah-not-updated'));
    expect(receipt).toMatchObject({ kind: 'not-updated', still: 1, start: 1, target: 10, reason: 'installer-bug' });
    expect(lastRunNotice(receipt, 1, 10)).toEqual({
      title: "The last update didn't install anything",
      body: 'Astrid is still Release 1; Release 10 is available. This is a problem in Astrid, not something you did. Your projects are safe. Send the diagnostics file to support so we can fix it.',
      command: 'update',
    });
  });

  it('a not-updated receipt with a reason of its own gives that reason in plain words', () => {
    expect(lastRunNotice(receiptOf({ kind: 'not-updated', reason: 'busy', reason_line: 'Astrid or another installer is busy; try again when it finishes.' }), 1, 10)).toEqual({
      title: "The last update didn't install anything",
      body: 'Astrid is still Release 1; Release 10 is available. Why: Astrid or another installer was busy. Your projects are safe.',
      command: 'update',
    });
  });

  it('says nothing without a receipt, after a successful update, or once Astrid is current', () => {
    expect(lastRunFromReport(report('hannah-before-receipt'))).toBeNull();
    expect(lastRunNotice(lastRunFromReport(report('normalised-updated')), 10, 10)).toBeNull();
    expect(lastRunFromReport(report('normalised-updated'))).toMatchObject({ kind: 'updated', start: 1, still: 10 });
    expect(lastRunNotice(lastRunFromReport(report('hannah-not-updated')), 10, 10)).toBeNull();
    expect(lastRunNotice(receiptOf({ kind: 'rolled-back', reason: 'error' }), 11, 11)).toBeNull();
    expect(lastRunFromReport('Last update result: rolled_back\nInstaller transaction log:\n')).toBeNull();
  });
});

/** A diagnostics report carrying one receipt, as the Runtime prints it. */
function receiptOf(fields: Record<string, unknown>) {
  return lastRunFromReport(`Astrid diagnostics\nLast installer run (last-run.json): ${JSON.stringify({ format: 'astrid-last-run/v1', mode: 'update', start: 10, still: 10, target: 11, exit_code: 1, ...fields })}\n`);
}

describe('every receipt from a terminal run has its row and its next action (review 4a)', () => {
  const BACKEND = /R0|R1|handoff|back-end|backend|realm|the message above|install line/;

  it('failed: the update did not finish, Astrid is still the earlier release, the reason, and the update command to try again', () => {
    expect(lastRunNotice(receiptOf({ kind: 'failed', reason: 'error', reason_line: 'the run stopped with an error; the message above says why.' }), 10, 11)).toEqual({
      title: "The update to Release 11 didn't finish",
      body: 'Astrid is still Release 10 and your projects are unchanged. Reason: the update stopped with an error.',
      command: 'update',
    });
  });

  it('rolled-back: Astrid went back, the reason, and the update command to try again', () => {
    expect(lastRunNotice(receiptOf({ kind: 'rolled-back', reason: 'error' }), 10, 11)).toEqual({
      title: "The update to Release 11 didn't finish",
      body: "Astrid went back to Release 10 and your projects are unchanged. Reason: the new version didn't start.",
      command: 'update',
    });
  });

  it.each(['not-updated', 'failed'])('disk-space (%s): not enough disk space, free up space, then try again', (kind) => {
    expect(lastRunNotice(receiptOf({ kind, reason: 'disk-space', reason_line: "there isn't enough free disk space for the update." }), 10, 11)).toEqual({
      title: 'Not enough disk space to update',
      body: "Astrid is still Release 10 and your projects are unchanged. There isn't enough free disk space for the update. Old Astrid versions may be using some of it; the next successful update removes the ones it no longer needs. Free up space, then try again.",
      command: 'update',
    });
  });

  it("Hannah's disk-space receipt reads as the disk row", () => {
    expect(lastRunNotice(lastRunFromReport(report('hannah-not-updated-disk-space')), 1, 10)?.title).toBe('Not enough disk space to update');
  });

  it('two copies running: the repair command, which keeps the projects', () => {
    expect(lastRunNotice(receiptOf({ kind: 'not-updated', reason: 'other-runtime-running', exit_code: 3 }), 10, 11)).toEqual({
      title: 'Two copies of Astrid are running',
      body: 'An older copy of Astrid started again alongside this one. Run the repair command to stop it; it keeps your projects.',
      command: 'repair',
    });
  });

  it('needs repair: the repair command', () => {
    expect(lastRunNotice(receiptOf({ kind: 'failed', reason: 'needs-repair' }), 10, 11)).toEqual({
      title: 'Astrid needs a quick repair',
      body: 'Something on this computer is out of step with Release 10. The repair command fixes it and keeps your projects.',
      command: 'repair',
    });
  });

  it('windows-upgrade-unsupported: no command to try again, only diagnostics', () => {
    expect(lastRunNotice(receiptOf({ kind: 'failed', reason: 'windows-upgrade-unsupported' }), 10, 11)).toEqual({
      title: "This update can't install on this computer yet",
      body: `Astrid is still Release 10 and your projects are safe. ${INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported']}`,
      command: null,
    });
  });

  it('Pinokio and source receipts offer no installer command', () => {
    expect(lastRunNotice(receiptOf({ kind: 'not-updated', reason: 'pinokio-managed' }), 10, 11)?.command).toBeNull();
    expect(lastRunNotice(receiptOf({ kind: 'not-updated', reason: 'source-checkout' }), 10, 11)?.command).toBeNull();
  });

  const kinds = ['not-updated', 'failed', 'rolled-back'];
  const reasons = ['self-update-too-old', 'disk-space', 'busy', 'needs-repair', 'other-runtime-running', 'windows-upgrade-unsupported', 'pinokio-managed', 'source-checkout',
    'consent-required', 'declined', 'recovered-previous-version', 'runtime-not-running', 'refused', 'error', 'installer-bug', 'a-reason-from-a-newer-agent', null];
  it.each(kinds.flatMap((kind) => reasons.map((reason) => [kind, reason] as const)))('%s / %s: plain words, never the generic line', (kind, reason) => {
    const notice = lastRunNotice(receiptOf({ kind, reason, reason_line: 'the message above says why; R1 handoff back-end.' }), 10, 11);
    expect(notice).not.toBeNull();
    expect(`${notice!.title} ${notice!.body}`).not.toMatch(BACKEND);
    expect(notice!.body).not.toContain(GENERIC);
    expect(notice!.body).not.toContain('Run the command below');
  });
});

describe('windows-upgrade-unsupported (reported by the Runtime in update status)', () => {
  const status = { available: true, state: 'none' as const, reason: 'windows-upgrade-unsupported', self_update: true };
  it('is its own reason with its own line: no command, Download diagnostics instead', () => {
    expect(installerUpdateReasonOf(status)).toBe('windows-upgrade-unsupported');
    expect(installerUpdateStatusMessage(status)).toBe(INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported']);
    expect(INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported']).toMatch(/Download diagnostics/);
    expect(INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported']).not.toMatch(/Run the command|try again/i);
  });

  it('resolves to a notice with no command and no Update now, never the generic line', () => {
    for (const context of ['page', 'settings'] as const) {
      const resolution = resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 11, releaseBehind: true, updateReason: 'windows-upgrade-unsupported', updateNowAvailable: true, selfUpdate: true }, context);
      expect(resolution).toMatchObject({ updateReason: 'windows-upgrade-unsupported', body: INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported'], primary: null, secondary: null });
      expect(JSON.stringify(resolution)).not.toContain(GENERIC);
    }
  });

  it('is not replaced by self-update-too-old on an old release', () => {
    expect(resolveUpdate({ ...HANNAH, updateReason: 'windows-upgrade-unsupported' }, 'settings').updateReason).toBe('windows-upgrade-unsupported');
  });
});
