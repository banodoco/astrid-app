import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  steps: [] as string[],
  migrate: vi.fn(),
  identity: vi.fn(),
  release: vi.fn(),
  welcomeEntry: null as string | null,
}));
vi.mock('@/migrations/astridRenameBrowserMigration.ts', () => ({ migrateAstridBrowserStorage: boot.migrate }));
vi.mock('@/app/bootLayer.ts', () => ({ releaseBootLayerWhenReady: boot.release }));

describe('main welcome routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_RUNTIME_ORIGIN', 'http://127.0.0.1:17340');
    localStorage.clear();
    boot.steps = [];
    boot.welcomeEntry = null;
    boot.migrate.mockReset().mockImplementation(async () => { boot.steps.push('migrate'); return { success: true }; });
    boot.identity.mockReset().mockImplementation(async () => { boot.steps.push('identity'); });
    boot.release.mockReset();
    // Observe module evaluation as well as calls: a first visit must not eagerly import the app
    // and its runtime/catalog graph just to decide to show the browser-only tour.
    vi.doMock('@/app/bootstrap', () => {
      boot.steps.push('import app');
      return { renderApp: () => { boot.steps.push('render app'); } };
    });
    vi.doMock('@/tools/video-editor/browser/initializeVideoEditorExtensionRuntime.ts', () => {
      boot.steps.push('import catalog');
      return { initializeVideoEditorExtensionRuntime: () => { boot.steps.push('catalog'); } };
    });
    vi.doMock('@/integrations/runtime/client.ts', () => {
      boot.steps.push('import identity');
      return { initializeWorkspaceRuntimeIdentity: boot.identity };
    });
    vi.doMock('@/app/onboarding/welcomeBootstrap.tsx', () => {
      boot.steps.push('import welcome');
      return { renderWelcome: (_root: HTMLElement, entry: string) => { boot.welcomeEntry = entry; boot.steps.push('render welcome'); } };
    });
    vi.doMock('@/app/publicBootstrap.tsx', () => {
      boot.steps.push('import public');
      return { renderPublicEntry: () => { boot.steps.push('render public'); } };
    });
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState({}, '', '/tools/video-editor');
  });

  afterEach(() => { localStorage.clear(); vi.unstubAllEnvs(); });

  async function enter(): Promise<void> {
    await import('@/app/main');
    await vi.waitFor(() => expect(boot.release).toHaveBeenCalledOnce());
  }

  it('skips the run-mode choice on the same-origin local build', async () => {
    vi.stubEnv('VITE_RUNTIME_ORIGIN', '');
    localStorage.setItem('astrid:welcome-v1', 'choose');
    await enter();
    expect(boot.welcomeEntry).toBe('local');
  });

  it('renders welcome on a fresh unselected editor visit before importing any Runtime or app bootstrap', async () => {
    await enter();
    expect(boot.steps).toEqual(['migrate', 'import welcome', 'render welcome']);
    expect(boot.identity).not.toHaveBeenCalled();
    expect(boot.release).toHaveBeenCalledWith(document.getElementById('root'));
  });

  it.each(['tour', 'choose', 'connection', 'local'])('resumes an unfinished %s visit through welcome', async phase => {
    localStorage.setItem('astrid:welcome-v1', phase);
    // A successfully connected but unfinished first-project handoff is still resumable.
    localStorage.setItem('astrid.runtime.connectedBefore', '1');
    await enter();
    expect(boot.steps).toEqual(['migrate', 'import welcome', 'render welcome']);
    expect(boot.welcomeEntry).toBe(phase);
  });

  it.each([
    ['astrid:welcome-v1', 'complete'],
    ['astrid.runtime.connectedBefore', '1'],
    ['astrid-setup-complete', 'true'],
    ['astrid-editor-tour-v1', '1'],
    ['astrid:lastOpenedLocalProjectSlug', 'my-film'],
  ])('preserves normal app startup for returning evidence %s', async (key, value) => {
    localStorage.setItem(key, value);
    await enter();
    expect(boot.steps).toContain('render app');
    expect(boot.steps).not.toContain('import welcome');
    expect(boot.steps.indexOf('catalog')).toBeLessThan(boot.steps.indexOf('render app'));
    expect(boot.steps.indexOf('identity')).toBeLessThan(boot.steps.indexOf('render app'));
  });

  it.each([
    '/tools/video-editor?project=my-film&timeline=main#frame-20',
    '/tools/video-editor?project=my-film',
    '/tools/video-editor?localProject=demo',
    '/tools/video-editor?localTimeline=demo',
  ])('keeps explicit entry %s on the normal app path without changing its address', async path => {
    window.history.replaceState({}, '', path);
    const before = window.location.href;
    await enter();
    expect(window.location.href).toBe(before);
    // A work link opens the editor, whose Runtime gate connects (or, on a phone, sends the link to a computer);
    // it is never answered with a setup page or the demo, and it marks welcome complete.
    expect(boot.steps).toContain('render app');
    expect(boot.steps).not.toContain('import welcome');
    expect(localStorage.getItem('astrid:welcome-v1')).toBe('complete');
  });

  it('ignores unrelated query keys and resumes the bare welcome by phase', async () => {
    localStorage.setItem('astrid:welcome-v1', 'choose');
    window.history.replaceState({}, '', '/tools/video-editor?unrelated=1');
    await enter();
    expect(boot.welcomeEntry).toBe('choose');
  });

  it('ignores unrelated query keys on a fresh visit too', async () => {
    window.history.replaceState({}, '', '/tools/video-editor?runtimeOrigin=http%3A%2F%2Flocalhost%3A17340');
    await enter();
    expect(boot.welcomeEntry).toBe('tour');
  });

  it.each(['/', '/home', '/vision'])('keeps %s on the public entry without welcome, migration or Runtime startup', async path => {
    window.history.replaceState({}, '', path);
    await enter();
    expect(boot.steps).toEqual(['import public', 'render public']);
    expect(boot.migrate).not.toHaveBeenCalled();
    expect(boot.identity).not.toHaveBeenCalled();
  });

  it('offers welcome when a new visitor has chosen app entry from the public site', async () => {
    localStorage.setItem('astrid:prefers-app', '1');
    window.history.replaceState({}, '', '/');
    await enter();
    expect(window.location.pathname).toBe('/tools/video-editor');
    expect(boot.steps).toEqual(['migrate', 'import welcome', 'render welcome']);
  });

  it('normalizes a first installer connection link into the resumable welcome connection path', async () => {
    window.history.replaceState({}, '', '/?connect=1#continue');
    await enter();
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe('/tools/video-editor?connect=1#continue');
    expect(boot.steps).toEqual(['migrate', 'import welcome', 'render welcome']);
  });

  it('keeps a failed storage migration ahead of welcome and can retry into it', async () => {
    boot.migrate.mockResolvedValueOnce({ success: false, store: 'drafts' }).mockResolvedValueOnce({ success: true });
    await enter();
    expect(document.getElementById('root')?.textContent).toContain('Migration failed for drafts');
    expect(boot.steps).toEqual([]);
    document.querySelector('button')?.click();
    await vi.waitFor(() => expect(boot.steps).toContain('render welcome'));
    expect(boot.steps).not.toContain('import identity');
    expect(boot.steps).not.toContain('import catalog');
    expect(boot.steps).not.toContain('import app');
  });
});
