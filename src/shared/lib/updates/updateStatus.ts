import type { Health } from '@/integrations/runtime/generated.ts';
import type { UpdateResolutionInput } from './resolveUpdate.ts';

export interface UpdateStatus {
  readonly release: number;
  readonly app: string;
  readonly servedRelease: number;
  readonly servedApp: string;
  readonly behind: boolean;
  readonly resolution: UpdateResolutionInput;
}

function releaseNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Release information was invalid');
  return value as number;
}

async function readJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Update check returned HTTP ${response.status}`);
  const text = await boundedText(response, 16_384);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Update check response was invalid');
  return value as Record<string, unknown>;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error('Update check response was too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error('Update check response was too large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('Update check response was too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function checkHostedUpdate(health: Health, fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  const [build, manifest] = await Promise.all([readJson('/build.json', fetchImpl), readJson('/install-manifest.json', fetchImpl)]);
  if (typeof build.app !== 'string' || !build.app) throw new Error('App build information was invalid');
  const servedRelease = manifest.release === undefined ? 0 : releaseNumber(manifest.release);
  const installedRelease = health.release === undefined ? 0 : releaseNumber(health.release);
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
  const app = typeof __ASTRID_APP_BUILD__ === 'string' ? __ASTRID_APP_BUILD__ : build.app;
  return {
    release: installedRelease, app, servedRelease, servedApp: build.app, behind,
    resolution: { installedRelease, servedRelease,
      ...(requiredRelease === undefined ? {} : { requiredRelease, requiredReason }),
      releaseBehind: behind, updateNowAvailable: true },
  };
}

export async function checkLocalUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  const response = await fetchImpl('/__astrid/local-update-status', { method: 'POST', body: '', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Update check returned HTTP ${response.status}`);
  const text = await boundedText(response, 16_384);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Local launcher update status was invalid');
  const body = parsed as Record<string, unknown>;
  if (typeof body.app !== 'string' || !body.app || typeof body.servedApp !== 'string' || !body.servedApp || typeof body.behind !== 'boolean') {
    throw new Error('Local launcher update status was invalid');
  }
  const release = body.release === undefined ? 0 : releaseNumber(body.release);
  const servedRelease = body.servedRelease === undefined ? 0 : releaseNumber(body.servedRelease);
  const requiredRelease = body.requiredRelease === undefined ? undefined : releaseNumber(body.requiredRelease);
  const requiredReason = typeof body.requiredReason === 'string' ? body.requiredReason : undefined;
  return { release, app: body.app, servedRelease, servedApp: body.servedApp, behind: body.behind,
    resolution: { installedRelease: release, servedRelease, ...(requiredRelease === undefined ? {} : { requiredRelease, requiredReason }), releaseBehind: body.behind, updateNowAvailable: true } };
}
