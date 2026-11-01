/**
 * The real-daemon response fixtures and the one
 * helper every consumer needs: turning the Runtime's normalized placeholders
 * ("<task_id>", "<digest>", ...) back into schema-valid example values.
 *
 * Current fixtures are pinned by `runtime.lock.json`; the pre-D39 publish
 * recording remains unchanged for historical tests. Never edit these recordings.
 */

export type RecordedResponse = {
  case: string;
  request: { method: string; path: string; body: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

const files = import.meta.glob('../integrations/runtime/fixtures/responses/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, RecordedResponse>;

export const RECORDED_RESPONSES: Record<string, RecordedResponse> = Object.fromEntries(
  Object.values(files).map((fixture) => [fixture.case, fixture]),
);

export function recorded(name: string): RecordedResponse {
  const fixture = RECORDED_RESPONSES[name];
  if (!fixture) throw new Error(`no recorded response named ${name}`);
  return fixture;
}

const HEX_64 = 'd'.repeat(64);

/** Every placeholder the Runtime normalizes to, mapped to a value of the right shape. An unknown one throws. */
export const PLACEHOLDER_VALUES: Record<string, string> = {
  task_id: '01JZTASK000000000000000001',
  run_id: '01JZRUN0000000000000000001',
  attempt_id: '01JZATTEMPT00000000000001',
  association_id: '01JZASSOC00000000000000001',
  receipt_id: 'task.create:task',
  project_id: 'project-example',
  base_revision_id: 'revision-base',
  base_publication_id: 'publication-base',
  current_revision_id: 'revision-current',
  current_publication_id: 'publication-current',
  request_id: 'req-example',
  cursor: 'cursor-2',
  timestamp: '2026-09-06T00:00:00Z',
  digest: `sha256:${HEX_64}`,
  hash: `sha256:${HEX_64}`,
};

export function fillPlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/<([a-z_]+)>/g, (_match, name: string) => {
      const filled = PLACEHOLDER_VALUES[name];
      if (filled === undefined) throw new Error(`recorded fixture uses an unmapped placeholder <${name}>`);
      return filled;
    }) as T;
  }
  if (Array.isArray(value)) return value.map(fillPlaceholders) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fillPlaceholders(entry)]),
    ) as T;
  }
  return value;
}

/** A fixture with its placeholders filled; request path and bodies included. */
export function filled(name: string): RecordedResponse {
  return fillPlaceholders(recorded(name));
}

/**
 * The JSON shape of a value: same keys recursively, same value types. Strings
 * all collapse to "string", so the shape of a placeholder never matters.
 */
export type JsonShape = string | { [key: string]: JsonShape } | JsonShape[];

export function jsonShape(value: unknown, opaque: ReadonlySet<string> = new Set(), at = '$'): JsonShape {
  if (opaque.has(at)) return 'opaque';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    // One representative: a list's items all share a shape in the recorded cases.
    return value.length === 0 ? [] : [jsonShape(value[0], opaque, `${at}[]`)];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, jsonShape(entry, opaque, `${at}.${key}`)]),
    );
  }
  return typeof value;
}
