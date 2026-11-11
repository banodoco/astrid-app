import { entryFor, readWelcomePhase } from '@/app/onboarding/welcomeProgress.ts';
import {
  classifyBrowserEntry,
  prefersAppEntry,
  resolveInstallerConnectEntry,
  resolveReturningAppEntry,
} from '@/app/entryClassification.ts';
import { runtimeOrigin, setRuntimeOrigin } from '@/integrations/runtime/connection.ts';
import { installDocumentRequestRegistry, installNavigationPreparationProtocol } from '@/shared/lib/navigation/documentNavigation.ts';
import { releaseBootLayerWhenReady } from '@/app/bootLayer.ts';
import { migrateAstridBrowserStorage } from '@/migrations/astridRenameBrowserMigration.ts';

async function main(): Promise<void> {
  // First, before any module that can build a Runtime client or media URL is imported: the hosted
  // build points every Runtime and Astrid base at the loopback gateway (`connection.ts`).
  setRuntimeOrigin(import.meta.env);
  // Next, before any Runtime request: the page knows each one until it has ended, so it can settle them before it
  // navigates away (`documentNavigation.ts`).
  installDocumentRequestRegistry();
  installNavigationPreparationProtocol();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error("Failed to render app: element with id 'root' was not found.");
  }

  const currentUrl = new URL(window.location.href);
  const installConnectEntry = resolveInstallerConnectEntry(currentUrl);
  if (installConnectEntry) {
    window.history.replaceState(window.history.state, '', installConnectEntry);
  }

  const returningAppEntry = installConnectEntry
    ? null
    : resolveReturningAppEntry(new URL(window.location.href), prefersAppEntry());
  if (returningAppEntry) {
    window.history.replaceState(window.history.state, '', returningAppEntry);
  }

  const owner = classifyBrowserEntry(new URL(window.location.href));
  if (owner === 'public') {
    const { renderPublicEntry } = await import('@/app/publicBootstrap.tsx');
    clearPreloadReloadAfterRender(rootElement);
    renderPublicEntry(rootElement);
    releaseBootLayerWhenReady(rootElement);
    return;
  }

  await startApp(rootElement);
}

const PRELOAD_RELOAD_FLAG = 'astrid:preload-reloaded';
/** A render releases the reload cooldown only after it stays free of chunk failures this long. */
const PRELOAD_GUARD_SETTLE_MS = 10_000;
let preloadErrorSeen = false;

/**
 * Keep the reload cooldown until the render has committed AND stayed free of chunk-load failures
 * for a settle period. Remember failed URLs for the whole session so the same missing file cannot loop.
 */
function clearPreloadReloadAfterRender(rootElement: HTMLElement): void {
  const existingChildren = new Set(rootElement.children);
  const observer = new MutationObserver(() => clear());
  const clear = () => {
    const renderedApp = [...rootElement.children].some(
      (child) => !existingChildren.has(child) && child.getAttribute('role') !== 'alert',
    );
    if (!renderedApp) return;
    observer.disconnect();
    window.setTimeout(() => {
      if (preloadErrorSeen) return;
      try {
        const guard = readPreloadReloadGuard();
        if (guard) sessionStorage.setItem(PRELOAD_RELOAD_FLAG, JSON.stringify({ ...guard, lastReloadAt: null }));
      } catch {
        // Storage can be unavailable; the current page is still usable.
      }
    }, PRELOAD_GUARD_SETTLE_MS);
  };
  observer.observe(rootElement, { childList: true, subtree: true });
  clear();
}

interface PreloadReloadGuard {
  readonly urls: readonly string[];
  readonly lastReloadAt: number | null;
}

function readPreloadReloadGuard(): PreloadReloadGuard | null {
  const stored = sessionStorage.getItem(PRELOAD_RELOAD_FLAG);
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value === 'object' && value !== null && 'urls' in value && Array.isArray(value.urls)
      && value.urls.every(url => typeof url === 'string')
      && 'lastReloadAt' in value && (typeof value.lastReloadAt === 'number' || value.lastReloadAt === null)) {
      return value as PreloadReloadGuard;
    }
  } catch { /* An older or corrupt guard blocks reloads for this session. */ }
  return { urls: ['*'], lastReloadAt: Date.now() };
}

function preloadChunkUrl(event: Event): string {
  const payload = (event as Event & { payload?: unknown }).payload;
  const message = payload instanceof Error ? payload.message : typeof payload === 'string' ? payload : '';
  const found = message.match(/(?:https?:\/\/|\/)[^\s)"']+/)?.[0]?.replace(/[.,;:]$/, '');
  return found ?? (message || 'unknown-preload-failure');
}

/**
 * A hashed chunk that 404s after a redeploy: reload once for the new build. Repeated failures reach
 * the error boundary; a different URL may reload after the settled boot cooldown.
 */
function handlePreloadError(event: Event): void {
  preloadErrorSeen = true;
  try {
    const url = preloadChunkUrl(event);
    const guard = readPreloadReloadGuard();
    if (guard?.urls.includes(url) || guard?.urls.includes('*')) return;
    if (guard?.lastReloadAt !== null && guard?.lastReloadAt !== undefined
      && Date.now() - guard.lastReloadAt < PRELOAD_GUARD_SETTLE_MS) return;
    sessionStorage.setItem(PRELOAD_RELOAD_FLAG, JSON.stringify({
      urls: [...(guard?.urls ?? []), url],
      lastReloadAt: Date.now(),
    } satisfies PreloadReloadGuard));
  } catch {
    return; // Without storage we cannot guard against a loop, so do not reload.
  }
  event.preventDefault();
  window.location.reload();
}
window.addEventListener('vite:preloadError', handlePreloadError);

// Shown before the app's CSS loads: keep in step with index.html's fallback
function showFailureCard(rootElement: HTMLElement, { title: titleText, sentence, button: buttonText, onClick }: {
  title: string;
  sentence: string;
  button: string;
  onClick: () => void;
}): HTMLButtonElement {
  const container = document.createElement('main');
  container.setAttribute('role', 'alert');
  container.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;text-align:center;color:var(--boot-ink,#2b2724);font-family:Inter,system-ui,-apple-system,sans-serif';
  const width = document.createElement('div');
  width.style.maxWidth = '420px';
  const icon = document.createElement('img');
  icon.src = '/astrid-app-icon-192.png';
  icon.alt = '';
  icon.width = 76;
  icon.height = 76;
  icon.style.cssText = 'display:block;margin:0 auto';

  const title = document.createElement('h1');
  title.textContent = titleText;
  title.style.cssText = "margin:10px 0 4px;font:400 25px/1.2 Georgia,'Times New Roman',serif";

  const detail = document.createElement('p');
  detail.textContent = sentence;
  detail.style.cssText = 'margin:0 0 16px;font-size:14px;line-height:24px;opacity:.72';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = buttonText;
  button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 28px;border-radius:12px;background:var(--boot-ink,#2b2724);color:var(--boot-background,#faf8f5);font-size:14px;font-weight:500;text-decoration:none;border:0;cursor:pointer;font-family:inherit';
  button.addEventListener('click', onClick);

  width.append(icon, title, detail, button);
  container.append(width);
  rootElement.replaceChildren(container);
  return button;
}

function showStartupFailure(rootElement: HTMLElement, error: unknown): void {
  console.error('Astrid failed to start', error);
  showFailureCard(rootElement, {
    title: 'Astrid could not start',
    sentence: 'It may have just been updated. Reload to try again.',
    button: 'Reload',
    onClick: () => window.location.reload(),
  });
}

function showMigrationFailure(rootElement: HTMLElement, store: string, retry: () => Promise<void>): void {
  const button = showFailureCard(rootElement, {
    title: 'Astrid could not prepare browser storage',
    sentence: `Migration failed for ${store}. Your existing browser data is preserved. Retry to try again.`,
    button: 'Retry migration',
    onClick: () => {
      button.disabled = true;
      button.textContent = 'Retrying…';
      void retry();
    },
  });
}

async function startApp(rootElement: HTMLElement): Promise<void> {
  const migration = await migrateAstridBrowserStorage();
  if (!migration.success) {
    showMigrationFailure(rootElement, migration.store, () => startApp(rootElement));
    releaseBootLayerWhenReady(rootElement);
    return;
  }

  const localBuild = runtimeOrigin() === '';
  const welcomeEntry = entryFor(new URL(window.location.href), readWelcomePhase(), localBuild);
  if (welcomeEntry !== 'editor') {
    const { renderWelcome } = await import('@/app/onboarding/welcomeBootstrap.tsx');
    clearPreloadReloadAfterRender(rootElement);
    renderWelcome(rootElement, welcomeEntry, localBuild);
    releaseBootLayerWhenReady(rootElement);
    return;
  }

  const [
    { renderApp },
    { initializeVideoEditorExtensionRuntime },
    { initializeWorkspaceRuntimeIdentity },
  ] = await Promise.all([
    import('@/app/bootstrap'),
    import('@/tools/video-editor/browser/initializeVideoEditorExtensionRuntime.ts'),
    import('@/integrations/runtime/client.ts'),
  ]);
  initializeVideoEditorExtensionRuntime();
  await initializeWorkspaceRuntimeIdentity();
  clearPreloadReloadAfterRender(rootElement);
  renderApp(rootElement);
  releaseBootLayerWhenReady(rootElement);
}

void main().catch((error: unknown) => {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    console.error('Astrid failed to start', error);
    return;
  }
  showStartupFailure(rootElement, error);
  releaseBootLayerWhenReady(rootElement);
});
