import { writeFile } from 'node:fs/promises';
import {
  MOUNTED_DIAGNOSTIC_MAX_RECORDS,
  projectMountedDiagnosticDetail,
  withDiagnosticDeadline,
  type MountedDiagnosticSnapshot,
} from './p1-diagnostic-safety.ts';

export type ReadonlyOutboxRead<T> =
  | { status: 'verified'; value: T }
  | { status: 'unknown'; reason: 'unavailable' | 'read-rejected' };

export type MountedBootstrapStage = 'context' | 'navigation' | 'connection' | 'selection' | 'outbox-read';

export type MountedBootstrapFailure = {
  stage: MountedBootstrapStage;
  code: 'mounted-bootstrap';
  class: 'mounted-bootstrap';
};

export class MountedBootstrapError extends Error {
  readonly failure: MountedBootstrapFailure;

  constructor(failure: MountedBootstrapFailure, cause: unknown) {
    super(`mounted baseline ${failure.stage} failed`, { cause });
    this.name = 'MountedBootstrapError';
    this.failure = failure;
  }
}

let lastMountedBootstrapFailure: MountedBootstrapFailure | undefined;

export function clearMountedBootstrapFailure(): void {
  lastMountedBootstrapFailure = undefined;
}

export function recordMountedBootstrapFailure(error: unknown): void {
  lastMountedBootstrapFailure = error instanceof MountedBootstrapError ? error.failure : undefined;
}

export function readMountedBootstrapFailure(): MountedBootstrapFailure | undefined {
  return lastMountedBootstrapFailure;
}

export async function readExistingReadonly<T>(
  databaseExists: () => Promise<boolean>,
  readExisting: () => Promise<T>,
): Promise<ReadonlyOutboxRead<T>> {
  try {
    if (!(await databaseExists())) return { status: 'unknown', reason: 'unavailable' };
  } catch {
    return { status: 'unknown', reason: 'unavailable' };
  }
  try {
    return { status: 'verified', value: await readExisting() };
  } catch {
    return { status: 'unknown', reason: 'read-rejected' };
  }
}

export type SettledOwner = { ownerId: string; pending?: unknown; intents: readonly unknown[] };

export function hasFreshSettledOwner(owners: readonly SettledOwner[], previousOwnerIds: ReadonlySet<string>): boolean {
  return owners.some((owner) => !previousOwnerIds.has(owner.ownerId) && !owner.pending && owner.intents.length === 0);
}

export function isFreshlyConnected(summary: { attached: boolean | 'UNKNOWN'; state: string }): boolean {
  return summary.attached === true && summary.state === 'connected';
}

export const MOUNTED_BOOTSTRAP_DIAGNOSTIC_FILE = 'mounted-bootstrap-lifecycle.json';
const MOUNTED_BOOTSTRAP_DIAGNOSTIC_TIMEOUT_MS = 500;
const MOUNTED_BOOTSTRAP_DIAGNOSTIC_READ_TIMEOUT_MS = 150;
const MOUNTED_BOOTSTRAP_DIAGNOSTIC_MAX_BYTES = 32 * 1024;
const UNKNOWN = 'UNKNOWN' as const;

export type MountedBootstrapDiagnosticTestInfo = {
  outputPath(...pathSegments: string[]): string;
  attach(name: string, options: { path: string; contentType: string }): Promise<void>;
};

type MountedBootstrapDiagnosticPage = {
  evaluate<T>(pageFunction: () => T): Promise<T>;
};

type MountedBootstrapDiagnosticArtifact = {
  version: 1;
  kind: 'mounted-bootstrap-lifecycle';
  status: 'captured' | 'UNKNOWN';
  lifecycle: { outcome: 'completed' | 'failed'; pageMounted: boolean; beforePageClose: true };
  diagnostics: MountedDiagnosticSnapshot | typeof UNKNOWN;
  losses: { read: boolean; write: boolean; records: boolean };
};

function emptyMountedBootstrapArtifact(outcome: 'completed' | 'failed', pageMounted: boolean): MountedBootstrapDiagnosticArtifact {
  return {
    version: 1,
    kind: 'mounted-bootstrap-lifecycle',
    status: UNKNOWN,
    lifecycle: { outcome, pageMounted, beforePageClose: true },
    diagnostics: UNKNOWN,
    losses: { read: true, write: false, records: true },
  };
}

function nonNegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value : 0;
}

function safeMountedBootstrapSnapshot(value: unknown): MountedDiagnosticSnapshot | typeof UNKNOWN {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return UNKNOWN;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.records)) return UNKNOWN;
  const records: Record<string, unknown>[] = [];
  for (const item of source.records.slice(0, MOUNTED_DIAGNOSTIC_MAX_RECORDS)) {
    const projected = projectMountedDiagnosticDetail(item);
    if (projected.accepted) records.push(projected.record);
  }
  return {
    status: records.length > 0 ? 'observed' : UNKNOWN,
    buffer: 'mounted-bootstrap',
    records,
    accepted: nonNegativeCount(source.accepted),
    rejected: nonNegativeCount(source.rejected),
    overflow: nonNegativeCount(source.overflow),
    listenerErrors: nonNegativeCount(source.listenerErrors),
  };
}

function serializeMountedBootstrapArtifact(artifact: MountedBootstrapDiagnosticArtifact): string {
  const text = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(text, 'utf8') <= MOUNTED_BOOTSTRAP_DIAGNOSTIC_MAX_BYTES) return text;
  return `${JSON.stringify({
    version: 1,
    kind: 'mounted-bootstrap-lifecycle',
    status: UNKNOWN,
    lifecycle: artifact.lifecycle,
    diagnostics: UNKNOWN,
    losses: { read: true, write: artifact.losses.write, records: true },
  })}\n`;
}

async function writeMountedBootstrapArtifact(
  testInfo: MountedBootstrapDiagnosticTestInfo,
  artifact: MountedBootstrapDiagnosticArtifact,
  deadline: number,
  attach: boolean,
): Promise<boolean> {
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const output = testInfo.outputPath(MOUNTED_BOOTSTRAP_DIAGNOSTIC_FILE);
    const wrote = await withDiagnosticDeadline(
      async () => { await writeFile(output, serializeMountedBootstrapArtifact(artifact), { encoding: 'utf8', mode: 0o600 }); return true; },
      false,
      Math.min(remaining, MOUNTED_BOOTSTRAP_DIAGNOSTIC_TIMEOUT_MS),
    );
    if (!wrote) return false;
    if (!attach) return true;
    const attachRemaining = deadline - Date.now();
    if (attachRemaining <= 0) return false;
    const attached = await withDiagnosticDeadline(
      async () => { await testInfo.attach(MOUNTED_BOOTSTRAP_DIAGNOSTIC_FILE, { path: output, contentType: 'application/json' }); return true; },
      false,
      Math.min(attachRemaining, MOUNTED_BOOTSTRAP_DIAGNOSTIC_TIMEOUT_MS),
    );
    return attached;
  } catch {
    return false;
  }
}

/** Retain the opt-in producer's safe page snapshot before the bootstrap page is closed. */
export async function retainMountedBootstrapDiagnostics(
  testInfo: MountedBootstrapDiagnosticTestInfo,
  page: MountedBootstrapDiagnosticPage | undefined,
  outcome: 'completed' | 'failed',
): Promise<void> {
  try {
    const deadline = Date.now() + MOUNTED_BOOTSTRAP_DIAGNOSTIC_TIMEOUT_MS;
    const initial = emptyMountedBootstrapArtifact(outcome, page !== undefined);
    const earlyWrite = await writeMountedBootstrapArtifact(testInfo, initial, deadline, false);
    if (!page || Date.now() >= deadline) return;
    const raw = await withDiagnosticDeadline(
      () => page.evaluate(() => {
        try {
          const snapshot = (window as Window & { __timelineSaveDiagnosticsSnapshot?: () => unknown }).__timelineSaveDiagnosticsSnapshot;
          return typeof snapshot === 'function' ? snapshot() : 'UNKNOWN';
        } catch {
          return 'UNKNOWN';
        }
      }),
      UNKNOWN,
      Math.min(MOUNTED_BOOTSTRAP_DIAGNOSTIC_READ_TIMEOUT_MS, deadline - Date.now()),
    );
    const diagnostics = safeMountedBootstrapSnapshot(raw);
    const enriched: MountedBootstrapDiagnosticArtifact = {
      version: 1,
      kind: 'mounted-bootstrap-lifecycle',
      status: diagnostics === UNKNOWN ? UNKNOWN : 'captured',
      lifecycle: { outcome, pageMounted: true, beforePageClose: true },
      diagnostics,
      losses: { read: diagnostics === UNKNOWN, write: !earlyWrite, records: diagnostics === UNKNOWN },
    };
    await writeMountedBootstrapArtifact(testInfo, enriched, deadline, true);
  } catch {
    // Diagnostic collection is disposable and must not replace the bootstrap result.
  }
}
