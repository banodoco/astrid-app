import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { APP_BUILD, fetchBuildInfo } from '@/shared/lib/updates/appBuildWatch.ts';
import { isReleaseNumber } from '@/shared/lib/updates/installedRelease.ts';
import { localUpdateStatus } from '@/shared/lib/updates/pageUpdateStatus.ts';
import { checkLocalUpdate } from '@/shared/lib/updates/updateStatus.ts';

/**
 * The served manifest's release, or null when it cannot be read; the file then says unknown rather than failing.
 * A local checkout's own /install-manifest.json is the checkout's release, so there the launcher's status, which
 * reads astrid.haus, names the served release.
 */
async function servedRelease(fetchImpl: typeof fetch): Promise<number | null> {
  try {
    if (localUpdateStatus()) {
      const release = (await checkLocalUpdate(fetchImpl)).servedRelease;
      return isReleaseNumber(release) && release > 0 ? release : null;
    }
    const response = await fetchImpl('/install-manifest.json', { cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    const release = value && typeof value === 'object' && !Array.isArray(value) ? (value as { release?: unknown }).release : undefined;
    return isReleaseNumber(release) ? release : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the Runtime report and put the App's own facts above it: the latest release this page serves and the App's
 * release and build. The Runtime cannot read the served manifest, so these lines are the App's to write.
 */
export async function fetchDiagnosticsReport(fetchImpl: typeof fetch = fetch): Promise<string> {
  const [build, latest, response] = await Promise.all([
    fetchBuildInfo(fetchImpl),
    servedRelease(fetchImpl),
    fetchImpl(`${runtimeApiBase()}/v1/diagnostics`, { cache: 'no-store', headers: { Accept: 'application/json' } }),
  ]);
  if (!response.ok) throw new Error('Runtime could not provide diagnostics.');
  const payload = await response.json() as { report?: unknown };
  if (typeof payload.report !== 'string' || !payload.report.trim()) throw new Error('Runtime diagnostics response was invalid.');

  const report = payload.report.split(/\r?\n/).filter(line => !/^(?:App (?:build|release)|Latest available): /.test(line));
  const appBuild = APP_BUILD || build?.app;
  const header = [
    `Latest available: ${latest ?? 'unknown'}`,
    `App release: ${build ? build.release : 'unknown'}`,
    ...(appBuild ? [`App build: ${appBuild}`] : []),
    '',
  ];
  return [...header, ...report].join('\n');
}

/** Saves a diagnostics report as the astrid-diagnostics.txt download. */
export function saveDiagnosticsReport(report: string): void {
  const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'astrid-diagnostics.txt';
  link.hidden = true;
  // Browsers such as Firefox only start a download from an anchor that is in the document.
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoking synchronously can cancel the download before the browser starts it.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
