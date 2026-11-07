// @vitest-environment node
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { chromium } from '@playwright/test';
import { createWorkspaceRuntimeProxyOptions } from '../../../../config/vite/runtimeProxy';

it('renders a real M1-installed effect in the open editor and retains the working revision through refused updates', async () => {
  const rewrite = createWorkspaceRuntimeProxyOptions('http://127.0.0.1:1', null).rewrite!;
  expect(rewrite('/api/runtime/packs/inventory')).toBe('/api/runtime/packs/inventory');
  expect(rewrite('/api/runtime/v1/projects')).toBe('/v1/projects');
  const app = process.cwd();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'installed-pack-journey-')));
  const dist = path.join(root, 'dist');
  let child: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'package-lock.json'), await readFile(path.join(app, 'package-lock.json')));
    await writeFile(path.join(root, 'index.html'), '<html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
    await writeFile(path.join(root, 'src/main.tsx'), `
      import React,{useEffect,useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Player} from '@remotion/player';
      import {defineExtension} from '@astrid/editor-sdk';
      import {useRuntimePackExtensions} from '@/tools/video-editor/runtime/useRuntimePackExtensions';
      import {PackageCard} from '@/tools/video-editor/components/ExtensionManager/PackageCard';
      import {createExtensionLifecycleHost,createExtensionDiagnosticsService} from '@/tools/video-editor/runtime/extensionLifecycle';
      import {createExtensionContext} from '@/tools/video-editor/runtime/extensionContextFactory';
      import {createEffectRegistrationService} from '@/tools/video-editor/runtime/effectRegistrationService';
      import {createEffectRegistry} from '@/tools/video-editor/effects/registry/EffectRegistry';
      import {createCommandRegistry} from '@/tools/video-editor/runtime/commandRegistry';
      import {onExtensionContextCommit} from '@/tools/video-editor/runtime/extensionActivationTransaction';
      import {EffectLayerSequence} from '@/tools/video-editor/compositions/EffectLayerSequence';
      const effects=createEffectRegistry(), commands=createCommandRegistry(), host=createExtensionLifecycleHost();
      window.proof={effects,commands,host,mounts:0};
      window.hostSingletons={React,defineExtension};
      host.onLifecycleDisposed(id=>{commands.unregisterAll(id);effects.unregisterOwner(id)});
      function context(extension){
        const id=extension.manifest.id;
        const ctx=createExtensionContext(extension,undefined,
          {registerCommand:(...args)=>commands.registerCommand(id,...args)},
          createEffectRegistrationService({extension,effectRegistry:effects,diagnosticsService:createExtensionDiagnosticsService(id)}));
        onExtensionContextCommit(ctx,()=>{for(const c of extension.manifest.contributions)if(c.kind==='command')commands.ingestCommandContribution(id,c)});
        return ctx;
      }
      const subscribe=cb=>{const h=effects.subscribe(cb);return ()=>h.dispose()};
      function Composition(){
        const snapshot=useSyncExternalStore(subscribe,()=>effects.getSnapshot());
        return React.createElement(EffectLayerSequence,{clip:{id:'live',clipType:'effect-layer',track:'V1',at:0,hold:2,
          continuous:{type:'installed-effect',intensity:1,params:{}}},fps:30,effectRegistrySnapshot:snapshot},
          React.createElement('span',{'data-testid':'editor-content'},'Editor already open'));
      }
      function App(){
        const wiring=useRuntimePackExtensions(undefined,100);
        useEffect(()=>{window.proof.mounts++;return ()=>host.disposeAll()},[]);
        useEffect(()=>{
          if(wiring.isResolving)return;
          host.synchronize(wiring.resolvedExtensions,context);
          window.proof.diagnostics=wiring.diagnostics;
          window.proof.packageStates=wiring.packageStateEntries;
          window.proof.error=wiring.error?.message;
        },[wiring.resolvedExtensions,wiring.isResolving,wiring.error]);
        return React.createElement(React.Fragment,null,
          React.createElement(Player,{component:Composition,durationInFrames:60,fps:30,compositionWidth:320,
            compositionHeight:180,style:{width:320,height:180},controls:false}),
          wiring.packageStateEntries.map(entry=>React.createElement(PackageCard,{key:entry.extensionId,entry,
            repository:wiring.repository,onToggleRequest:wiring.triggerExtensionRefresh,contributionSummary:null})));
      }
      createRoot(document.getElementById('root')).render(React.createElement(App));
    `);
    const buildScript = path.join(root, 'build.mts');
    await writeFile(buildScript, `
      import {build} from ${JSON.stringify(path.join(app, 'node_modules/vite/dist/node/index.js'))};
      import {createExtensionImportMapPlugin} from ${JSON.stringify(path.join(app, 'config/vite/extensionImportMap.ts'))};
      import {createElementAdmissionsPlugin} from ${JSON.stringify(path.join(app, 'config/vite/astridElementAdmissions.ts'))};
      await build({configFile:false,root:${JSON.stringify(root)},publicDir:false,logLevel:'error',
        plugins:[createElementAdmissionsPlugin(),createExtensionImportMapPlugin()],esbuild:{jsx:'automatic'},resolve:{alias:${JSON.stringify({
          '@': path.join(app, 'src'), '@astrid/editor-sdk': path.join(app, 'src/sdk/index.ts'),
          '@astrid': path.join(process.env.M4_TEST_AGENT_ROOT!, 'astrid'),
          react: path.join(app, 'node_modules/react'), 'react-dom': path.join(app, 'node_modules/react-dom'),
          remotion: path.join(app, 'node_modules/remotion'), '@remotion/player': path.join(app, 'node_modules/@remotion/player'),
          '@remotion/layout-utils': path.join(app, 'node_modules/@remotion/layout-utils'),
          '@remotion/media': path.join(app, 'node_modules/@remotion/media'),
          // @banodoco/timeline-composition resolves through its package exports, as in config/vite/vite.config.ts
          // (pre-main ships it built under dist/; the old typescript/src subpath aliases no longer exist).
          '@workspace-effects': path.join(app, 'vendor/banodoco-effects'),
          '@workspace-animations': path.join(app, 'vendor/banodoco-animations'),
          '@workspace-transitions': path.join(app, 'vendor/banodoco-transitions'),
        })},dedupe:['react','react-dom','remotion']},build:{outDir:${JSON.stringify(dist)},target:'esnext',minify:false}});
    `);
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
    await promisify(execFile)(process.execPath, ['--import', path.join(app, 'node_modules/tsx/dist/loader.mjs'), buildScript], { env, maxBuffer: 2_000_000 });
    const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Set explicit ${key} for the frozen integration tuple`); return value; };
    child = spawn(required('M4_TEST_PYTHON'), ['-B', '-S', path.join(app, 'src/tools/video-editor/runtime/fixtures/runtime_pack_journey.py'), root,
      required('M4_TEST_AGENT_ROOT'), required('M4_TEST_RUNTIME_ROOT'), required('M4_TEST_PYTHON_SITE'),
      process.execPath, path.join(app, 'node_modules/esbuild/bin/esbuild'), path.join(dist, 'extension-shared-modules.json')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr!.on('data', data => { stderr += data.toString(); });
    async function next() {
      const line = await lines.next();
      if (line.done) throw new Error(`Runtime fixture exited: ${stderr}`);
      return JSON.parse(line.value);
    }
    const runtime = await next();
    const runtimeProxy = createWorkspaceRuntimeProxyOptions(runtime.endpoint, runtime.token);
    async function command(command: string) {
      child!.stdin!.write(JSON.stringify({ command }) + '\n');
      const result = await next();
      if (!result.ok) throw new Error(result.error);
      return result.result;
    }
    const requests: string[] = [];
    server = createServer(async (request, response) => {
      const url = request.url ?? '/';
      requests.push(url);
      if (url.startsWith('/api/runtime/')) {
        try {
          const upstream = await fetch(runtime.endpoint + runtimeProxy.rewrite!(url), { method: request.method,
            headers: runtimeProxy.headers as Record<string, string>, redirect: 'manual' });
          response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
          response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) { response.writeHead(502).end(String(error)); }
        return;
      }
      try {
        const filename = path.resolve(dist, url === '/' ? 'index.html' : url.slice(1));
        if (!filename.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
        // Read before writing headers, so a missing file is still a clean 404 (never a second writeHead).
        const body = await readFile(filename);
        response.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html' : 'text/javascript' });
        response.end(body);
      } catch { if (!response.headersSent) response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing App listener');
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByTestId('editor-content').waitFor();
    expect(await page.getByTestId('installed-effect').count()).toBe(0);
    const first = await command('install');
    await page.getByTestId('installed-effect').waitFor();
    expect(await page.getByTestId('installed-effect').getAttribute('data-revision')).toBe('v1');
    expect(await page.getByTestId('installed-effect').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(25, 95, 175)');
    if (process.env.M4_PROOF_DIR) {
      await mkdir(process.env.M4_PROOF_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.M4_PROOF_DIR, 'installed-effect-v1.png') });
    }
    expect(await page.evaluate(() => (window as any).proof.commands.executeCommand('com.test.installed-effect.ping'))).toBe(true);
    expect(await page.evaluate(() => (window as any).pings)).toBe(1);
    const oldPrefix = `/api/runtime/packs/assets/native_effect/${first.admission.digest}/`;
    expect(requests.filter(url => url.startsWith(oldPrefix)).every(url => url.endsWith('/index.js'))).toBe(true);
    expect((await command('compileFail')).failedBuild).toBe(true);
    for (const mode of ['activateFail', 'badIdentity', 'badApi']) {
      await command(mode);
      await page.waitForFunction(mode => {
        const proof = (window as any).proof;
        if (mode === 'activateFail') return proof.host.diagnostics.some((d: any) => d.code === 'lifecycle/activation-failed');
        if (mode === 'badIdentity') return proof.diagnostics?.some((d: any) => d.code === 'loader/module-identity');
        return proof.packageStates?.some((state: any) => state.packageState === 'incompatible')
          || proof.diagnostics?.some((d: any) => d.code === 'loader/module-identity' && d.detail?.revision === null);
      }, mode);
      expect(await page.getByTestId('installed-effect').getAttribute('data-revision')).toBe('v1');
    }
    await command('hash');
    await page.waitForFunction(() => !!(window as any).proof.error);
    expect(await page.getByTestId('installed-effect').getAttribute('data-revision')).toBe('v1');
    expect(await page.evaluate(() => (window as any).loadInstalledLazy())).toBe('late-v1');
    expect(requests.some(url => url.startsWith(oldPrefix) && !url.endsWith('/index.js'))).toBe(true);
    const traversal = await page.request.get(`http://127.0.0.1:${address.port}${oldPrefix}%2e%2e/secret.js`);
    expect([400, 404]).toContain(traversal.status());
    // Restore a valid install, then prove a successful same-version replacement.
    await command('v2');
    await page.waitForFunction(() => document.querySelector('[data-revision="v2"]') !== null);
    if (process.env.M4_PROOF_DIR) await page.screenshot({ path: path.join(process.env.M4_PROOF_DIR, 'installed-effect-v2.png') });
    await page.getByRole('button', { name: 'Disable com.test.installed-effect', exact: true }).click();
    await page.waitForFunction(() => !(window as any).proof.effects.resolve('installed-effect'));
    expect(await page.getByTestId('installed-effect').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).proof.commands.executeCommand('com.test.installed-effect.ping'))).toBe(false);
    await expect.poll(() => command('leases')).toBe(0);
    await page.getByRole('button', { name: 'Enable com.test.installed-effect', exact: true }).click();
    await page.getByTestId('installed-effect').waitFor();
    await command('uninstall');
    await page.waitForFunction(() => !(window as any).proof.effects.resolve('installed-effect'));
    expect(await page.evaluate(() => (window as any).proof.mounts)).toBe(1);
    expect(errors).toEqual([]);
    const old = await page.request.get(`http://127.0.0.1:${address.port}${oldPrefix}index.js`);
    expect(old.status()).toBe(404);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    if (child) {
      child.stdin?.end();
      if (child.exitCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
