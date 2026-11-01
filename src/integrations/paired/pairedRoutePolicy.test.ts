import { describe, expect, it } from 'vitest';
import * as policy from '../../../config/vite/pairedRoutePolicy';
import { classifyPairedRoute, forwardHeaders, type PairedService } from '../../../config/vite/pairedRoutePolicy';
import generatedClientSource from '../runtime/generated.ts?raw';
import runtimeClientSource from '../runtime/client.ts?raw';

const P = 'proj-1';
const T = 'tl-1';
const R = 'rev-1';

// Every call the App's product code sends through the relay, as
// [method, path under /api/<prefix>, expected service].
const runtime = (path: string) => `/api/runtime${path}`;
const astrid = (path: string) => `/api/astrid${path}`;
const productCalls: ReadonlyArray<readonly [string, string, PairedService]> = [
  // RuntimeClient (src/integrations/runtime/client.ts, dataProvider.ts)
  ['GET', runtime('/v1/health'), 'runtime'],
  ['POST', runtime('/v1/handshake'), 'runtime'],
  ['GET', runtime('/v1/realm'), 'runtime'],
  ['GET', runtime('/v1/app-state/user/editor-tour'), 'runtime'],
  ['PUT', runtime('/v1/app-state/user/editor-tour'), 'runtime'],
  ['GET', runtime('/v1/projects?limit=50&cursor=c1'), 'runtime'],
  ['POST', runtime('/v1/projects'), 'runtime'],
  ['PUT', runtime('/v1/projects/selection'), 'runtime'], // selectProject: the open project, for terminal agents
  ['GET', runtime(`/v1/projects/${P}`), 'runtime'],
  ['PATCH', runtime(`/v1/projects/${P}`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/timelines?limit=50`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}`), 'runtime'],
  ['PATCH', runtime(`/v1/projects/${P}/timelines/${T}`), 'runtime'], // renameTimeline
  ['POST', runtime(`/v1/projects/${P}/timelines/import`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/timelines/import`), 'runtime'],
  ['PATCH', runtime(`/v1/projects/${P}/timelines/import`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/revisions/${R}`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions?limit=50`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/${R}`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/${R}/restore`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/inspect`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/shots/shot-1/revisions/${R}`), 'runtime'],
  // Transcript documents (RuntimeClient.listDocuments/createDocument/getDocument/updateDocument)
  ['GET', runtime(`/v1/projects/${P}/documents?limit=50&kind=transcript`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/documents`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/documents/transcript:${'a'.repeat(64)}`), 'runtime'],
  ['PATCH', runtime(`/v1/projects/${P}/documents/transcript:${'a'.repeat(64)}`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/thumbnails/source-frame?media_id=m1&time=1`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/thumbnails/source-frame`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/objects`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/objects?limit=100`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/objects/obj-1/location`), 'runtime'],
  ['POST', runtime(`/v1/projects/${P}/media-imports`), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/media-imports/op-1`), 'runtime'],
  ['GET', runtime('/v1/objects/obj-1'), 'runtime'],
  ['HEAD', runtime('/v1/objects/obj-1'), 'runtime'],
  ['POST', runtime('/v1/tasks'), 'runtime'],
  ['GET', runtime('/v1/tasks/task-1'), 'runtime'],
  ['POST', runtime('/v1/tasks/task-1/cancel'), 'runtime'],
  ['POST', runtime('/v1/tasks/task-1/retry'), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/tasks?limit=50`), 'runtime'],
  ['GET', runtime('/v1/tasks/task-1/managed-outputs?limit=50'), 'runtime'],
  ['GET', runtime('/v1/managed-outputs/assoc-1'), 'runtime'],
  ['POST', runtime('/v1/managed-outputs/assoc-1/export'), 'runtime'],
  ['GET', runtime('/v1/events?limit=50&aggregate_id=a1'), 'runtime'],
  ['GET', runtime(`/v1/projects/${P}/generations?limit=50`), 'runtime'],
  ['GET', runtime('/v1/generations/gen-1'), 'runtime'],
  ['GET', runtime('/v1/generations/gen-1/variants?limit=50'), 'runtime'],
  ['POST', runtime('/v1/variants/var-1/viewed'), 'runtime'],
  ['POST', runtime('/v1/generations/gen-1/variants/viewed'), 'runtime'],
  // AstridLocalClient (src/integrations/astrid/*Routes.ts, renderRouter.ts)
  ['GET', astrid('/v1/capabilities?limit=50'), 'astrid'],
  ['POST', astrid('/v1/tasks'), 'astrid'],
  ['GET', astrid('/v1/tasks/task-1'), 'astrid'],
  ['POST', astrid('/v1/tasks/task-1/cancel'), 'astrid'],
  ['GET', astrid('/v1/events?limit=50'), 'astrid'],
  ['GET', astrid(`/v1/projects/${P}/tasks?limit=1`), 'astrid'],
  ['GET', astrid(`/v1/projects/${P}/generations?limit=1`), 'astrid'],
  ['GET', astrid('/v1/generations/gen-1/variants?limit=50'), 'astrid'],
  ['POST', astrid(`/v1/projects/${P}/objects`), 'astrid'],
  ['GET', astrid('/v1/projects'), 'astrid'],
  ['PATCH', astrid(`/v1/projects/${P}`), 'astrid'],
  // ACP agent chat (acpRoutes.ts)
  ['POST', astrid('/acp/connect'), 'acp'],
  ['POST', astrid('/acp/astrid/api-key'), 'acp'], // saveAstridApiKey: the OpenRouter key goes to the local chat service only
  ['GET', astrid('/acp/models'), 'acp'],
  ['GET', astrid('/acp/agents'), 'acp'],
  ['GET', astrid('/acp/conn-1/models?sessionId=codex%3Aabc-123'), 'acp'],
  ['POST', astrid('/acp/conn-1/rpc'), 'acp'],
  ['GET', astrid('/acp/conn-1/events'), 'acp'],
  ['POST', astrid('/acp/conn-1/cancel'), 'acp'],
  ['POST', astrid('/acp/conn-1/reconnect'), 'acp'],
  ['GET', astrid(`/acp/projects/${P}/chat`), 'acp'],
  ['PATCH', astrid(`/acp/projects/${P}/chat`), 'acp'],
  ['GET', astrid('/acp/health'), 'acp'],
  ['DELETE', astrid('/acp/conn-1'), 'acp'],
  ['POST', astrid(`/acp/projects/${P}/chat/sessions`), 'acp'],
  ['GET', astrid(`/acp/projects/${P}/chat/unassigned?connection_id=conn-1`), 'acp'],
  ['POST', astrid(`/acp/projects/${P}/chat/associate`), 'acp'],
  ['PATCH', astrid(`/acp/projects/${P}/chat/draft`), 'acp'],
  ['PATCH', astrid(`/acp/projects/${P}/chat/main`), 'acp'],
  ['POST', astrid(`/acp/projects/${P}/chat/prompt`), 'acp'],
];

const forbidden: ReadonlyArray<readonly [string, string]> = [
  ['POST', astrid('/acp/model')],
  ['POST', astrid('/acp/conn-1/model')],
  ['DELETE', astrid('/acp/models')],
  ['POST', astrid('/acp/models')],
  ['GET', astrid('/acp/model')],
  ['DELETE', astrid('/acp/model')],
  ['POST', astrid('/acp/conn-1/models')],
  ['GET', astrid('/acp/conn-1/model')],
  ['DELETE', astrid('/acp/conn-1/model')],
  ['GET', astrid('/acp/conn-1/models/extra?sessionId=s1')],
  ['GET', astrid('/acp/health/models?sessionId=s1')],
  ['GET', runtime('/v1/doctor')],
  ['POST', runtime('/v1/backup')],
  ['POST', runtime('/v1/restore')],
  ['GET', runtime('/v1/export')],
  ['POST', runtime('/v1/realm/tombstone')],
  ['POST', runtime('/v1/realm/recover')],
  ['POST', runtime('/v1/realm/purge')],
  ['POST', runtime('/v1/realm/replace')],
  ['POST', runtime('/v1/tasks/claim')],
  ['GET', runtime('/v1/tasks/claim')],
  ['POST', runtime('/v1/attempts/att-1/settle')],
  ['POST', runtime('/v1/recovery/checkpoint')],
  ['POST', runtime('/v1/executors')],
  ['GET', runtime('/v1/executors/ex-1')],
  ['POST', runtime('/v1/capabilities')],
  ['GET', runtime('/v1/capabilities')],
  ['POST', astrid('/v1/capabilities')],
  ['PUT', astrid('/v1/capabilities/cap-1')],
  ['POST', astrid('/v1/tasks/claim')],
  ['GET', astrid('/v1/doctor')],
  ['POST', astrid('/v1/realm/purge')],
  ['POST', astrid('/v1/attempts/att-1/settle')],
  ['POST', astrid('/v1/executors')],
  ['POST', runtime('/v1/tasks/task-1/remote-credential')],
  ['POST', runtime('/v1/tasks/task-1/placement-recovery')],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/replace-parent-media`)],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/${R}/restore/extra`)],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/${R}/purge`)],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/doctor`)],
  ['POST', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/`)],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/${R}/../../../doctor`)],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions/%2e%2e/doctor`)],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/composition-revisions//x`)],
  ['GET', runtime(`/v1/projects/${P}/timelines/${T}/inspect/../../../../doctor`)],
  ['GET', runtime(`/v1/projects/${P}/thumbnails/other`)],
  ['GET', runtime(`/v1/projects/${P}/objects/obj-1/location/extra`)],
  ['GET', runtime('/v1/unknown')],
  // Transcript documents are never deleted through the product surface.
  ['DELETE', runtime(`/v1/projects/${P}/documents/transcript:${'a'.repeat(64)}`)],
  ['DELETE', astrid(`/v1/projects/${P}/documents/transcript:${'a'.repeat(64)}`)],
  ['POST', runtime(`/v1/projects/${P}/documents/transcript:${'a'.repeat(64)}`)],
  ['DELETE', runtime(`/v1/projects/${P}/documents`)],
  ['GET', runtime(`/v1/projects/${P}/documents/transcript:${'a'.repeat(64)}/versions`)],
  ['GET', astrid(`/acp/projects/${P}/chat/unknown`)],
  ['GET', astrid(`/acp/projects/${P}/chat/../../x`)],
  ['TRACE', runtime('/v1/health')],
];

const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const prefixes = ['/api/runtime', '/api/astrid'];
const bare = (path: string) => path.replace(/^\/api\/(?:runtime|astrid)/, '');
const pathOnly = (path: string) => path.split('?', 1)[0];

// Privileged operations that must never be reachable, through either alias.
const privileged: ReadonlyArray<string> = [
  '/v1/tasks/task-1/remote-credential',
  '/v1/tasks/task-1/remote-activation',
  '/v1/tasks/task-1/remote-activation/revoke',
  '/v1/tasks/task-1/placement-recovery',
  '/v1/tasks/task-1/events/extra',
  `/v1/projects/${P}/timelines/${T}/replace-parent-media`,
  `/v1/projects/${P}/timelines/${T}/views`,
  `/v1/projects/${P}/timelines/${T}/archive`,
  '/v1/delegated-tasks',
  '/v1/replace',
  '/v1/credentials',
  '/v1/preferences/x',
  '/v1/tasks/claim',
  '/v1/doctor',
  '/v1/export',
  '/v1/backup',
  '/v1/restore',
  '/v1/realm/purge',
  '/v1/realm/tombstone',
  '/v1/realm/recover',
  '/v1/attempts/att-1/settle',
  '/v1/recovery/reboot',
  '/v1/executors',
  '/v1/executors/ex-1',
  '/v1/managed-outputs/assoc-1/adopt',
  '/v1/managed-outputs/assoc-1/lifecycle',
  '/v1/objects',
  '/v1/runs/run-1/cancel',
];

const malformed: ReadonlyArray<readonly [string, string]> = [
  ['encoded denied name: tasks/%63laim', '/v1/tasks/%63laim'],
  ['encoded denied name: tasks/cl%61im', '/v1/tasks/cl%61im'],
  ['encoded denied name: %64octor', '/v1/%64octor'],
  ['encoded denied name: realm/%70urge', '/v1/realm/%70urge'],
  ['encoded denied name: %65xecutors', '/v1/%65xecutors'],
  ['encoded admin action', '/v1/tasks/task-1/%72emote-credential'],
  ['TAB inside segment', '/v1/tasks/cl\taim'],
  ['literal TAB at end', '/v1/health\t'],
  ['newline inside segment', '/v1/tasks/cl\naim'],
  ['carriage return', '/v1/tasks/cl\raim'],
  ['NUL byte', '/v1/tasks/cl\u0000aim'],
  ['DEL byte', '/v1/tasks/cl\u007faim'],
  ['space inside segment', '/v1/tasks/cl aim'],
  ['encoded TAB', '/v1/tasks/cl%09aim'],
  ['encoded newline', '/v1/tasks/task-1%0a'],
  ['encoded NUL', '/v1/tasks/task-1%00'],
  ['non-ASCII', '/v1/tasks/täsk'],
  ['double encoding', '/v1/tasks/%2563laim'],
  ['encoded percent', '/v1/tasks/task%251'],
  ['encoded slash', '/v1/tasks/task-1%2fcancel'],
  ['encoded slash (upper)', '/v1/tasks/task-1%2Fcancel'],
  ['encoded backslash', '/v1/tasks/task-1%5ccancel'],
  ['encoded dot segment', '/v1/tasks/%2e%2e/doctor'],
  ['encoded dot', '/v1/tasks/%2e/task-1'],
  ['dot segment', '/v1/tasks/./task-1'],
  ['dot-dot segment', '/v1/tasks/task-1/../claim'],
  ['empty segment', '/v1/tasks//task-1'],
  ['trailing slash', '/v1/tasks/task-1/'],
  ['trailing segment', '/v1/tasks/task-1/cancel/extra'],
  ['fragment', '/v1/tasks/task-1#/claim'],
  ['encoded fragment', '/v1/tasks/task-1%23'],
  ['encoded query marker', '/v1/tasks/task-1%3Fx'],
  ['truncated escape', '/v1/tasks/task-1%'],
  ['truncated escape 2', '/v1/tasks/task-1%4'],
  ['non-hex escape', '/v1/tasks/task-1%zz'],
  ['invalid UTF-8 escape', '/v1/tasks/%c0%af'],
  ['backslash', '/v1/tasks/task-1\\cancel'],
  ['absolute URL', '/v1/tasks/http://127.0.0.1:1/x'],
  ['id too long', `/v1/tasks/${'a'.repeat(300)}`],
  ['id starts with dot', '/v1/tasks/.hidden'],
  ['path too long', `/v1/projects/${P}/timelines/${T}/${'a'.repeat(5000)}`],
  ['query control char', '/v1/events?limit=1\tx'],
  ['query fragment', '/v1/events?limit=1#x'],
  ['query backslash', '/v1/events?x=\\y'],
];

describe('paired route policy', () => {
  it.each(productCalls)('allows product call %s %s', (method, path, service) => {
    const route = classifyPairedRoute(path, method);
    expect(route?.service).toBe(service);
    expect(route?.upstreamPath).toBe(bare(path));
  });

  it.each(productCalls.filter(([, path]) => path.startsWith('/api/runtime')))(
    'serves runtime product call %s %s through the astrid alias too',
    (method, path) => {
      const alias = path.replace('/api/runtime', '/api/astrid');
      expect(classifyPairedRoute(alias, method)?.service).toBe('astrid');
    },
  );

  it.each(forbidden)('rejects %s %s', (method, path) => {
    expect(classifyPairedRoute(path, method)).toBeNull();
  });

  const allowedMethods = new Map<string, Set<string>>();
  for (const [method, path] of productCalls) {
    const key = pathOnly(path);
    allowedMethods.set(key, (allowedMethods.get(key) ?? new Set()).add(method));
    if (key.startsWith('/api/runtime')) {
      const alias = key.replace('/api/runtime', '/api/astrid');
      allowedMethods.set(alias, (allowedMethods.get(alias) ?? new Set()).add(method));
    }
  }
  const wrongMethods = [...allowedMethods].flatMap(([path, methods]) =>
    ALL_METHODS.filter((method) => !methods.has(method)).map((method) => [method, path] as const));

  it.each(wrongMethods)('rejects wrong method %s %s', (method, path) => {
    expect(classifyPairedRoute(path, method)).toBeNull();
    expect(classifyPairedRoute(`${path}?limit=1`, method)).toBeNull();
  });

  const privilegedCases = prefixes.flatMap((prefix) => privileged.flatMap((path) =>
    ['', '?limit=1', '?x=%2e%2e'].flatMap((query) =>
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => [method, `${prefix}${path}${query}`] as const))));

  it.each(privilegedCases)('rejects privileged %s %s', (method, path) => {
    expect(classifyPairedRoute(path, method)).toBeNull();
  });

  const malformedCases = prefixes.flatMap((prefix) => malformed.flatMap(([label, path]) =>
    ['GET', 'POST', 'PATCH'].map((method) => [label, method, `${prefix}${path}`] as const)));

  it.each(malformedCases)('rejects malformed path (%s) %s %s', (_label, method, path) => {
    expect(classifyPairedRoute(path, method)).toBeNull();
  });

  it('classifies the canonical (decoded once) path, never the raw one', () => {
    const route = classifyPairedRoute('/api/runtime/v1/objects/sha256%3A0abc', 'GET');
    expect(route?.upstreamPath).toBe('/v1/objects/sha256:0abc');
    expect(classifyPairedRoute('/api/runtime/v1/projects/p%2D1/timelines/t%5F1/inspect', 'POST')?.upstreamPath)
      .toBe('/v1/projects/p-1/timelines/t_1/inspect');
    expect(classifyPairedRoute('/api/astrid/v1/%63apabilities?limit=1', 'POST')).toBeNull();
    expect(classifyPairedRoute('/api/astrid/v1/%63apabilities?limit=1', 'GET')?.upstreamPath).toBe('/v1/capabilities?limit=1');
  });

  it('is idempotent: a returned upstream path classifies to itself', () => {
    for (const [method, path] of productCalls) {
      const first = classifyPairedRoute(path, method);
      const prefix = first?.service === 'runtime' ? '/api/runtime' : '/api/astrid';
      const again = classifyPairedRoute(`${prefix}${first?.upstreamPath}`, method);
      expect(again?.upstreamPath).toBe(first?.upstreamPath);
    }
  });

  it('keeps the compose route POST-only', () => {
    expect(classifyPairedRoute('/api/astrid/generation/compose', 'POST')?.service).toBe('compose');
    expect(classifyPairedRoute('/api/astrid/generation/compose', 'GET')).toBeNull();
    expect(classifyPairedRoute('/api/astrid/generation/compose?x=1', 'POST')).toBeNull();
  });

  it("forwards the App's media and conditional request headers to the Runtime, never credentials", () => {
    const upstreamRequestHeaders = (policy as unknown as {
      upstreamRequestHeaders?: (headers: Record<string, string | undefined>) => Record<string, string>;
    }).upstreamRequestHeaders;
    expect(upstreamRequestHeaders).toBeTypeOf('function');
    const forwarded = upstreamRequestHeaders!({
      'content-type': 'video/mp4', 'idempotency-key': 'k1', 'if-match': '"v1"', 'if-none-match': '"v0"', range: 'bytes=0-9',
      'x-original-name': 'a.mp4', 'x-filename': 'a.mp4', 'x-expected-digest': 'sha256:abc', 'x-expected-version': '3',
      'x-media-width': '1920', 'x-media-height': '1080', 'x-media-duration-seconds': '4.5',
      authorization: 'Bearer browser', cookie: 'astrid_paired=1', 'x-output-binding': '{}', origin: 'https://x', host: 'x',
    });
    expect(forwarded).toMatchObject({
      'x-expected-digest': 'sha256:abc', 'x-media-width': '1920', 'x-media-height': '1080',
      'x-media-duration-seconds': '4.5', 'x-expected-version': '3', 'if-match': '"v1"', range: 'bytes=0-9',
    });
    for (const credential of ['authorization', 'cookie', 'x-output-binding', 'origin', 'host']) expect(forwarded).not.toHaveProperty(credential);
  });
});

// The App's Workspace v1 calls, derived from source so the allowlist cannot drift
// from them, so every call the App makes (such as composition-revisions, inspect
// and /v1/capabilities) must be on the allowlist. Operations come from the
// generated client (method + path template per `async op(...)`); the ones the App
// uses are the `this.client.<op>(` calls in the runtime provider/adapter code.
describe('paired route policy vs the App\'s Workspace v1 calls', () => {
  // AstridRuntimeClient is the one place that owns a WorkspaceClient; the providers
  // (dataProvider.ts etc.) reach the Runtime only through its wrappers.
  const usedOperations = new Set([...runtimeClientSource.matchAll(/\bthis\.client\.(\w+)\(/g)].map((m) => m[1]));

  /** Source text of a template literal starting after its opening backtick (nested `${ }` aware). */
  const templateAt = (source: string, start: number) => {
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '`' && depth === 0) return source.slice(start, i);
      if (source[i] === '$' && source[i + 1] === '{') { depth += 1; i += 1; } else if (source[i] === '}' && depth > 0) depth -= 1;
    }
    throw new Error('unterminated template literal');
  };
  /** Path with an example id per `encodeURIComponent(..)`, optional query parts included. */
  const render = (template: string, action = ''): string => {
    let out = '';
    for (let i = 0; i < template.length; i += 1) {
      if (template[i] !== '$' || template[i + 1] !== '{') { out += template[i]; continue; }
      let depth = 1;
      let end = i + 2;
      for (; depth > 0; end += 1) depth += template[end] === '{' ? 1 : template[end] === '}' ? -1 : 0;
      const expr = template.slice(i + 2, end - 1);
      const optional = expr.match(/^\w+ {1}\? `(.*)` : ""$/s);
      out += expr.startsWith('encodeURIComponent(') ? encodeURIComponent('timeline:id-1')
        : optional ? render(optional[1]) : expr === 'action' ? action : '1';
      i = end - 1;
    }
    return out;
  };

  interface DerivedCall { op: string; method: string; path: string; headers: string[] }
  const operationBodies = new Map<string, string>();
  for (const part of generatedClientSource.split(/\n {2}(?:private )?async /).slice(1)) operationBodies.set(part.match(/^(\w+)/)![1], part);

  /** Every HTTP request an operation makes, following calls to sibling operations (cancelTask -> transitionTask, ...). */
  const derive = (op: string, action = ''): DerivedCall[] => {
    const body = operationBodies.get(op);
    if (!body) throw new Error(`App uses ${op}, which is not in the generated client`);
    const own = [...body.matchAll(/this\.request\("([A-Z]+)", (`|"|\w+)/g)].map((call) => {
      let template: string;
      const at = call.index! + call[0].length;
      if (call[2] === '`') template = templateAt(body, at);
      else if (call[2] === '"') template = body.slice(at).split('"')[0];
      else template = templateAt(body, body.indexOf(`const ${call[2]} = \``) + `const ${call[2]} = \``.length); // path in a local variable
      const headers = [...body.matchAll(/"([A-Z][A-Za-z]*(?:-[A-Za-z]+)+)"|headers\.([A-Z]\w*)/g)].map((m) => (m[1] ?? m[2]).toLowerCase());
      return { op, method: call[1], path: render(template, action), headers: ['accept', ...headers] };
    });
    const siblings = [...body.matchAll(/this\.(\w+)\(([^)]*)\)/g)]
      .filter(([, name]) => name !== op && name !== 'request' && operationBodies.has(name))
      .flatMap(([, name, args]) => derive(name, args.match(/"(\w+)"/)?.[1] ?? action).map((call) => ({ ...call, op })));
    if (own.length + siblings.length === 0) throw new Error(`cannot find the HTTP call of ${op}`);
    return [...own, ...siblings];
  };
  const calls = [...usedOperations].sort().flatMap((op) => derive(op));

  // Reached through /api/astrid (nativeEditorConnection.ts:6); the Runtime alias deliberately has no capability catalog.
  const astridOnly = new Set(['listCapabilities']);
  // Verified media follows getProjectMediaSelection: both are local Runtime-door reads.
  // Previously getProjectVerifiedMedia fell into pairedCalls, which expected
  // /api/runtime -> runtime and /api/astrid -> astrid; the explicit mapping below
  // replaces that with refusal through both aliases.
  const localDoorOnly = new Set(['commitTimeline', 'listTimelineCommits', 'createTimeline', 'getProjectMediaSelection', 'getProjectVerifiedMedia']);
  const pairedCalls = calls.filter(({ op }) => !localDoorOnly.has(op));
  const localDoorOnlyCalls = calls.filter(({ op }) => localDoorOnly.has(op));

  it('derives the App\'s calls from source, including the B1 routes', () => {
    const derived = calls.map(({ method, path }) => `${method} ${path.split('?')[0]}`);
    const id = encodeURIComponent('timeline:id-1');
    const timeline = `/v1/projects/${id}/timelines/${id}`;
    for (const b1 of [`POST ${timeline}/composition-revisions`, `POST ${timeline}/inspect`, 'GET /v1/capabilities']) {
      expect(derived).toContain(b1);
    }
    expect(calls.length).toBeGreaterThan(25);
    expect(calls.every(({ path }) => path.startsWith('/v1/') && !path.includes('${'))).toBe(true);
    expect(calls.flatMap((call) => call.headers)).toEqual(expect.arrayContaining(['content-type', 'idempotency-key', 'x-original-name', 'range']));
    expect(new Set(localDoorOnlyCalls.map(({ op }) => op))).toEqual(localDoorOnly);
    expect(localDoorOnlyCalls).toHaveLength(5);
  });

  describe.each(pairedCalls)('$op: $method $path', ({ method, path, op }) => {
    const prefixes = astridOnly.has(op) ? ['/api/astrid'] : ['/api/runtime', '/api/astrid'];
    it.each(prefixes)('is allowed through %s', (prefix) => {
      const service = prefix === '/api/runtime' ? 'runtime' : 'astrid';
      const route = classifyPairedRoute(`${prefix}${path}`, method, { 'content-length': '12' });
      expect(route?.service).toBe(service);
      expect(route?.upstreamPath).toBe(decodeURIComponent(path.split('?')[0]) + (path.includes('?') ? `?${path.split('?')[1]}` : ''));
    });
  });

  describe.each(localDoorOnlyCalls)('$op: local door only $method $path', ({ method, path }) => {
    it.each(['/api/runtime', '/api/astrid'])('refuses local door only call through %s', (prefix) => {
      expect(classifyPairedRoute(`${prefix}${path}`, method, { 'content-length': '12' })).toBeNull();
    });
  });

  describe.each(calls)('$op: $method $path headers', ({ headers }) => {
    it('keeps every header the call sends', () => {
      const sent = Object.fromEntries(headers.map((name) => [name, 'v']));
      expect(Object.keys(forwardHeaders(sent)).sort()).toEqual(Object.keys(sent).sort());
    });
  });

  it('keeps the capability catalog off the Runtime alias and only the product surface reachable', () => {
    expect(classifyPairedRoute('/api/runtime/v1/capabilities', 'GET')).toBeNull();
    expect(classifyPairedRoute('/api/astrid/v1/capabilities', 'GET')?.service).toBe('astrid');
    expect(classifyPairedRoute('/api/runtime/v1/not-a-route', 'GET')).toBeNull();
    expect(classifyPairedRoute('/api/astrid/v1/not-a-route', 'POST')).toBeNull();
  });

  it('rejects the generated client\'s privileged operations (admin, worker, credential, realm)', () => {
    const privilegedOps = ['doctor', 'createBackup', 'restoreBackup', 'exportRealm', 'tombstoneRealm', 'recoverRealm', 'purgeRealm',
      'claimTask', 'settleAttempt', 'registerExecutor', 'registerCapability', 'controlRemoteCredential', 'recordRemoteActivation', 'revokeRemoteActivation',
      'recoverTaskPlacement', 'replaceParentCompositionMedia', 'prepareReboot', 'checkpointAttempt', 'publishRecoverableSnapshot', 'issueChildAuthority'];
    for (const op of privilegedOps) {
      expect(usedOperations.has(op)).toBe(false);
      for (const { method, path } of derive(op)) {
        for (const prefix of prefixes) expect(classifyPairedRoute(`${prefix}${path}`, method), `${op} ${method} ${path}`).toBeNull();
      }
    }
  });
});
