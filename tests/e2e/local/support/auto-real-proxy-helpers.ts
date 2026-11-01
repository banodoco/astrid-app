/** Pure request observations shared by the automatic-placement successor gate. */
export const NATIVE_RUNTIME_COMMIT = /^\/api\/runtime\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
export const TASK_API_POST = /^\/api\/runtime\/v1\/(?:tasks(?:\/[^/]+\/(?:cancel|retry))?|managed-outputs\/[^/]+\/export)$/;
// Runtime's generated handshake and inspectTimeline operations are POST-shaped reads.
export const READ_ONLY_RUNTIME_POST = /^\/api\/runtime\/v1\/(?:handshake|projects\/[^/]+\/timelines\/[^/]+\/inspect)$/;
export const MEDIA_IMPORT_POST = /^\/api\/runtime\/v1\/projects\/[^/]+\/media-imports$/;
export const LEGACY_POST = /^\/api\/runtime\/.*$/;

export type RuntimePostKind = 'native-commit' | 'task-api' | 'read-only' | 'legacy-writer' | 'other';

export const EVIDENCE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
export type EvidenceMethod = typeof EVIDENCE_METHODS[number];

export const EVIDENCE_ROUTES = [
  'runtime-api',
  'runtime-operation',
  'runtime-workspace',
  'media-imports',
  'media-selection',
  'commit',
] as const;
export type EvidenceRoute = typeof EVIDENCE_ROUTES[number];

export function allowlistedEvidenceMethod(value: string): EvidenceMethod | undefined {
  return (EVIDENCE_METHODS as readonly string[]).includes(value) ? value as EvidenceMethod : undefined;
}

export function allowlistedEvidenceStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

export function relevantEvidenceRoute(rawUrl: string): EvidenceRoute | undefined {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  const { pathname } = url;
  if (pathname === '/runtime-config/v1/workspace.json') return 'runtime-workspace';
  if (pathname.startsWith('/runtime-config/v1/operation/')) return 'runtime-operation';
  if (pathname.startsWith('/api/runtime/')) return 'runtime-api';
  if (/\/media-imports$/.test(pathname)) return 'media-imports';
  if (/\/media-selection(?:\/verified)?$/.test(pathname)) return 'media-selection';
  if (/\/commit$/.test(pathname)) return 'commit';
  return undefined;
}

export function classifyRuntimePost(method: string, pathname: string): RuntimePostKind {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'other';
  if (method === 'POST') {
    if (MEDIA_IMPORT_POST.test(pathname)) return 'other';
    if (NATIVE_RUNTIME_COMMIT.test(pathname)) return 'native-commit';
    if (TASK_API_POST.test(pathname)) return 'task-api';
    if (READ_ONLY_RUNTIME_POST.test(pathname)) return 'read-only';
  }
  if (NATIVE_RUNTIME_COMMIT.test(pathname) || TASK_API_POST.test(pathname) || READ_ONLY_RUNTIME_POST.test(pathname)) return 'other';
  return LEGACY_POST.test(pathname) ? 'legacy-writer' : 'other';
}

export function normalRuntimeCommitPath(projectId: string, timelineId: string): string {
  return `/api/runtime/v1/projects/${encodeURIComponent(projectId)}/timelines/${encodeURIComponent(timelineId)}/commit`;
}

export function requireAuthoritativeHead(body: unknown): { revision_id: string; publication_id: string } {
  const candidate = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { head?: unknown }).head
    : undefined;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Runtime timeline history did not return an authoritative head pair');
  }
  const head = candidate as { revision_id?: unknown; publication_id?: unknown };
  if (typeof head.revision_id !== 'string' || !head.revision_id
    || typeof head.publication_id !== 'string' || !head.publication_id) {
    throw new Error('Runtime timeline history returned an incomplete authoritative head pair');
  }
  return { revision_id: head.revision_id, publication_id: head.publication_id };
}

export interface RuntimeRequestLike {
  method(): string;
  url(): string;
  postDataJSON(): unknown;
}

export function isExpectedInverseRequest(
  request: RuntimeRequestLike,
  projectId: string,
  timelineId: string,
  publicationId: string,
): boolean {
  if (request.method() !== 'POST') return false;
  let url: URL;
  let body: Record<string, unknown>;
  try {
    url = new URL(request.url());
    body = request.postDataJSON() as Record<string, unknown>;
  } catch { return false; }
  if (url.pathname !== normalRuntimeCommitPath(projectId, timelineId) || url.search || url.hash
    || !body || Array.isArray(body) || typeof body !== 'object'
    || typeof body.base_revision_id !== 'string' || !body.base_revision_id
    || typeof body.base_publication_id !== 'string' || !body.base_publication_id) return false;
  return JSON.stringify(body) === JSON.stringify({
    api_version: 1,
    project_id: projectId,
    timeline_id: timelineId,
    base_revision_id: body.base_revision_id,
    base_publication_id: body.base_publication_id,
    commands: [{
      schema_version: 1,
      op: 'timeline.inverse',
      version: '1',
      select: null,
      args: { publications: [publicationId] },
    }],
    source: { via: 'app' },
  });
}
