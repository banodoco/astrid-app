import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defineExtension } from '@astrid/editor-sdk';
import type { ExtensionStateRepository } from './extensionStateRepository';
import { useExtensionLoaderWiring } from './useExtensionLoaderWiring';

describe('useExtensionLoaderWiring repository hydration', () => {
  it('keeps a stable hook order when a browser repository arrives asynchronously', async () => {
    const extension = defineExtension({
      manifest: {
        id: 'haus.astrid.hydration-test' as never,
        version: '1.0.0',
        label: 'Hydration test',
        contributions: [],
      },
      activate: () => ({ dispose() {} }),
    });
    const repository = {
      getFullExtensionState: vi.fn(async () => ({
        packs: {},
        enablement: {},
        devOverrides: {},
        settings: {},
      })),
    } as unknown as ExtensionStateRepository;

    const { result, rerender } = renderHook(
      ({ activeRepository }: { activeRepository: ExtensionStateRepository | null }) =>
        useExtensionLoaderWiring({
          directExtensions: [extension],
          repository: activeRepository,
        }),
      { initialProps: { activeRepository: null } },
    );

    expect(result.current.resolvedExtensions).toEqual([extension]);
    expect(result.current.isResolving).toBe(false);

    rerender({ activeRepository: repository });

    await waitFor(() => expect(result.current.isResolving).toBe(false));
    expect(repository.getFullExtensionState).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});

// Native browser composition: the only fake is the Runtime HTTP boundary.
// Repository, module import, SDK, React, hook, effect service and lifecycle host
// are the production implementations.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

function canonicalArtifact(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArtifact).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalArtifact(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digestBytes = (value: string) => createHash('sha256').update(value).digest('hex');

describe('useExtensionLoaderWiring native module composition', () => {
  it('imports a Runtime-admitted effect into the open App lifecycle with the host singletons', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'app-extension-composition-')));
    const appRoot = process.cwd();
    const dist = path.join(root, 'dist');
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(path.join(root, 'package-lock.json'), await readFile(path.join(appRoot, 'package-lock.json')));
      await writeFile(path.join(root, 'index.html'), '<html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
      await writeFile(path.join(root, 'src/main.tsx'), `
        import React, {useEffect} from 'react';
        import {createRoot} from 'react-dom/client';
        import * as jsx from 'react/jsx-runtime';
        import * as jsxDev from 'react/jsx-dev-runtime';
        import {AbsoluteFill} from 'remotion';
        import {defineExtension} from '@astrid/editor-sdk';
        import {useExtensionLoaderWiring} from '@/tools/video-editor/runtime/useExtensionLoaderWiring';
        import {createIndexedDBExtensionStateRepository} from '@/tools/video-editor/runtime/extensionStateRepositoryIndexedDB';
        import {generateIntegrityHash} from '@/tools/video-editor/runtime/extensionIntegrity';
        import {createExtensionLifecycleHost} from '@/tools/video-editor/runtime/extensionLifecycle';
        import {createExtensionContext} from '@/tools/video-editor/runtime/extensionContextFactory';
        import {createEffectRegistrationService} from '@/tools/video-editor/runtime/effectRegistrationService';
        import {createExtensionDiagnosticsService} from '@/tools/video-editor/runtime/extensionLifecycle';
        import {createEffectRegistry} from '@/tools/video-editor/effects/registry/EffectRegistry';
        window.hostSingletons={React,createRoot,jsx:jsx.jsx,jsxDev:jsxDev.jsxDEV,AbsoluteFill,defineExtension};
        window.activations=0;
        const registry=createEffectRegistry(); window.registry=registry;
        const host=createExtensionLifecycleHost(); window.host=host;
        const repository=createIndexedDBExtensionStateRepository();
        await repository.initialize();
        const artifact=await fetch('/fixture.json').then(r=>r.json());
        const content=JSON.stringify(artifact);
        await repository.putBundleContent('admitted-effect',content);
        await repository.putPackRecord({extensionId:artifact.extensionManifest.id,
          version:'1.0.0',apiVersion:1,integrity:await generateIntegrityHash(content),
          installedAt:'2026-11-02T00:00:00.000Z',bundleContentRef:'admitted-effect',
          publisher:'Test Publisher',license:'MIT',manifestSnapshot:artifact.extensionManifest});
        function App(){
          const wiring=useExtensionLoaderWiring({repository,bundleStore:repository});
          useEffect(()=>{
            if(wiring.isResolving || !wiring.loaderResult) return;
            window.loadedBeforeActivation=registry.resolve('fixture-effect')!==undefined;
            const synchronize=()=>host.synchronize(wiring.resolvedExtensions,extension=>{
              const effects=createEffectRegistrationService({extension,effectRegistry:registry,
                diagnosticsService:createExtensionDiagnosticsService(extension.manifest.id)});
              return createExtensionContext(extension,undefined,undefined,effects);
            });
            synchronize(); window.synchronize=synchronize;
            window.compositionResult={loaded:wiring.loaderResult.allLoaded,
              errors:wiring.diagnostics.filter(d=>d.severity==='error').map(d=>d.message),
              state:host.lifecycles.get(artifact.extensionManifest.id)?.state,
              effect:registry.resolve('fixture-effect')?.effectId,
              componentType:typeof registry.resolve('fixture-effect')?.component};
          },[wiring.isResolving,wiring.loaderResult]);
          return React.createElement('div',null,'App is open');
        }
        createRoot(document.getElementById('root')).render(React.createElement(App));
      `);
      // Run the real Vite builder in a Node realm. jsdom's typed-array realm
      // differs from Node's, which esbuild correctly refuses.
      const buildScript = path.join(root, 'build.mts');
      await writeFile(buildScript, `
        import {build} from ${JSON.stringify(path.join(appRoot, 'node_modules/vite/dist/node/index.js'))};
        import {createExtensionImportMapPlugin} from ${JSON.stringify(path.join(appRoot, 'config/vite/extensionImportMap.ts'))};
        await build({configFile:false,root:${JSON.stringify(root)},publicDir:false,logLevel:'error',
          plugins:[createExtensionImportMapPlugin()],
          resolve:{alias:${JSON.stringify({
            '@': path.join(appRoot, 'src'),
            '@astrid/editor-sdk': path.join(appRoot, 'src/sdk/index.ts'),
            react: path.join(appRoot, 'node_modules/react'),
            'react-dom': path.join(appRoot, 'node_modules/react-dom'),
            remotion: path.join(appRoot, 'node_modules/remotion'),
          })},dedupe:['react','react-dom','remotion']},
          build:{outDir:${JSON.stringify(dist)},target:'esnext',minify:false}});
      `);
      const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'CI', 'LANG']
        .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]));
      await promisify(execFile)(process.execPath, ['--import', path.join(appRoot, 'node_modules/tsx/dist/loader.mjs'), buildScript],
        { env: childEnv, maxBuffer: 2_000_000 });
      const lock = JSON.parse(await readFile(path.join(dist, 'extension-shared-modules.json'), 'utf8'));
      const manifest = { id: 'com.test.native-effect', version: '1.0.0', apiVersion: 1,
        label: 'Native effect', publisher: 'Test Publisher', license: 'MIT',
        settingsSchema: { version: 1 },
        contributions: [{ id: 'effect', kind: 'effect', effectId: 'fixture-effect' }] };
      const chunk = 'export const label="real admitted lazy chunk";';
      const graph = digestBytes(canonicalArtifact([{ logical_path: 'chunks/effect.js',
        sha256: digestBytes(chunk), size: Buffer.byteLength(chunk), mime: 'text/javascript' }]));
      const entry = `// astrid-graph-index-sha256:${graph}\n
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {jsx} from 'react/jsx-runtime';
        import {jsxDEV} from 'react/jsx-dev-runtime';
        import {AbsoluteFill} from 'remotion';
        import {defineExtension} from '@astrid/editor-sdk';
        const {label}=await import('./chunks/effect.js');
        const host=window.hostSingletons;
        window.singletonIdentity=React===host.React && createRoot===host.createRoot && jsx===host.jsx
          && jsxDEV===host.jsxDev && AbsoluteFill===host.AbsoluteFill && defineExtension===host.defineExtension;
        window.registeredAtEvaluation=window.registry.resolve('fixture-effect')!==undefined;
        export default defineExtension({manifest:${JSON.stringify(manifest)},activate(ctx){
          window.activations++;
          return ctx.effects.registerComponent('fixture-effect',()=>React.createElement(AbsoluteFill,null,label));
        }});`;
      const digest = digestBytes(entry);
      const source = 'a'.repeat(64);
      const artifact = { version: 1, packId: 'native_effect', sourceDigest: source, digest,
        graphIndexDigest: graph, toolchainDigest: 'b'.repeat(64), entry: 'index.js',
        extensionManifest: manifest, sharedModules: lock.shared_modules,
        files: [
          { path: 'chunks/effect.js', disk: `.build/${source}/chunks/effect.js`, sha256: digestBytes(chunk), size: Buffer.byteLength(chunk), mime: 'text/javascript' },
          { path: 'index.js', disk: `.build/${source}.js`, sha256: digest, size: Buffer.byteLength(entry), mime: 'text/javascript' },
        ] };
      const entryUrl = `/api/runtime/packs/assets/native_effect/${digest}/index.js`;
      const chunkUrl = entryUrl.replace('index.js', 'chunks/effect.js');
      const requested: string[] = [];
      server = createServer(async (request, response) => {
        const url = request.url ?? '/'; requested.push(url);
        const json = (body: unknown) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        if (url === '/fixture.json') { json(artifact); return; }
        if (url === '/api/runtime/packs/inventory') {
          json({ version: 1, revision: 7, packs: [{ packId: artifact.packId, sourceDigest: source,
            digest, artifactManifestDigest: digestBytes(canonicalArtifact(artifact)), enabled: true, url: entryUrl }] }); return;
        }
        if (url === entryUrl || url === chunkUrl) {
          response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(url === entryUrl ? entry : chunk); return;
        }
        try {
          const filename = path.resolve(dist, url === '/' ? 'index.html' : url.slice(1));
          if (!filename.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
          const bytes = await readFile(filename);
          response.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(bytes);
        } catch { response.writeHead(404).end(); }
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => !!(window as any).compositionResult);
      expect(await page.evaluate(() => (window as any).compositionResult)).toEqual({
        loaded: true, errors: [], state: 'active', effect: 'fixture-effect', componentType: 'function',
      });
      expect(await page.evaluate(() => ({ singletons: (window as any).singletonIdentity,
        topLevel: (window as any).registeredAtEvaluation, beforeActivation: (window as any).loadedBeforeActivation,
        activations: (window as any).activations }))).toEqual({ singletons: true, topLevel: false, beforeActivation: false, activations: 1 });
      await page.evaluate(() => (window as any).synchronize());
      expect(await page.evaluate(() => (window as any).activations)).toBe(1);
      expect(requested).toContain(entryUrl);
      expect(requested).toContain(chunkUrl);
      expect(errors).toEqual([]);
      await page.evaluate(() => (window as any).host.disposeAll());
      expect(await page.evaluate(() => !!(window as any).registry.resolve('fixture-effect'))).toBe(false);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
