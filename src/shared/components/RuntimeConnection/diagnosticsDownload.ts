import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { APP_BUILD, fetchBuildInfo } from '@/shared/lib/updates/appBuildWatch.ts';

/** Fetch the Runtime report and attach the App identity owned by the served App. */
export async function fetchDiagnosticsReport(fetchImpl: typeof fetch = fetch): Promise<string> {
  const [build, response] = await Promise.all([
    fetchBuildInfo(fetchImpl),
    fetchImpl(`${runtimeApiBase()}/v1/diagnostics`, { cache: 'no-store', headers: { Accept: 'application/json' } }),
  ]);
  if (!response.ok) throw new Error('Runtime could not provide diagnostics.');
  const payload = await response.json() as { report?: unknown };
  if (typeof payload.report !== 'string' || !payload.report.trim()) throw new Error('Runtime diagnostics response was invalid.');

  const report = payload.report.split(/\r?\n/).filter(line => !/^App (?:build|release): /.test(line));
  const appBuild = APP_BUILD || build?.app;
  if (appBuild) report.push(`App build: ${appBuild}`);
  if (build) report.push(`App release: ${build.release}`);
  return report.join('\n');
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
