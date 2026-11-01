import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bootstrapMocks = vi.hoisted(() => ({
  initializeVideoEditorExtensionRuntime: vi.fn(),
  initializeWorkspaceRuntimeIdentity: vi.fn(),
  migrateAstridBrowserStorage: vi.fn(),
  renderApp: vi.fn(),
}));

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const indexDocument = new DOMParser().parseFromString(indexHtml, 'text/html');
const bootMarkup = indexDocument.getElementById('boot');
const bootStyles = Array.from(indexDocument.querySelectorAll('style')).find((style) => style.textContent?.includes('#boot {'));

// Mock both supported import paths to the same initializer. This keeps
// the test focused on the real entry's initialization-before-render sequence.
vi.mock('@/tools/video-editor/browser', () => ({
  initializeVideoEditorExtensionRuntime: bootstrapMocks.initializeVideoEditorExtensionRuntime,
}));

vi.mock('@/tools/video-editor/browser/initializeVideoEditorExtensionRuntime', () => ({
  initializeVideoEditorExtensionRuntime: bootstrapMocks.initializeVideoEditorExtensionRuntime,
}));

vi.mock('@/app/bootstrap', () => ({
  renderApp: bootstrapMocks.renderApp,
}));

vi.mock('@/integrations/runtime/client.ts', () => ({
  initializeWorkspaceRuntimeIdentity: bootstrapMocks.initializeWorkspaceRuntimeIdentity,
}));

vi.mock('@/migrations/astridRenameBrowserMigration.ts', () => ({
  migrateAstridBrowserStorage: bootstrapMocks.migrateAstridBrowserStorage,
}));

describe('main entry bootstrap order', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    bootstrapMocks.initializeVideoEditorExtensionRuntime.mockReset();
    bootstrapMocks.initializeWorkspaceRuntimeIdentity.mockReset();
    bootstrapMocks.migrateAstridBrowserStorage.mockReset();
    bootstrapMocks.renderApp.mockReset();
    document.body.replaceChildren();
    // The web root is the public landing entry; the app bootstrap only runs on an app route.
    window.history.replaceState({}, '', '/tools/video-editor?localProject=demo');
  });

  it('installs the extension runtime before awaiting identity and rendering the app', async () => {
    bootstrapMocks.migrateAstridBrowserStorage.mockResolvedValue({ success: true });
    const bootstrapEvents: string[] = [];
    let resolveIdentity!: () => void;
    bootstrapMocks.initializeVideoEditorExtensionRuntime.mockImplementation(() => {
      bootstrapEvents.push('extension-runtime-install');
    });
    bootstrapMocks.initializeWorkspaceRuntimeIdentity.mockImplementation(() => {
      bootstrapEvents.push('workspace-runtime-identity');
      return new Promise<void>((resolve) => {
        resolveIdentity = resolve;
      });
    });
    bootstrapMocks.renderApp.mockImplementation(() => {
      bootstrapEvents.push('render-app');
    });

    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await import('@/app/main');

    // main() is fire-and-forget: its dynamic imports settle after the module
    // evaluates, so wait for the initialization call instead of racing it.
    await vi.waitFor(() => expect(bootstrapMocks.initializeVideoEditorExtensionRuntime).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(bootstrapMocks.initializeWorkspaceRuntimeIdentity).toHaveBeenCalledOnce());
    expect(bootstrapEvents).toEqual(['extension-runtime-install', 'workspace-runtime-identity']);
    expect(bootstrapMocks.renderApp).not.toHaveBeenCalled();

    resolveIdentity();
    await vi.waitFor(() => expect(bootstrapMocks.renderApp).toHaveBeenCalledOnce());
    expect(bootstrapMocks.renderApp).toHaveBeenCalledWith(root);
    expect(bootstrapEvents).toEqual(['extension-runtime-install', 'workspace-runtime-identity', 'render-app']);
  });

  it('blocks app initialization on migration failure and renders after a successful retry', async () => {
    bootstrapMocks.migrateAstridBrowserStorage
      .mockResolvedValueOnce({ success: false, store: 'IndexedDB astrid.timeline-drafts', error: new Error('diverged') })
      .mockResolvedValueOnce({ success: true });

    const root = document.createElement('div');
    root.id = 'root';
    expect(bootMarkup).not.toBeNull();
    expect(bootStyles).toBeDefined();
    const boot = document.importNode(bootMarkup!, true);
    document.head.append(document.importNode(bootStyles!, true));
    document.body.append(boot, root);

    await import('@/app/main');
    await vi.waitFor(() => expect(root.textContent).toContain('IndexedDB astrid.timeline-drafts'));

    expect(bootstrapMocks.renderApp).not.toHaveBeenCalled();
    expect(bootstrapMocks.initializeVideoEditorExtensionRuntime).not.toHaveBeenCalled();
    expect(bootstrapMocks.initializeWorkspaceRuntimeIdentity).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(boot.classList.contains('boot-done')).toBe(true));
    expect(getComputedStyle(boot.querySelector('.boot-paper')!).opacity).toBe('0');
    const retry = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Retry migration');
    expect(retry).toBeDefined();
    expect(retry?.isConnected).toBe(true);
    expect(getComputedStyle(retry!).visibility).toBe('visible');
    retry?.click();

    await vi.waitFor(() => expect(bootstrapMocks.renderApp).toHaveBeenCalledOnce());
    expect(bootstrapMocks.migrateAstridBrowserStorage).toHaveBeenCalledTimes(2);
    expect(bootstrapMocks.renderApp).toHaveBeenCalledWith(root);
  });

  it('injects no remote font link: typography is self-hosted', async () => {
    bootstrapMocks.migrateAstridBrowserStorage.mockResolvedValue({ success: true });
    bootstrapMocks.initializeVideoEditorExtensionRuntime.mockResolvedValue(undefined);

    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await import('@/app/main');
    await vi.waitFor(() => expect(bootstrapMocks.renderApp).toHaveBeenCalledOnce());

    const remoteHrefs = [...document.querySelectorAll('link')]
      .map((link) => link.getAttribute('href') ?? '')
      .filter((href) => /^https:\/\/(fonts\.(googleapis|gstatic)\.com|unpkg\.com|cdn\.jsdelivr\.net)/.test(href));
    expect(remoteHrefs).toEqual([]);
  });
});
