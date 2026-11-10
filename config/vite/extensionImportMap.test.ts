// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build, loadConfigFromFile } from 'vite';
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

describe('extension shared module import map build', () => {
  it('wires the import map plugin into the actual App build config', async () => {
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
      expect(plugins.some((plugin) => (
        typeof plugin === 'object' && plugin !== null
        && (plugin as { name?: unknown }).name === 'astrid-extension-import-map'
        && (plugin as { apply?: unknown }).apply === 'build'
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
