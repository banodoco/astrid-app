/**
 * The installer's run receipt (`last-run.json`, format astrid-last-run/v1), as the Runtime's diagnostics report
 * carries it on its "Last installer run (last-run.json): {...}" line. The Agent writes the receipt at the end of every
 * install, update and repair run; this page only reads it.
 */
import { FIRST_SELF_UPDATE_RELEASE, INSTALLER_UPDATE_REASON_MESSAGES } from '@/integrations/runtime/installerUpdateReasons.ts';
import { isReleaseNumber } from './installedRelease.ts';

const LAST_RUN_FORMAT = 'astrid-last-run/v1';

export interface LastRunReceipt {
  readonly kind: 'updated' | 'already-current' | 'repaired' | 'not-updated' | 'failed' | 'rolled-back' | string;
  readonly still?: number;
  readonly start?: number;
  readonly target?: number;
  readonly reason?: string | null;
  readonly reasonLine?: string | null;
}

const LINE = /^Last installer run \(last-run\.json\): (\{.*\})$/m;

/** The receipt in a diagnostics report, or null when the report has none (older Runtimes and Agents). */
export function lastRunFromReport(report: string): LastRunReceipt | null {
  const match = report.match(LINE);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.format !== LAST_RUN_FORMAT || typeof record.kind !== 'string') return null;
  const release = (key: string) => isReleaseNumber(record[key]) ? record[key] as number : undefined;
  return {
    kind: record.kind,
    still: release('still'),
    start: release('start'),
    target: release('target'),
    reason: typeof record.reason === 'string' ? record.reason : null,
    reasonLine: typeof record.reason_line === 'string' ? record.reason_line : null,
  };
}

/** The command a receipt's row offers: the update command to try again, the plain install line to repair, or none. */
export type LastRunCommand = 'update' | 'repair' | null;

export interface LastRunNotice {
  readonly title: string;
  readonly body: string;
  readonly command: LastRunCommand;
}

/**
 * The App's own line for each receipt reason. The Agent's `reason_line` is written for the terminal ("the message above
 * says why", "the install line"), so this page never shows it; a reason it does not know reads as an error.
 */
const REASON_LINES: Readonly<Record<string, string>> = {
  'self-update-too-old': `releases before ${FIRST_SELF_UPDATE_RELEASE} can't update from this page, so this one update needs the command.`,
  busy: 'Astrid or another installer was busy.',
  'pinokio-managed': "this Astrid is managed by Pinokio; use Pinokio's Update button.",
  'source-checkout': 'this Astrid runs from source checkouts; update those instead.',
  'consent-required': 'setup needed your consent, so it stopped before changing anything.',
  declined: 'setup was declined, so nothing was changed.',
  'recovered-previous-version': 'an earlier update was interrupted and Astrid restored the version before it.',
  'runtime-not-running': 'the new release was installed, but the running Astrid did not restart onto it.',
  refused: 'the installer stopped before changing anything.',
  error: 'the update stopped with an error.',
};
const ERROR_LINE = REASON_LINES.error;
/** Reasons whose one next action is not the installer's command. */
const NO_COMMAND: ReadonlySet<string> = new Set(['pinokio-managed', 'source-checkout']);

/**
 * The row for the last terminal run's receipt (review 4a), while Astrid is still behind the served release: what
 * happened with the release numbers, whether the projects are safe, and the one next action. Every row also offers
 * Download diagnostics. A successful receipt, or one Astrid has since moved past, has no row.
 */
export function lastRunNotice(receipt: LastRunReceipt | null, installedRelease: number | undefined, servedRelease: number | undefined): LastRunNotice | null {
  if (!receipt || (receipt.kind !== 'not-updated' && receipt.kind !== 'failed' && receipt.kind !== 'rolled-back')) return null;
  if (installedRelease === undefined || servedRelease === undefined || installedRelease >= servedRelease) return null;
  const reason = receipt.reason ?? null;
  const unchanged = `Astrid is still Release ${installedRelease} and your projects are unchanged.`;
  if (reason === 'disk-space') {
    return {
      title: 'Not enough disk space to update',
      body: `${unchanged} There isn't enough free disk space for the update. Old Astrid versions may be using some of it; the next successful update removes the ones it no longer needs. Free up space, then try again.`,
      command: 'update',
    };
  }
  if (reason === 'other-runtime-running') {
    return {
      title: 'Two copies of Astrid are running',
      body: 'An older copy of Astrid started again alongside this one. Run the repair command to stop it; it keeps your projects.',
      command: 'repair',
    };
  }
  if (reason === 'needs-repair') {
    return {
      title: 'Astrid needs a quick repair',
      body: `Something on this computer is out of step with Release ${installedRelease}. The repair command fixes it and keeps your projects.`,
      command: 'repair',
    };
  }
  if (reason === 'windows-upgrade-unsupported') {
    return {
      title: "This update can't install on this computer yet",
      body: `Astrid is still Release ${installedRelease} and your projects are safe. ${INSTALLER_UPDATE_REASON_MESSAGES['windows-upgrade-unsupported']}`,
      command: null,
    };
  }
  const command: LastRunCommand = reason && NO_COMMAND.has(reason) ? null : 'update';
  if (receipt.kind === 'rolled-back' || receipt.kind === 'failed') {
    const target = receipt.target ?? servedRelease;
    const line = receipt.kind === 'rolled-back' ? "the new version didn't start." : (reason && REASON_LINES[reason]) || ERROR_LINE;
    return {
      title: `The update to Release ${target} didn't finish`,
      body: receipt.kind === 'rolled-back'
        ? `Astrid went back to Release ${installedRelease} and your projects are unchanged. Reason: ${line}`
        : `${unchanged} Reason: ${line}`,
      command,
    };
  }
  // not-updated. Without a known reason (or with installer-bug) it is Astrid's problem; with one, its line says why.
  const still = `Astrid is still Release ${installedRelease}; Release ${servedRelease} is available.`;
  const line = reason && reason !== 'installer-bug' ? REASON_LINES[reason] : undefined;
  // A runtime that did not restart onto an installed release is a change: the title must not say nothing was installed.
  const title = reason === 'runtime-not-running' ? "The new release is installed; Astrid hasn't restarted onto it" : "The last update didn't install anything";
  return {
    title,
    body: line
      ? `${still} Why: ${line} Your projects are safe.`
      : `${still} This is a problem in Astrid, not something you did. Your projects are safe. Send the diagnostics file to support so we can fix it.`,
    command,
  };
}
