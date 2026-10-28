import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Runtime's published visual-field readback (P-P1c-L3r5 handoff). Its authored
// fields are drawn as published, on the same 24 fps basis the Runtime accepted.
const HANDOFF_PATH = 'tests/e2e/local/support/p1-runtime-visual-fields-readback.json';
const HANDOFF_SHA256 = 'ae2da01b8d63d5e5b2fc4c8e4568a469676da8a761fb68c542657354fdc4a06a';
const FIXTURE_FPS = 24;

// One set of bytes feeds both products: the Player gets them inline as
// data:image/svg+xml;base64 URIs, and the installed package (which resolves
// non-http asset files through Remotion staticFile and cannot read data: URIs)
// gets the same bytes as files in the bundle's public dir.
const SOLID_COLORS = { 'solid.svg': '#e85030', 'second.svg': '#3080d0', 'under.svg': '#505050' } as const;
const solidSvg = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${color}"/></svg>`;
const solidImage = (color: string) => `data:image/svg+xml;base64,${Buffer.from(solidSvg(color)).toString('base64')}`;

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } });

// The real preview and installed export are sampled at the same frames. All
// files and the Vite cache live in Playwright's private result directory.
test('visual fields draw in preview and installed export', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const root = process.cwd();
  const handoffBytes = await readFile(join(root, HANDOFF_PATH));
  expect(createHash('sha256').update(handoffBytes).digest('hex')).toBe(HANDOFF_SHA256);
  const handoff = JSON.parse(handoffBytes.toString()) as { cases: Array<{
    case_key: string;
    authored_visual_fields: Record<string, unknown>;
    frame_basis: { published_output: { fps: number }; setter_fps: number };
  }> };
  const dir = testInfo.outputPath('visual-fields');
  await mkdir(dir, { recursive: true });
  const peers = '/home/user/work/runtimes/agent-remotion-0013/node_modules';
  const require = createRequire(join(peers, '../package.json'));
  const { bundle } = require('@remotion/bundler');
  const { renderStill, selectComposition } = require('@remotion/renderer');
  const appImport = (path: string) => JSON.stringify(join(root, path));
  await writeFile(join(dir, 'index.html'), `<html><head><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body style="margin:0"><div id="player"></div><script type="module" src="./preview.tsx"></script></body></html>`);
  await writeFile(join(dir, 'preview.tsx'), `
import React, {createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {TimelineRenderer} from ${appImport('src/tools/video-editor/compositions/TimelineRenderer.tsx')};
import {INSTALLED_ASTRID_ELEMENT_HOST} from ${appImport('src/tools/video-editor/runtime/astrid-element-components.tsx')};
import {resolveTimelineConfig} from ${appImport('src/tools/video-editor/lib/config-utils.ts')};
const root = createRoot(document.getElementById('player'));
window.drawFixture = async config => {
  const resolved = await resolveTimelineConfig(config, config.registry, async file => file);
  const ref = createRef();
  const Component = () => <TimelineRenderer config={resolved} astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST}/>;
  root.render(<Player ref={ref} component={Component} inputProps={{}} durationInFrames={48} fps={24}
    compositionWidth={160} compositionHeight={90} controls={false} style={{width:160,height:90}}/>);
  for (let i=0; !ref.current && i<100; i++) await new Promise(r=>setTimeout(r, 20));
  if (!ref.current) throw Error('Player did not mount');
  window.seekFixture = async frame => {
    ref.current.seekTo(frame);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await Promise.all([...document.querySelectorAll('img')].map(img=>img.decode()));
    return ref.current.getCurrentFrame();
  };
};
window.fixtureReady = true;
`);
  await writeFile(join(dir, 'export.tsx'), `
import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {TimelineComposition, compileCanonicalTransitions, toRuntimeTheme} from '@banodoco/timeline-composition';
import {BUNDLED_THEMES} from '@banodoco/timeline-composition/registry.generated';
const Draw = props => {
  // The bundled 2rp theme owns the registered section-hook element the Player draws and is black like the preview root.
  const merge = (base, overlay) => Object.fromEntries(Object.entries({...base, ...overlay}).map(([key, value]) => [key,
    value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object' ? merge(base[key], overlay?.[key]) : (overlay && key in overlay ? overlay[key] : value)]));
  // The same theme_overrides the preview resolves: the element paints that opaque theme background (blank title), so no text or font metrics are drawn.
  const theme = merge(BUNDLED_THEMES['2rp'], props.timeline.theme_overrides ?? {});
  const tracks = props.timeline.tracks.filter(t => t.kind === 'visual').map(track => ({track, clips: props.timeline.clips.filter(c => c.track === track.id)}));
  const compiledTransitions = compileCanonicalTransitions(tracks, 24, toRuntimeTheme(theme));
  return <TimelineComposition {...props} theme={theme} compiledTransitions={compiledTransitions}/>;
};
registerRoot(() => <Composition id="Fields" component={Draw} durationInFrames={48} fps={24} width={160} height={90} defaultProps={{timeline:{tracks:[],clips:[]},assets:{}}}/>);
`);
  const server = await createServer({
    configFile: join(root, 'config/vite/vite.config.ts'), cacheDir: join(dir, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, dir] } },
  });
  let serveUrl: string;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.setViewportSize({ width: 160, height: 90 });
    await page.goto(`${origin}/@fs${dir}/index.html`);
    await page.waitForFunction(() => (window as any).fixtureReady, undefined, { timeout: 20_000 });
    const publicDir = join(dir, 'public');
    await mkdir(publicDir, { recursive: true });
    for (const [file, color] of Object.entries(SOLID_COLORS)) await writeFile(join(publicDir, file), solidSvg(color));
    serveUrl = await bundle({ entryPoint: join(dir, 'export.tsx'), enableCaching: false, publicDir,
      webpackOverride: (config: any) => ({ ...config, resolve: { ...config.resolve, alias: { ...config.resolve?.alias,
        react: join(root, 'node_modules/react'), 'react-dom': join(root, 'node_modules/react-dom'),
        remotion: join(root, 'node_modules/remotion'),
        // An alias bypasses the package exports map, so the subpath needs its own (earlier) entry.
        '@banodoco/timeline-composition/registry.generated': join(root, 'node_modules/@banodoco/timeline-composition/dist/registry.generated.js'),
        '@banodoco/timeline-composition': join(root, 'node_modules/@banodoco/timeline-composition'),
      } } }),
    });
    // The lane pins one headless_shell build; use the installed one when that path is gone.
    const pinnedBrowser = process.env.ASTRID_REMOTION_BROWSER_EXECUTABLE;
    const installedShell = '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
    const browserExecutable = pinnedBrowser && !existsSync(pinnedBrowser) && existsSync(installedShell) ? installedShell : pinnedBrowser;
    type Case = [string, 'exit' | 'entrance' | 'transition' | 'effects', unknown, number[], string | undefined, string | undefined];
    // Drawn exactly as the Runtime published it (field JSON and fps basis).
    const published = (name: string, key: string, frames: number[], variant?: string): Case => {
      const found = handoff.cases.find(item => item.case_key === key);
      if (!found) throw new Error(`Runtime handoff has no case ${key}`);
      expect(found.frame_basis.published_output.fps, `${key} published fps`).toBe(FIXTURE_FPS);
      expect(found.frame_basis.setter_fps, `${key} setter fps`).toBe(FIXTURE_FPS);
      const [field, reference] = Object.entries(found.authored_visual_fields)[0];
      return [name, field as Case[1], reference, frames, variant, key];
    };
    // Extra forms the package also draws; not part of the Runtime table.
    const extra = (name: string, field: Case[1], reference: unknown, frames: number[], variant?: string): Case =>
      [name, field, reference, frames, variant, undefined];
    const cases: Case[] = [
      published('fade-exit', 'exit.fade', [11, 18, 24]),
      published('slide-up-exit', 'exit.slide-up', [11, 18, 24]),
      extra('slide-up-exit-legacy', 'exit', { type: 'slide-up', duration: 8 / 30 }, [15, 20, 24]),
      published('fade-entrance-step', 'entrance.fade', [0, 6, 12]),
      extra('fade-entrance-step-top-level', 'entrance', { id: 'fade', durationFrames: 8, easing: 'step' }, [0, 4, 8]),
      published('fade-entrance-linear-params', 'entrance.fade.linear', [0, 6, 12]),
      extra('fade-entrance-linear', 'entrance', { id: 'fade', durationFrames: 12, easing: 'linear' }, [0, 6, 12]),
      extra('fade-entrance-legacy', 'entrance', { type: 'fade', duration: 0.5 }, [0, 2, 7, 12]),
      published('fade-up-entrance', 'entrance.fade-up', [0, 3, 6, 9, 18]),
      extra('fade-up-entrance-legacy', 'entrance', { type: 'fade-up', duration: 8 / 30, params: { easing: 'ease-in' } }, [0, 2, 3, 6, 8]),
      published('scale-in-entrance', 'entrance.scale-in', [0, 2, 9, 18]),
      published('fade-transition', 'transition.fade.explicit-frames', [15, 20, 24]),
      published('fade-transition-default', 'transition.fade.default', [15, 20, 24]),
      extra('fade-transition-legacy', 'transition', { type: 'fade', duration: 0.5 }, [11, 18, 24]),
      extra('cross-fade-transition-explicit', 'transition', { id: 'cross-fade', durationFrames: 8 }, [15, 20, 24]),
      published('cross-fade-transition-default', 'transition.cross-fade.default', [15, 20, 24]),
      published('cross-fade-transition-legacy', 'transition.cross-fade.legacy-seconds', [11, 18, 24]),
      published('effects-object', 'effects.object', [0, 3, 6, 11, 18, 24]),
      published('effects-array', 'effects.array', [0, 3, 6, 11, 18, 24]),
      published('element-fade-entrance', 'entrance.fade.linear', [0, 6, 12], 'element'),
      published('element-fade-transition', 'transition.fade.explicit-frames', [15, 20, 24], 'element'),
      published('element-effects-object', 'effects.object', [0, 3, 6, 11, 18, 24], 'element'),
      published('element-effects-array', 'effects.array', [0, 3, 6, 11, 18, 24], 'element'),
    ];
    const captures: object[] = [];
    for (const [name, field, reference, frames, variant, handoffKey] of cases) {
      const track = { id: 'picture', kind: 'visual', fit: 'contain' };
      const element = { clipType: 'section-hook', params: { title: ' ', entrance: [], exit: [] } };
      const clips = [
        { id: 'first', track: 'picture', clipType: 'media', at: 0, hold: 1, asset: 'solid', ...(variant && field !== 'transition' ? element : {}), ...(field !== 'transition' ? { [field]: reference } : {}) },
        { id: 'second', track: 'picture', clipType: 'media', at: 1, hold: 1, asset: 'second', ...(variant && field === 'transition' ? element : {}), ...(field === 'transition' ? { transition: reference } : {}) },
        // The element paints the opaque theme background (a light grey, 64 levels above this clip), so
        // this plain media clip on the track below is what a faded or transitioning element reveals.
        // The small level gap keeps 8-bit group-opacity rounding of the two browsers under the bound.
        ...(variant ? [{ id: 'under', track: 'under', clipType: 'media', at: 0, hold: 2, asset: 'under' }] : []),
      ];
      const config = { output: { resolution: '160x90', fps: FIXTURE_FPS, file: 'fixture.mp4' }, theme_overrides: { visual: { color: { bg: variant ? '#909090' : '#000000' } } }, tracks: [track, ...(variant ? [{ id: 'under', kind: 'visual', fit: 'contain' }] : [])], clips,
        registry: { assets: { solid: { file: solidImage(SOLID_COLORS['solid.svg']), type: 'image/svg+xml' },
          second: { file: solidImage(SOLID_COLORS['second.svg']), type: 'image/svg+xml' },
          under: { file: solidImage(SOLID_COLORS['under.svg']), type: 'image/svg+xml' } } } };
      const exportRegistry = { assets: { solid: { file: 'solid.svg', type: 'image/svg+xml' },
        second: { file: 'second.svg', type: 'image/svg+xml' },
        under: { file: 'under.svg', type: 'image/svg+xml' } } };
      const baseline = { ...config, clips: clips.map(clip => {
        const copy = { ...clip } as Record<string, unknown>;
        delete copy[field];
        return copy;
      }) };
      const inputProps = { timeline: { ...config, registry: exportRegistry }, assets: exportRegistry };
      const composition = await selectComposition({ serveUrl, id: 'Fields', browserExecutable, inputProps });
      await page.evaluate(async value => (window as any).drawFixture(value), baseline);
      for (const frame of frames) {
        await page.evaluate(async f => (window as any).seekFixture(f), frame);
        await page.locator('#player').screenshot({ path: join(dir, `${name}-${frame}-baseline.png`) });
      }
      await page.evaluate(async config => (window as any).drawFixture(config), config);
      let changedInWindow = false;
      for (const frame of frames) {
        expect(await page.evaluate(async f => (window as any).seekFixture(f), frame)).toBe(frame);
        const preview = join(dir, `${name}-${frame}-preview.png`);
        const exported = join(dir, `${name}-${frame}-export.png`);
        await page.locator('#player').screenshot({ path: preview });
        await renderStill({ composition, serveUrl, browserExecutable, frame, output: exported, imageFormat: 'png',
          inputProps });
        const rgb = (path: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
        const left = rgb(preview), right = rgb(exported);
        expect(left.length).toBe(right.length);
        const baselineDiffers = !left.equals(rgb(join(dir, `${name}-${frame}-baseline.png`)));
        if (frame > 0 && frame !== frames[frames.length - 1] && baselineDiffers) changedInWindow = true;
        let max = 0, total = 0;
        for (let i = 0; i < left.length; i++) { const delta = Math.abs(left[i] - right[i]); max = Math.max(max, delta); total += delta; }
        captures.push({ name, handoffKey, handoffSha256: HANDOFF_SHA256, field, reference, fps: FIXTURE_FPS, frame, max, mean: total / left.length, baselineDiffers });
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(captures, null, 2));
        expect.soft(max, `${name} frame ${frame} maximum RGB delta`).toBeLessThanOrEqual(2);
        expect.soft(total / left.length, `${name} frame ${frame} mean RGB delta`).toBeLessThanOrEqual(0.25);
      }
      expect(changedInWindow, `${name} must change an in-window drawing`).toBe(true);
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(captures, null, 2));
    expect(captures.every((item: any) => item.max <= 2 && item.mean <= 0.25)).toBe(true);
  } finally {
    await server.close();
  }
});
