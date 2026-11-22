// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build as esbuild } from 'esbuild';
import { build, createServer as createViteServer, loadConfigFromFile, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionSharedModuleLock } from './extensionImportMap';
import { manualVendorChunk } from './policy';

const tempRoots: string[] = [];
const servers: Array<ReturnType<typeof createHttpServer>> = [];
const browsers: Array<Awaited<ReturnType<typeof chromium.launch>>> = [];
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeFixture(root: string, relativePath: string, source: string): Promise<void> {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, source);
}

async function serveDirectory(root: string): Promise<string> {
  const server = createHttpServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}

function fixtureAlias() {
  return [
    { find: /^@\//, replacement: `${path.join(APP_ROOT, 'src')}/` },
    { find: /^react$/, replacement: path.join(APP_ROOT, 'node_modules/react/index.js') },
    { find: /^react\/jsx-runtime$/, replacement: path.join(APP_ROOT, 'node_modules/react/jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/, replacement: path.join(APP_ROOT, 'node_modules/react/jsx-dev-runtime.js') },
    { find: /^react-dom\/client$/, replacement: path.join(APP_ROOT, 'node_modules/react-dom/client.js') },
    { find: /^remotion$/, replacement: path.join(APP_ROOT, 'node_modules/remotion/dist/esm/index.mjs') },
    { find: /^@astrid\/editor-sdk$/, replacement: path.join(APP_ROOT, 'src/sdk/index.ts') },
  ];
}

describe('extension shared module import map dev server', () => {
  it('serves the same six wrappers in dev, with the import map injected before the module scripts', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'astrid-extension-import-map-dev-')));
    tempRoots.push(root);
    await Promise.all([
      writeFixture(root, 'index.html', '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>'),
      writeFixture(root, 'package-lock.json', JSON.stringify({ packages: {
        'node_modules/react': { version: '18.3.1' },
        'node_modules/react-dom': { version: '18.3.1' },
        'node_modules/remotion': { version: '4.0.509' },
      } })),
      // Import every shared specifier so the dev optimizer discovers each dependency at startup, not mid-request.
      writeFixture(root, 'src/main.js', [
        "import React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import { jsx } from 'react/jsx-runtime';",
        "import { jsxDEV } from 'react/jsx-dev-runtime';",
        "import { AbsoluteFill } from 'remotion';",
        "import { defineExtension } from '@astrid/editor-sdk';",
        'window.host = [React, createRoot, jsx, jsxDEV, AbsoluteFill, defineExtension];',
        '',
      ].join('\n')),
    ]);
    const { createExtensionImportMapPlugin, EXTENSION_IMPORT_MAP_ID } = await import('./extensionImportMap');
    const server: ViteDevServer = await createViteServer({
      configFile: false, root, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false },
      // Module URLs are compared, never executed, so the optimizer's pre-bundling is not part of this check.
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [createExtensionImportMapPlugin()], resolve: { alias: fixtureAlias() },
    });
    const { createServer: createHttpServer } = await import('node:http');
    const http = createHttpServer(server.middlewares);
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Dev fixture server did not bind a TCP port.');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const names = ['react', 'react-jsx-runtime', 'react-jsx-dev-runtime', 'react-dom-client', 'remotion', 'astrid-editor-sdk'];
      const reactWrapper = await fetch(`${base}/assets/astrid-extension-shared-react.js`);
      expect(reactWrapper.status).toBe(200);
      expect(reactWrapper.headers.get('content-type')).toContain('text/javascript');
      const wrapperBody = await reactWrapper.text();
      expect(wrapperBody).toContain('export default __astridSharedModule;');
      expect(wrapperBody).not.toMatch(/from "react"/);

      for (const name of names) {
        const response = await fetch(`${base}/assets/astrid-extension-shared-${name}.js`);
        expect(response.status, name).toBe(200);
      }

      // The host app's own `react` import and the wrapper's must resolve to the same module URL, or React identity splits.
      // Dev pre-bundles CommonJS React; both sides must name the same module file.
      const reactUrl = /from "([^"]*\/react[^"]*)"/;
      const hostModule = await server.transformRequest('/src/main.js');
      const hostReact = reactUrl.exec(hostModule?.code ?? '')?.[1];
      const wrapperReact = reactUrl.exec(wrapperBody)?.[1];
      expect(hostReact).toBeDefined();
      expect(wrapperReact).toBe(hostReact);

      // appType 'custom' leaves the page to the host; the same transform Vite runs on index.html in dev.
      const html = await server.transformIndexHtml('/', await readFile(path.join(root, 'index.html'), 'utf8'));
      const importMap = html.indexOf(`<script type="importmap" id="${EXTENSION_IMPORT_MAP_ID}">`);
      expect(importMap).toBeGreaterThan(html.indexOf('<head'));
      expect(importMap).toBeLessThan(html.indexOf('<script type="module"'));
      const imports = JSON.parse(/id="astrid-extension-importmap">(.*?)<\/script>/.exec(html)![1]).imports as Record<string, string>;
      expect(imports).toEqual({
        react: '/assets/astrid-extension-shared-react.js',
        'react/jsx-runtime': '/assets/astrid-extension-shared-react-jsx-runtime.js',
        'react/jsx-dev-runtime': '/assets/astrid-extension-shared-react-jsx-dev-runtime.js',
        'react-dom/client': '/assets/astrid-extension-shared-react-dom-client.js',
        remotion: '/assets/astrid-extension-shared-remotion.js',
        '@astrid/editor-sdk': '/assets/astrid-extension-shared-astrid-editor-sdk.js',
      });

      // The lock rides beside the map, with the digest of the exact wrapper bytes the dev server answers with, and the
      // loader's one strict check passes on it unrelaxed.
      const lock = JSON.parse(/id="astrid-extension-shared-modules">(.*?)<\/script>/.exec(html)![1]) as ExtensionSharedModuleLock;
      expect(lock.version).toBe(1);
      for (const [specifier, binding] of Object.entries(lock.shared_modules)) {
        const served = await (await fetch(`${base}${binding.url}`)).text();
        expect(binding.sha256, specifier).toBe(createHash('sha256').update(served).digest('hex'));
        expect(binding.url, specifier).toBe(imports[specifier]);
      }
      const { assertHostSharedModules, SHARED_SPECIFIERS, IMPORT_MAP_ID, SHARED_MODULES_ID } = await import('../../src/tools/video-editor/runtime/runtimeModuleImport');
      const body = (id: string) => new RegExp(`id="${id}">(.*?)</script>`).exec(html)![1];
      const original = (globalThis as { document?: unknown }).document;
      (globalThis as { document?: unknown }).document = { getElementById: (id: string) => (id === IMPORT_MAP_ID || id === SHARED_MODULES_ID
        ? { textContent: body(id), getAttribute: () => (id === IMPORT_MAP_ID ? 'importmap' : 'application/json') } : null) };
      try {
        expect(() => assertHostSharedModules(SHARED_SPECIFIERS, lock.shared_modules)).not.toThrow();
        expect(() => assertHostSharedModules(['react', 'react/jsx-runtime', 'remotion'])).not.toThrow();
      } finally { (globalThis as { document?: unknown }).document = original; }
    } finally {
      await server.close();
    }
  }, 60_000);

  it('runs the real loader in Chromium against the dev-emitted map and lock', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'astrid-extension-import-map-dev-e2e-')));
    tempRoots.push(root);
    const elementSource = "import { AbsoluteFill } from 'remotion'; import { useState } from 'react';"
      + " export default function Dev() { const [t] = useState('dev element'); return <AbsoluteFill>{t}</AbsoluteFill>; }";
    const built = await esbuild({
      stdin: { contents: elementSource, loader: 'tsx', resolveDir: APP_ROOT }, bundle: true, write: false, format: 'esm',
      platform: 'browser', target: 'es2020', jsx: 'automatic', logLevel: 'silent', external: ['react', 'react/jsx-runtime', 'remotion'],
      outfile: 'out.js',
    });
    const bytes = built.outputFiles[0].text;
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFixture(root, 'page.ts', `import { createElement } from 'react'; import { createRoot } from 'react-dom/client';
            import { readProjectElementList, importProjectElement } from '@/tools/video-editor/runtime/admittedElementLoader';
            window.admit = async () => {
              const controller = new AbortController();
              const list = await readProjectElementList('dev-project', controller.signal);
              const Component = await importProjectElement(list.elements[0], controller.signal);
              const host = document.getElementById('app'); createRoot(host).render(createElement(Component));
              await new Promise((resolve) => setTimeout(resolve, 100));
              return host.textContent;
            };`);
    const PAGE = `/@fs${root}/page.ts`;
    const { createExtensionImportMapPlugin } = await import('./extensionImportMap');
    const server = await createViteServer({
      configFile: false, root: APP_ROOT, cacheDir: path.join(root, '.vite'), logLevel: 'silent', appType: 'custom',
      server: { middlewareMode: true, hmr: false }, resolve: { alias: [{ find: /^@\/(?!integrations\/runtime\/connection$)/, replacement: `${path.join(APP_ROOT, 'src')}/` }, { find: /^@astrid\/editor-sdk$/, replacement: path.join(APP_ROOT, 'src/sdk/index.ts') }] },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'remotion'] },
      plugins: [{
        name: 'dev-e2e-page', enforce: 'pre',
        resolveId(id) {
          if (id === '@/integrations/runtime/connection') return '\0dev-e2e-connection';
          return id === PAGE ? '\0page' : null;
        },
        load(id) {
          if (id === '\0dev-e2e-connection') return 'export const runtimeOrigin = () => location.origin; export const runtimeApiBase = () => location.origin + "/api/runtime";';
          if (id !== '\0page') return null;
          return `import { createElement } from 'react'; import { createRoot } from 'react-dom/client';
            import { readProjectElementList, importProjectElement } from '@/tools/video-editor/runtime/admittedElementLoader';
            window.admit = async () => {
              const controller = new AbortController();
              const list = await readProjectElementList('dev-project', controller.signal);
              const Component = await importProjectElement(list.elements[0], controller.signal);
              const host = document.getElementById('app'); createRoot(host).render(createElement(Component));
              await new Promise((resolve) => setTimeout(resolve, 100));
              return host.textContent;
            };`;
        },
      }, createExtensionImportMapPlugin()],
    });
    const http = createHttpServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const send = (type: string, body: string) => { response.setHeader('content-type', type); response.end(body); };
      if (url.pathname === '/') {
        return send('text/html', await server.transformIndexHtml('/', `<!doctype html><html><head></head><body><div id="app"></div><script type="module" src="${PAGE}"></script></body></html>`));
      }
      if (url.pathname === '/api/runtime/packs/project-elements') {
        return send('application/json', JSON.stringify({
          version: 1, projectId: 'dev-project', realmId: 'realm', selectionDigest: 'a'.repeat(64), legacy: [], projects: [],
          elements: [{
            ref: { packId: 'project_dev', kind: 'effect', id: 'dev', revision: 'r1' }, digest,
            url: `/api/runtime/packs/project-elements/dev-project/${digest}.js`,
            descriptor: { packId: 'project_dev', kind: 'effect', id: 'dev', revision: 'r1', label: 'Dev', description: '', componentPath: 'elements/dev/component.tsx',
              parameters: [], defaults: {}, renderability: { preview: 'supported', browserExport: 'supported', workerExport: 'unknown' } },
            authoring: { packRoot: '/w', descriptorPath: '/w/d', componentPath: '/w/c', status: 'admitted' },
          }],
        }));
      }
      if (url.pathname === `/api/runtime/packs/project-elements/dev-project/${digest}.js`) return send('text/javascript', bytes);
      server.middlewares(request, response, () => { response.statusCode = 404; response.end(); });
    });
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    // Let the dev optimizer settle on every dependency the page and wrappers import before the browser loads them, so
    // React is pre-bundled once (a mid-load re-optimize would hand the browser two React copies, which is a test artifact).
    await server.transformIndexHtml('/', '<html><head></head><body></body></html>');
    await server.transformRequest(PAGE);
    await server.waitForRequestsIdle();
    const browser = await chromium.launch();
    browsers.push(browser);
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${(http.address() as { port: number }).port}/`, );
      await page.waitForFunction(() => typeof (window as unknown as { admit?: unknown }).admit === 'function', undefined, { timeout: 60_000 });
      const rendered = await page.evaluate(() => (window as unknown as { admit: () => Promise<string> }).admit());
      expect(errors).toEqual([]);
      expect(rendered).toBe('dev element');
    } finally { await server.close(); }
  }, 120_000);
});

describe('extension shared module import map build', () => {
  it('wires the import map plugin into the actual App config for build and dev', async () => {
    const envNames = [
      'ASTRID_CHECKOUT', 'ASTRID_PUBLIC_CHECKOUT', 'ASTRID_ELEMENT_ARTIFACT_ROOT',
      'ASTRID_PROJECT_PACKS_ROOT', 'VITE_WORKSPACE_RUNTIME_URL', 'WORKSPACE_RUNTIME_TOKEN_FILE',
    ];
    const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
    process.env.ASTRID_CHECKOUT = path.join(APP_ROOT, 'vendor/astrid-browser');
    for (const name of envNames) if (name !== 'ASTRID_CHECKOUT') delete process.env[name];
    try {
      const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'production' },
        path.join(APP_ROOT, 'config/vite/vite.config.ts'),
      );
      expect(loaded).not.toBeNull();
      const flatten = (plugins: unknown[]): unknown[] => plugins.flatMap((plugin) => (
        Array.isArray(plugin) ? flatten(plugin) : [plugin]
      ));
      const plugins = flatten((loaded!.config.plugins ?? []) as unknown[]);
      // Applies in dev and build alike: one loader and one import map contract in both.
      expect(plugins.some((plugin) => (
        typeof plugin === 'object' && plugin !== null
        && (plugin as { name?: unknown }).name === 'astrid-extension-import-map'
        && (plugin as { apply?: unknown }).apply === undefined
      ))).toBe(true);
    } finally {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('builds native singleton entry wrappers and imports a real pack with host identity', async () => {
    const {
      createExtensionImportMapPlugin, EXTENSION_IMPORT_MAP_ID,
      EXTENSION_SHARED_MODULES_FILE, EXTENSION_SHARED_MODULES_ID,
    } = await import('./extensionImportMap');
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'astrid-extension-import-map-')));
    tempRoots.push(root);
    const appRoot = path.join(root, 'app');
    const packRoot = path.join(root, 'pack');
    const dist = path.join(root, 'dist');
    await Promise.all([
      writeFixture(appRoot, 'index.html', '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>'),
      writeFixture(appRoot, 'package-lock.json', JSON.stringify({ packages: {
        'node_modules/react': { version: '18.3.1' },
        'node_modules/react-dom': { version: '18.3.1' },
        'node_modules/remotion': { version: '4.0.509' },
      } })),
      writeFixture(appRoot, 'src/main.js', `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Fragment as JSXFragment, jsx, jsxs } from 'react/jsx-runtime';
        import { jsxDEV } from 'react/jsx-dev-runtime';
        import { AbsoluteFill } from 'remotion';
        import { defineExtension } from '@astrid/editor-sdk';
        window.hostReact = React;
        window.hostCreateRoot = createRoot;
        window.hostJSX = jsx;
        window.hostJSXS = jsxs;
        window.hostJSXDEV = jsxDEV;
        window.hostJSXFragment = JSXFragment;
        window.hostAbsoluteFill = AbsoluteFill;
        window.hostDefineExtension = defineExtension;
        window.root = createRoot(document.getElementById('root'));
        window.root.render(React.createElement('div', { id: 'host-rendered' }, 'host ready'));
        window.packLoad = import(/* @vite-ignore */ '/pack/index.js').then(async (pack) => {
          const lazy = await pack.loadLazy();
          window.packIdentity = pack.ReactRef === React
            && pack.createRootRef === createRoot
            && pack.jsxRef === jsx
            && pack.jsxsRef === jsxs
            && pack.jsxDEVRef === jsxDEV
            && pack.jsxFragmentRef === JSXFragment
            && pack.absoluteFillRef === AbsoluteFill
            && pack.defineExtensionRef === defineExtension;
          window.root.render(React.createElement('div', { id: 'pack-rendered' }, lazy.label));
        }).catch((error) => { window.packError = String(error); });
      `),
      writeFixture(packRoot, 'entry.js', `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Fragment as JSXFragment, jsx, jsxs } from 'react/jsx-runtime';
        import { jsxDEV } from 'react/jsx-dev-runtime';
        import { AbsoluteFill } from 'remotion';
        import { defineExtension } from '@astrid/editor-sdk';
        export const ReactRef = React;
        export const createRootRef = createRoot;
        export const jsxRef = jsx;
        export const jsxsRef = jsxs;
        export const jsxDEVRef = jsxDEV;
        export const jsxFragmentRef = JSXFragment;
        export const absoluteFillRef = AbsoluteFill;
        export const defineExtensionRef = defineExtension;
        export const loadLazy = () => import('./lazy.js');
        export default defineExtension({
          manifest: { id: 'com.astrid.import-map-test', version: '1.0.0', label: 'Import map fixture', apiVersion: 1, contributions: [] },
        });
      `),
      writeFixture(packRoot, 'lazy.js', 'export const label = "lazy pack rendered";'),
    ]);

    await build({
      configFile: false,
      root: appRoot,
      base: '/',
      plugins: [createExtensionImportMapPlugin()],
      resolve: {
        alias: [
          { find: /^@\//, replacement: `${path.join(APP_ROOT, 'src')}/` },
          { find: /^react$/, replacement: path.join(APP_ROOT, 'node_modules/react/index.js') },
          { find: /^react\/jsx-runtime$/, replacement: path.join(APP_ROOT, 'node_modules/react/jsx-runtime.js') },
          { find: /^react\/jsx-dev-runtime$/, replacement: path.join(APP_ROOT, 'node_modules/react/jsx-dev-runtime.js') },
          { find: /^react-dom\/client$/, replacement: path.join(APP_ROOT, 'node_modules/react-dom/client.js') },
          { find: /^remotion$/, replacement: path.join(APP_ROOT, 'node_modules/remotion/dist/esm/index.mjs') },
          { find: /^@astrid\/editor-sdk$/, replacement: path.join(APP_ROOT, 'src/sdk/index.ts') },
        ],
      },
      build: {
        outDir: dist,
        assetsDir: 'assets',
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: path.join(appRoot, 'index.html'), external: ['/pack/index.js'] },
      },
    });

    await build({
      configFile: false,
      root: packRoot,
      base: '/',
      build: {
        outDir: path.join(dist, 'pack'),
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          input: path.join(packRoot, 'entry.js'),
          preserveEntrySignatures: 'strict',
          external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'remotion', '@astrid/editor-sdk'],
          output: { format: 'es', entryFileNames: 'index.js', chunkFileNames: 'chunks/[name]-[hash].js', minifyInternalExports: false },
        },
      },
    });

    const html = await readFile(path.join(dist, 'index.html'), 'utf8');
    const lock = JSON.parse(await readFile(path.join(dist, EXTENSION_SHARED_MODULES_FILE), 'utf8')) as ExtensionSharedModuleLock;
    const importMapPosition = html.indexOf(`id="${EXTENSION_IMPORT_MAP_ID}"`);
    const lockPosition = html.indexOf(`id="${EXTENSION_SHARED_MODULES_ID}"`);
    const firstModuleScript = html.indexOf('<script type="module"');
    expect(lock.version).toBe(1);
    expect(Object.keys(lock.shared_modules).sort()).toEqual([
      '@astrid/editor-sdk', 'react', 'react-dom/client', 'react/jsx-dev-runtime', 'react/jsx-runtime', 'remotion',
    ]);
    expect(lockPosition).toBeGreaterThan(html.indexOf('<head'));
    expect(importMapPosition).toBeGreaterThan(lockPosition);
    expect(firstModuleScript).toBeGreaterThan(importMapPosition);
    for (const binding of Object.values(lock.shared_modules)) {
      const file = path.join(dist, binding.url.replace(/^\//, ''));
      expect(sha256(await readFile(file))).toBe(binding.sha256);
    }
    const importMapMatch = html.match(new RegExp(`<script type="importmap" id="${EXTENSION_IMPORT_MAP_ID}">(.*?)</script>`));
    expect(importMapMatch).not.toBeNull();
    const importMap = JSON.parse(importMapMatch![1]) as { imports: Record<string, string> };
    expect(importMap.imports).toEqual(Object.fromEntries(
      Object.entries(lock.shared_modules).map(([specifier, binding]) => [specifier, binding.url]),
    ));

    const browser = await chromium.launch({
      headless: true,
      // Unset: Playwright's own Chromium (installed by App Tests). A sandbox-only path here broke CI.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox'],
    });
    browsers.push(browser);
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    const baseUrl = await serveDirectory(dist);
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as typeof window & { packLoad?: Promise<void> }).packLoad !== undefined, { timeout: 5_000 });
    await page.waitForSelector('#pack-rendered', { timeout: 5_000 }).catch(async () => {
      const state = await page.evaluate(() => ({
        error: (window as typeof window & { packError?: string }).packError,
        identity: (window as typeof window & { packIdentity?: boolean }).packIdentity,
        host: Boolean(document.querySelector('#host-rendered')),
      }));
      throw new Error(`Native browser import failed: ${JSON.stringify({ state, browserErrors })}`);
    });
    expect(await page.locator('#pack-rendered').textContent()).toBe('lazy pack rendered');
    expect(await page.evaluate(() => (window as typeof window & { packIdentity?: boolean }).packIdentity)).toBe(true);
    expect(await page.evaluate(() => (window as typeof window & { packError?: string }).packError)).toBeUndefined();
  }, 30_000);
});
