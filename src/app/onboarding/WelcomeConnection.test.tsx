import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { autoConnectRequested } from '@/integrations/runtime/autoConnectRequest.ts';
import { setRuntimeOrigin } from '@/integrations/runtime/connection.ts';
import { entryFor, readWelcomePhase } from './welcomeProgress.ts';
import { WelcomeFlow } from './WelcomeFlow.tsx';

const install = vi.hoisted(() => ({
  promptEvent: null as { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> } | null,
  standalone: false,
  consume: vi.fn(),
}));
vi.mock('@/shared/hooks/platformInstall/signals.ts', () => ({
  useInstallPromptSignals: () => ({ deferredPrompt: install.promptEvent, consumeDeferredPrompt: install.consume }),
  useStandaloneStatus: () => install.standalone,
  runInstallPrompt: async (event: { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }) => {
    await event.prompt();
    return event.userChoice;
  },
}));
// This suite models the public astrid.haus page reaching its loopback Runtime door.
vi.mock('@/integrations/runtime/localNetworkPermission.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/integrations/runtime/localNetworkPermission.ts')>();
  return { ...actual, requiresLocalNetworkPermission: () => true };
});
vi.mock('./StarterProjectHandoff.tsx', () => ({
  StarterProjectHandoff: () => <div data-testid="starter-project-handoff" />,
}));

const permissionStatus = {
  state: 'prompt',
  onchange: null as ((this: unknown, event: Event) => unknown) | null,
};
const permissions = { query: vi.fn(async () => permissionStatus) };

function loopbackFetchCalls(): string[] {
  return vi.mocked(fetch).mock.calls.flatMap(([input]) => {
    try {
      const url = new URL(String(input), window.location.href);
      return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? [url.href] : [];
    } catch {
      return [];
    }
  });
}

function useBrowser(platform: string, userAgent: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/tools/video-editor');
  setRuntimeOrigin({ VITE_RUNTIME_ORIGIN: 'http://127.0.0.1:17340' });
  permissionStatus.state = 'prompt';
  permissionStatus.onchange = null;
  permissions.query.mockClear();
  install.promptEvent = null;
  install.standalone = false;
  install.consume.mockReset();
  useBrowser('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: permissions });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/health')) return new Promise<Response>(() => {});
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps the separate-window handoff card in the original tab without probing', async () => {
  // Accept installation in the hosted onboarding tab; this profile stays in its browser tab.
  const prompt = vi.fn(async () => undefined);
  install.promptEvent = { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  const onboardingTab = render(<WelcomeFlow entry="choose" />);
  fireEvent.click(screen.getByRole('button', { name: 'Install and continue' }));
  expect(await screen.findByText('Astrid opened in its own window')).toBeInTheDocument();
  expect(prompt).toHaveBeenCalledOnce();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('connection');
  expect(fetch).not.toHaveBeenCalled();
  expect(permissions.query).not.toHaveBeenCalled();
  onboardingTab.unmount();

  // The app window has a fresh sessionStorage, while the localStorage phase survives.
  sessionStorage.clear();
  expect(sessionStorage.getItem('astrid.runtime.autoConnect')).toBeNull();

  const appWindowEntry = entryFor(new URL('/tools/video-editor', window.location.origin), readWelcomePhase());
  expect(appWindowEntry).toBe('connection');
  render(<WelcomeFlow entry={appWindowEntry} />);

  // The persisted phase recreates the gate's connect-on-entry signal in this window; the gate starts its probe.
  expect(autoConnectRequested()).toBe(false);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
  expect(permissions.query).toHaveBeenCalled();
});

it('continues straight into connection when the accepted install reparents this tab as the app window', async () => {
  const prompt = vi.fn(async () => undefined);
  install.promptEvent = { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  const view = render(<WelcomeFlow entry="choose" />);

  fireEvent.click(screen.getByRole('button', { name: 'Install and continue' }));
  expect(await screen.findByText('Astrid opened in its own window')).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();

  install.standalone = true;
  view.rerender(<WelcomeFlow entry="choose" />);

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending'));
  expect(screen.queryByText('Astrid opened in its own window')).not.toBeInTheDocument();
  expect(permissions.query).toHaveBeenCalled();
  expect(prompt).toHaveBeenCalledOnce();
});

it('re-arms again after a reload while the durable phase remains connection', async () => {
  localStorage.setItem('astrid:welcome-v1', 'connection');
  const firstEntry = entryFor(new URL('/tools/video-editor', window.location.origin), readWelcomePhase());
  const firstVisit = render(<WelcomeFlow entry={firstEntry} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(autoConnectRequested()).toBe(false);
  firstVisit.unmount();

  sessionStorage.clear();
  vi.mocked(fetch).mockClear();
  const reloadedEntry = entryFor(new URL('/tools/video-editor', window.location.origin), readWelcomePhase());
  render(<WelcomeFlow entry={reloadedEntry} />);

  expect(autoConnectRequested()).toBe(false);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
});

it('starts the hosted permission probe in the same tab after Continue in this tab', async () => {
  install.promptEvent = {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  };
  render(<WelcomeFlow entry="choose" />);

  fireEvent.click(screen.getByRole('radio', { name: 'Stay in browser' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue in this tab' }));

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
  await waitFor(() => expect(autoConnectRequested()).toBe(false));
});

it('keeps the full local choice outside the hosted Runtime permission gate', async () => {
  render(<WelcomeFlow entry="choose" />);

  fireEvent.click(screen.getByRole('radio', { name: 'Run app on your computer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Set up with your agent' }));

  expect(await screen.findByRole('heading', { name: 'Have your agent set it up' })).toBeInTheDocument();
  expect(autoConnectRequested()).toBe(false);
  expect(loopbackFetchCalls()).toHaveLength(0);
  expect(permissions.query).not.toHaveBeenCalled();
});

it.each([
  ['phone', 'iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'Open Astrid on your computer'],
  ['unsupported browser', 'MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/153.0', 'Open Astrid in Chrome or Edge'],
  ['unknown desktop platform', 'MysteryOS', 'Mozilla/5.0 (MysteryOS; rv:1.0) UnknownBrowser/1.0', 'Open Astrid in Chrome or Edge'],
] as const)('%s connection phase does not query permission or probe the Runtime', async (_name, platform, userAgent, heading) => {
  useBrowser(platform, userAgent);
  localStorage.setItem('astrid:welcome-v1', 'connection');

  render(<WelcomeFlow entry="connection" />);

  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(autoConnectRequested()).toBe(false);
  expect(permissions.query).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
