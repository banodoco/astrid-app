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
  if (typeof payload.report !== 'string') throw new Error('Runtime diagnostics response was invalid.');

  const report = payload.report.split(/\r?\n/).filter(line => !/^App (?:build|release): /.test(line));
  const appBuild = APP_BUILD || build?.app;
  if (appBuild) report.push(`App build: ${appBuild}`);
  if (build) report.push(`App release: ${build.release}`);
  return report.join('\n');
}
