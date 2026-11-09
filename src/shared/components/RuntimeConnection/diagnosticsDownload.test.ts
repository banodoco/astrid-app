import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/runtime/connection.ts', () => ({ runtimeApiBase: () => 'http://127.0.0.1:17340/api/runtime' }));
vi.mock('@/shared/lib/updates/appBuildWatch.ts', async (importOriginal) => ({ ...await importOriginal<object>(), APP_BUILD: '' }));

import { fetchDiagnosticsReport } from './diagnosticsDownload.ts';

const fixtures = path.resolve(__dirname, '../../lib/updates/__fixtures__');
/** The manifest this page serves, and the Runtime's own report for Hannah's state (Release 1, storage move complete). */
const servedManifest = readFileSync(path.join(fixtures, 'served-install-manifest.json'), 'utf8');
const runtimeReport = readFileSync(path.join(fixtures, 'hannah-not-updated.diagnostics.txt'), 'utf8');

const respond = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

function serve(manifest: string | null) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/build.json') return respond(JSON.stringify({ app: 'served-app-build', release: 10 }));
    if (url === '/install-manifest.json') return manifest === null ? new Response('missing', { status: 404 }) : respond(manifest);
    if (url.endsWith('/v1/diagnostics')) return respond(JSON.stringify({ report: runtimeReport }));
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

describe('the downloaded diagnostics file', () => {
  it('opens with the latest available release from the served manifest and the App release, above the Runtime report', async () => {
    const file = await fetchDiagnosticsReport(serve(servedManifest));
    const lines = file.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Latest available: 10', 'App release: 10', 'App build: served-app-build']);
    expect(lines[3]).toBe('');
    expect(lines[4]).toMatch(/^Astrid diagnostics: NOT OK\. Installed: Release 1\. Latest: Release 10\./);
    expect(file.match(/^Latest available:/gm)).toHaveLength(1);
    expect(file.match(/^App release:/gm)).toHaveLength(1);
  });

  it('says unknown when the served manifest cannot be read, and still returns the report', async () => {
    const file = await fetchDiagnosticsReport(serve(null));
    expect(file.split('\n').slice(0, 2)).toEqual(['Latest available: unknown', 'App release: 10']);
    expect(file).toContain('--- Raw detail ---');
  });
});
