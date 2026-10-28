import type { InstallerUpdateHealth } from '@/integrations/runtime/client.ts';
import type { UpdateResolutionInput } from './resolveUpdate.ts';
import { APP_BUILD, fetchBuildInfo } from './appBuildWatch.ts';
import { installedReleaseOf, isReleaseNumber } from './installedRelease.ts';

export interface UpdateStatus {
  readonly release: number;
  readonly app: string;
  readonly servedRelease: number;
  readonly servedApp: string;
  readonly behind: boolean;
  /** The Runtime's startup identity `managed_by` (`source`, `pinokio`, or null for a native install); null for the local launcher. */
  readonly managedBy: string | null;
  readonly resolution: UpdateResolutionInput;
}

function releaseNumber(value: unknown): number {
  if (!isReleaseNumber(value)) throw new Error('Release information was invalid');
  return value;
}

async function readManifest(fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl('/install-manifest.json', { cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Update check returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Update check response was invalid');
  return value as Record<string, unknown>;
}

export async function checkHostedUpdate(health: InstallerUpdateHealth, fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  const [build, manifest] = await Promise.all([fetchBuildInfo(fetchImpl), readManifest(fetchImpl)]);
  if (!build) throw new Error('App build information was invalid');
  const servedRelease = manifest.release === undefined ? 0 : releaseNumber(manifest.release);
  const installedRelease = installedReleaseOf(health) ?? 0;
  const manifestRequired = manifest.required;
  let requiredRelease: number | undefined;
  let requiredReason: string | undefined;
  if (manifestRequired !== undefined) {
    if (!manifestRequired || typeof manifestRequired !== 'object' || Array.isArray(manifestRequired)) throw new Error('Required update information was invalid');
    const required = manifestRequired as Record<string, unknown>;
    requiredRelease = releaseNumber(required.release);
    if (typeof required.reason !== 'string' || !required.reason.trim()) throw new Error('Required update information was invalid');
    requiredReason = required.reason;
  }
  const behind = installedRelease < servedRelease;
  const app = APP_BUILD || build.app;
  const managedBy = health.identity?.managed_by;
  return {
    release: installedRelease, app, servedRelease, servedApp: build.app, behind,
    managedBy: typeof managedBy === 'string' ? managedBy : null,
    resolution: { installedRelease, servedRelease,
      ...(requiredRelease === undefined ? {} : { requiredRelease, requiredReason }),
      releaseBehind: behind },
  };
}

export async function checkLocalUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  const response = await fetchImpl('/__astrid/local-update-status', { method: 'POST', body: '', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Update check returned HTTP ${response.status}`);
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Local launcher update status was invalid');
  const body = parsed as Record<string, unknown>;
  if (typeof body.app !== 'string' || !body.app || typeof body.servedApp !== 'string' || !body.servedApp || typeof body.behind !== 'boolean') {
    throw new Error('Local launcher update status was invalid');
  }
  const release = body.release === undefined ? 0 : releaseNumber(body.release);
  const servedRelease = body.servedRelease === undefined ? 0 : releaseNumber(body.servedRelease);
  const requiredRelease = body.requiredRelease === undefined ? undefined : releaseNumber(body.requiredRelease);
  const requiredReason = typeof body.requiredReason === 'string' ? body.requiredReason : undefined;
  return { release, app: body.app, servedRelease, servedApp: body.servedApp, behind: body.behind, managedBy: null,
    resolution: { installedRelease: release, servedRelease, ...(requiredRelease === undefined ? {} : { requiredRelease, requiredReason }), releaseBehind: body.behind } };
}
