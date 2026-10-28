import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ENTRY_PATH,
  classifyBrowserEntry,
  prefersAppEntry,
  rememberAppEntryPreference,
  resolveInstallerConnectEntry,
  resolveReturningAppEntry,
} from './entryClassification.ts';

describe('browser entry classification', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each(['/', '/home?source=guard#public', '/vision'])(
    'serves %s from the public entry in every build', (path) => {
      expect(classifyBrowserEntry(new URL(`https://astrid.test${path}`))).toBe('public');
    },
  );

  it('preserves app ownership for protected documents', () => {
    expect(classifyBrowserEntry(new URL('https://astrid.test/tools/video-editor'))).toBe('app');
    expect(classifyBrowserEntry(new URL('https://astrid.test/tools/image-generation'))).toBe('app');
  });

  it('keeps app bootstrap and extension initialization behind dynamic app imports', () => {
    const main = readFileSync(path.join(process.cwd(), 'src/app/main.tsx'), 'utf8');
    const publicBootstrap = readFileSync(path.join(process.cwd(), 'src/app/publicBootstrap.tsx'), 'utf8');
    const shell = readFileSync(path.join(process.cwd(), 'src/pages/Home/PublicAstridShell.tsx'), 'utf8');
    const mountedEditor = readFileSync(path.join(process.cwd(), 'src/pages/Home/PublicAstridMountedEditor.tsx'), 'utf8');
    const editorParts = readFileSync(path.join(process.cwd(), 'src/pages/Home/PublicAstridEditorParts.tsx'), 'utf8');
    expect(main).toContain("import('@/app/bootstrap')");
    expect(main).toContain("import('@/tools/video-editor/browser/initializeVideoEditorExtensionRuntime.ts')");
    expect(main).not.toMatch(/import\s+\{[^}]*renderApp[^}]*\}\s+from/);
    expect(main).not.toMatch(/import\s+\{[^}]*initializeVideoEditorExtensionRuntime[^}]*\}\s+from/);
    expect(publicBootstrap).not.toContain('@/app/bootstrap');
    expect(publicBootstrap).not.toContain('initializeVideoEditorExtensionRuntime');
    expect(shell).toContain("import('./PublicAstridMountedEditor.tsx')");
    expect(shell).toContain('lazy(loadPublicAstridMountedEditor)');
    expect(shell).toContain('EditorChunkBoundary');
    expect(shell).toContain('Loading the shared editor, preview and timeline');
    expect(mountedEditor).toContain("import { PublicAstridEditorProvider } from './PublicAstridEditorProvider.tsx'");
    expect(mountedEditor).toContain('<PublicAstridPreview transportOutlet={transportOutlet} />');
    expect(mountedEditor).toContain('<PublicAstridInspector active={active} onReady={markInspectorReady} />');
    expect(mountedEditor).toContain('<PublicAstridTimeline active={active} onReady={markTimelineReady} />');
    expect(editorParts).toContain('<RemotionPreview');
    expect(editorParts).toContain('<TimelineEditorCoreBody');
    expect(editorParts).toContain('<LazyPropertiesPanelBody hostObservations');
    expect(shell).not.toContain('PublicAstridQualificationSurface');
  });

  it('sends returning visitors who chose the app from the site root into the app', () => {
    expect(prefersAppEntry()).toBe(false);
    rememberAppEntryPreference();
    expect(prefersAppEntry()).toBe(true);
    expect(resolveReturningAppEntry(new URL('https://astrid.test/?ref=x'), true))
      .toBe('/tools/video-editor?ref=x');
  });

  it('preserves the updates Settings deep link through the app-entry redirect', () => {
    const url = new URL('https://astrid.test/?settings=updates&project=film#continue');
    expect(resolveReturningAppEntry(url, true)).toBe('/tools/video-editor?settings=updates&project=film#continue');
  });

  it('sends installer root links to the Runtime gate with their query intact', () => {
    const expected = new URL(APP_ENTRY_PATH, 'https://astrid.test');
    expected.searchParams.set('connect', '1');
    expect(resolveInstallerConnectEntry(new URL('https://astrid.test/?connect=1')))
      .toBe(`${expected.pathname}${expected.search}`);
    expected.searchParams.set('source', 'installer');
    expect(resolveInstallerConnectEntry(new URL('https://astrid.test/?connect=1&source=installer')))
      .toBe(`${expected.pathname}${expected.search}`);
    expect(classifyBrowserEntry(new URL(`https://astrid.test${expected.pathname}${expected.search}`))).toBe('app');
    expect(readFileSync(path.join(process.cwd(), 'src/app/main.tsx'), 'utf8')).toContain('resolveInstallerConnectEntry(currentUrl)');
    expect(resolveInstallerConnectEntry(new URL('https://astrid.test/home?connect=1'))).toBeNull();
    expect(resolveInstallerConnectEntry(new URL('https://astrid.test/?source=installer'))).toBeNull();
  });

  it('preserves repeated installer query keys and the URL hash', () => {
    const installerUrl = new URL('https://astrid.test/?connect=1&source=alpha&source=beta&project=film#continue');
    const resolved = resolveInstallerConnectEntry(installerUrl);
    expect(resolved).not.toBeNull();

    const target = new URL(resolved!, installerUrl.origin);
    expect(target.searchParams.getAll('source')).toEqual(['alpha', 'beta']);
    expect(target.searchParams.getAll('project')).toEqual(['film']);
    expect(target.searchParams.get('timeline')).toBe(new URL(APP_ENTRY_PATH, installerUrl.origin).searchParams.get('timeline'));
    expect(target.searchParams.get('connect')).toBe('1');
    expect(target.hash).toBe('#continue');
  });

  it('keeps the landing page for first visits and /home', () => {
    expect(resolveReturningAppEntry(new URL('https://astrid.test/'), false)).toBeNull();
    expect(resolveReturningAppEntry(new URL('https://astrid.test/home'), true)).toBeNull();
  });

  it('enters the editor on the bare route in every build, leaving project choice to the Runtime', () => {
    expect(APP_ENTRY_PATH).toBe('/tools/video-editor');
    expect(resolveReturningAppEntry(new URL('https://astrid.test/'), true)).toBe('/tools/video-editor');
  });
});
