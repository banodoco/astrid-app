// @vitest-environment node
/**
 * One real end-to-end admission: an element compiled by real esbuild with the Agent's element-builder flags, served by a
 * real HTTP responder in the Runtime's list shape, loaded by the real loader inside real Chromium through a real import
 * map and a blob URL import, then rendered with React. Nothing about module evaluation is mocked (jsdom cannot evaluate
 * module imports from blob URLs, so this runs in the browser). It needs Playwright's Chromium installed.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../../..');
const PROJECT = 'real-project';
const SPECIFIERS = ['react', 'react/jsx-runtime', 'remotion', 'react-dom/client'] as const;

const ELEMENT_SOURCE = `
import { AbsoluteFill } from 'remotion';
import { useState } from 'react';
export default function Reveal(props) {
  const [label] = useState('rendered by a real admitted element');
  return <AbsoluteFill data-testid="admitted">{label}:{String(props.n)}</AbsoluteFill>;
}
`;

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (output: { text: string }) => output.text;

/** The same flags as astrid/pack_builder.py ELEMENT_BUILDER_SOURCE. */
async function buildElement(): Promise<string> {
  const result = await build({
    stdin: { contents: ELEMENT_SOURCE, loader: 'tsx', resolveDir: root, sourcefile: 'component.tsx' },
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    logLevel: 'silent', external: ['react', 'react/jsx-runtime', 'remotion'], outfile: 'out.js',
  });
  expect(result.outputFiles).toHaveLength(1);
  return text(result.outputFiles[0]);
}

/** Host singletons as ESM wrappers sharing one React chunk, plus the real loader bundled for the page. */
async function buildHost() {
  const wrapper = (specifier: string) => {
    const names = Object.keys(require(specifier)).filter((name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
    return `import m from ${JSON.stringify(specifier)}; ${names.map((n) => `export const ${n} = m.${n};`).join('')}${specifier === 'react' ? ' export default m;' : ''}`;
  };
  const shared = await build({
    stdin: { contents: '', resolveDir: root },
    entryPoints: Object.fromEntries(SPECIFIERS.map((s) => [s.replace(/\W+/g, '-'), `shared:${s}`])),
    plugins: [{ name: 'shared', setup(b) {
      b.onResolve({ filter: /^shared:/ }, (args) => ({ path: args.path.slice(7), namespace: 'shared' }));
      b.onLoad({ filter: /.*/, namespace: 'shared' }, (args) => args.path === 'remotion'
        ? { contents: "export * from 'remotion';", resolveDir: root }
        : { contents: wrapper(args.path), resolveDir: root });
    } }],
    bundle: true, write: false, format: 'esm', splitting: true, outdir: 'assets', platform: 'browser', target: 'es2020',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const files = new Map(shared.outputFiles.map((file) => [`/assets/${path.basename(file.path)}`, file.contents]));
  const page = await build({
    stdin: { sourcefile: 'page.ts', resolveDir: root, loader: 'ts', contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { readProjectElementList, importProjectElement } from '/src/tools/video-editor/runtime/admittedElementLoader.ts';
      (window as any).admit = async () => {
        const controller = new AbortController();
        const list = await readProjectElementList('${PROJECT}', controller.signal);
        const Component = await importProjectElement(list.elements[0], controller.signal);
        const host = document.getElementById('app')!;
        createRoot(host).render(createElement(Component, { n: 7 }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        return host.textContent;
      };
    ` },
    plugins: [{ name: 'alias', setup(b) {
      b.onResolve({ filter: /^\/src\// }, (args) => ({ path: path.join(root, args.path) }));
      b.onResolve({ filter: /^@\/integrations\/runtime\/connection$/ }, () => ({ path: 'connection', namespace: 'stub' }));
      b.onResolve({ filter: /^@\// }, (args) => ({ path: require.resolve(path.join(root, 'src', args.path.slice(2)) + '.ts') }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const runtimeOrigin = () => location.origin; export const runtimeApiBase = () => location.origin + "/api/runtime";',
      }));
    } }],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', logLevel: 'silent',
    external: ['react', 'react-dom/client', 'react/jsx-runtime', 'remotion'],
  });
  const bindings = Object.fromEntries(SPECIFIERS.map((specifier) => {
    const url = [...files.keys()].find((name) => name.startsWith(`/assets/${specifier.replace(/\W+/g, '-')}.`) || name === `/assets/${specifier.replace(/\W+/g, '-')}.js`)!;
    return [specifier, { url, sha256: sha(files.get(url)!), version: '1.0.0' }];
  }));
  const imports = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.url]));
  return { files, pageJs: text(page.outputFiles[0]), bindings, imports };
}

let server: Server;
let browser: Browser;
let base = '';
let served: { bytes: string; digest: string; tamper: boolean };
let host: Awaited<ReturnType<typeof buildHost>>;

beforeAll(async () => {
  const bytes = await buildElement();
  served = { bytes, digest: sha(bytes), tamper: false };
  host = await buildHost();
  const html = () => `<!doctype html><html><head>
<script type="application/json" id="astrid-extension-shared-modules">${JSON.stringify({ version: 1, shared_modules: host.bindings })}</script>
<script type="importmap" id="astrid-extension-importmap">${JSON.stringify({ imports: host.imports })}</script>
</head><body><div id="app"></div><script type="module" src="/page.js"></script></body></html>`;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const send = (type: string, body: string | Uint8Array) => { response.setHeader('content-type', type); response.end(body); };
    if (url.pathname === '/') return send('text/html', html());
    if (url.pathname === '/page.js') return send('text/javascript', host.pageJs);
    if (host.files.has(url.pathname)) return send('text/javascript', host.files.get(url.pathname)!);
    if (url.pathname === '/api/runtime/packs/project-elements' && url.searchParams.get('project') === PROJECT) {
      return send('application/json', JSON.stringify({
        version: 1, projectId: PROJECT, realmId: 'realm', selectionDigest: 'a'.repeat(64), legacy: [],
        projects: [{ projectId: PROJECT, packId: 'project_real', packRoot: '/work/p', status: 'admitted',
          initCommand: 'i', admitCommand: 'a', inspectCommand: 'c' }],
        elements: [{
          ref: { packId: 'project_real', kind: 'effect', id: 'reveal', revision: 'r1' }, digest: served.digest,
          url: `/api/runtime/packs/project-elements/${PROJECT}/${served.digest}.js`,
          descriptor: { packId: 'project_real', kind: 'effect', id: 'reveal', revision: 'r1', label: 'Reveal', description: '', componentPath: 'elements/reveal/component.tsx',
            parameters: [], defaults: {}, renderability: { preview: 'supported', browserExport: 'supported', workerExport: 'unknown' } },
          authoring: { packRoot: '/work/p', descriptorPath: '/work/p/d.yaml', componentPath: '/work/p/c.tsx', status: 'admitted' },
        }],
      }));
    }
    if (url.pathname === `/api/runtime/packs/project-elements/${PROJECT}/${served.digest}.js`) {
      return send('text/javascript', served.tamper ? `${served.bytes}\n/* tampered */` : served.bytes);
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe('an admitted element evaluated in a real browser', () => {
  it('lists, digest-verifies, imports through the real import map from a blob URL, and renders with React', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => typeof (window as any).admit === 'function');
    const rendered = await page.evaluate(() => (window as any).admit() as Promise<string>);
    expect(errors).toEqual([]);
    expect(rendered).toBe('rendered by a real admitted element:7');
    await page.close();
  });

  it('refuses bytes that differ from the admitted digest and renders nothing', async () => {
    const page = await browser.newPage();
    served.tamper = true;
    try {
      await page.goto(base);
      const outcome = await page.evaluate(() => (window as any).admit().then(() => 'rendered', (error: Error) => error.message));
      expect(outcome).toContain('does not match the digest the Runtime admitted');
      expect(await page.locator('#app').textContent()).toBe('');
    } finally { served.tamper = false; await page.close(); }
  });
});
