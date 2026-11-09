/**
 * The installer's run receipt (`last-run.json`, format astrid-last-run/v1), as the Runtime's diagnostics report
 * carries it on its "Last installer run (last-run.json): {...}" line. The Agent writes the receipt at the end of every
 * install, update and repair run; this page only reads it.
 */
import { isReleaseNumber } from './installedRelease.ts';

const LAST_RUN_FORMAT = 'astrid-last-run/v1';

interface LastRunReceipt {
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

interface LastUpdateNotice {
  readonly title: string;
  readonly body: string;
}

/**
 * "The last update didn't install anything": the receipt says not-updated and Astrid is still behind the served
 * release. Without a known reason (or with installer-bug) it is Astrid's problem; with one, the receipt's line says why.
 */
export function lastUpdateDidNothing(receipt: LastRunReceipt | null, installedRelease: number | undefined, servedRelease: number | undefined): LastUpdateNotice | null {
  if (!receipt || receipt.kind !== 'not-updated') return null;
  if (installedRelease === undefined || servedRelease === undefined || installedRelease >= servedRelease) return null;
  const still = `Astrid is still Release ${installedRelease}; Release ${servedRelease} is available.`;
  const bug = !receipt.reason || receipt.reason === 'installer-bug' || !receipt.reasonLine;
  return {
    title: "The last update didn't install anything",
    body: bug
      ? `${still} This is a problem in Astrid, not something you did. Your projects are safe. Send the diagnostics file to support so we can fix it.`
      : `${still} Why: ${receipt.reasonLine} Your projects are safe.`,
  };
}
