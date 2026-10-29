// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  __resetInstallPromptSignalsForTests,
  useInstallPromptSignals,
} from '@/shared/hooks/platformInstall/signals';
import { APP_ENTRY_PATH } from '@/app/entryClassification.ts';
import { PublicAstridInstallDialog } from './PublicAstridInstallDialog';

const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');

function setNavigator(userAgent: string, platform: string) {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function promptEvent(userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>) {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice,
  });
}

const BROWSER = { name: 'Use it in the browser' };

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Open install' }));
}

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const LINUX_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0';

/** jsdom cannot navigate: capture where the dialog sends the tab. */
function captureNavigation() {
  const assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
  return assign;
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open install</button>
      <PublicAstridInstallDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe('PublicAstridInstallDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetInstallPromptSignalsForTests();
    setNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'MacIntel',
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true,
    });
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    window.matchMedia = vi.fn().mockImplementation((media: string) => ({
      media,
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }),
    });
  });

  afterEach(() => {
    cleanup();
    __resetInstallPromptSignalsForTests();
    vi.restoreAllMocks();
    if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform);
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (originalShare) Object.defineProperty(navigator, 'share', originalShare);
    else delete (navigator as Navigator & { share?: Navigator['share'] }).share;
    vi.useRealTimers();
  });

  it('returns focus to the Home CTA and closes safely', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open install' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
    expect(trigger).toHaveFocus();
  });

  it('returns focus to the trigger in Safari, which does not focus a clicked button', () => {
    // Safari leaves focus on the nearest focusable ancestor (here the page's `main`) instead of the button.
    render(<main tabIndex={-1} data-testid="page"><Harness /></main>);
    const page = screen.getByTestId('page');
    const trigger = screen.getByRole('button', { name: 'Open install' });
    page.focus();
    fireEvent.click(trigger);
    expect(trigger).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
    expect(trigger).toHaveFocus();
  });

  it.each([
    ['macOS', MAC_CHROME, 'MacIntel', 'your dock'],
    ['Windows', WIN_CHROME, 'Win32', 'your taskbar'],
    ['Linux', LINUX_CHROME, 'Linux x86_64', 'your app launcher'],
  ])('names where the app lives on %s', (_os, userAgent, platform, place) => {
    setNavigator(userAgent, platform);
    render(<Harness />);
    openDialog();
    expect(screen.getByText(`Astrid installs straight from your browser, into its own window and ${place}.`)).toBeInTheDocument();
  });

  it.each([
    ['chromium', MAC_CHROME, 'MacIntel', 'Astrid installs straight from your browser'],
    ['unsupported', MAC_SAFARI, 'MacIntel', 'Astrid needs Chrome or Edge to reach your computer'],
    ['unsupported', MAC_FIREFOX, 'MacIntel', 'This browser can’t install web apps. Open this page in Chrome or Edge'],
    ['mobile', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone', 'Choose Add to Home Screen.'],
  ] as const)('renders the %s install variant', (scenario, userAgent, platform, copy) => {
    setNavigator(userAgent, platform);
    render(<Harness />);
    openDialog();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-scenario', scenario);
    expect(screen.getByRole('heading', { name: 'Get the Astrid app' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(copy))).toBeInTheDocument();
    // The app step is the only step: no computer step, no Back, no agent instructions here.
    expect(screen.queryByText(/curl -fsSL/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy for your agent' })).not.toBeInTheDocument();
    // Safari cannot reach Astrid on this computer, so it is not offered the browser route.
    const isSafari = userAgent === MAC_SAFARI;
    expect(screen.queryByRole('button', BROWSER) === null).toBe(isSafari);
  });

  it('points at the address bar while the app step is showing', () => {
    render(<Harness />);
    openDialog();
    expect(document.querySelector('svg.astrid-toolbar-pointer')).not.toBeNull();
  });

  it('shows the app step first, with the browser choice beside it and no old shortcut details', () => {
    render(<Harness />);
    openDialog();
    expect(screen.getByRole('heading', { name: 'Get the Astrid app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done — continue' })).toBeInTheDocument();
    expect(screen.getByRole('button', BROWSER)).toBeInTheDocument();
    expect(screen.queryByText('Add a browser shortcut')).not.toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
    expect(screen.queryByText(/curl -fsSL/)).not.toBeInTheDocument();
  });

  it('offers Install when the browser can prompt, and an accepted prompt says the app opens in its own window', async () => {
    vi.useRealTimers();
    const assign = captureNavigation();
    const event = promptEvent(Promise.resolve({ outcome: 'accepted' }));
    act(() => window.dispatchEvent(event));
    render(<Harness />);
    openDialog();
    expect(screen.queryByRole('button', { name: 'Done — continue' })).not.toBeInTheDocument();
    window.localStorage.clear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Install Astrid/ })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Astrid is installed' })).toBeInTheDocument();
    expect(screen.getByText('It opens in its own window.')).toBeInTheDocument();
    expect(window.localStorage.getItem('astrid:prefers-app')).toBe('1');
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open here instead' }));
    expect(assign).toHaveBeenCalledWith(APP_ENTRY_PATH);
  });

  it('stays on the app step when the prompt is dismissed', async () => {
    vi.useRealTimers();
    const event = promptEvent(Promise.resolve({ outcome: 'dismissed' }));
    act(() => window.dispatchEvent(event));
    render(<Harness />);
    openDialog();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Install Astrid/ })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('heading', { name: 'Get the Astrid app' })).toBeInTheDocument();
  });

  it.each([
    ['Use it in the browser', BROWSER],
    ['Done — continue', { name: 'Done — continue' }],
  ])('"%s" records the choice and goes into the editor', (_label, query) => {
    window.localStorage.clear();
    const assign = captureNavigation();
    render(<Harness />);
    openDialog();
    expect(window.localStorage.getItem('astrid:prefers-app')).toBeNull();
    fireEvent.click(screen.getByRole('button', query));
    expect(window.localStorage.getItem('astrid:prefers-app')).toBe('1');
    expect(assign).toHaveBeenCalledWith(APP_ENTRY_PATH);
  });

  it('skips the app step when running as a standalone app', () => {
    window.matchMedia = vi.fn().mockImplementation((media: string) => ({
      media, matches: media.includes('standalone'), addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    }));
    render(<Harness />);
    openDialog();
    expect(screen.getByRole('heading', { name: 'Astrid is installed' })).toBeInTheDocument();
  });

  it('renders the installed variant without an install prompt action', () => {
    act(() => window.dispatchEvent(new Event('appinstalled')));
    render(<Harness />);
    screen.getByRole('button', { name: 'Open install' }).focus();
    openDialog();
    expect(screen.getByRole('heading', { name: 'Astrid is installed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install Astrid/ })).not.toBeInTheDocument();
  });

  it('choosing the browser tells the app to go straight to Chrome\'s prompt', () => {
    window.sessionStorage.clear();
    captureNavigation();
    render(<Harness />);
    openDialog();
    expect(window.sessionStorage.getItem('astrid.runtime.autoConnect')).toBeNull();
    fireEvent.click(screen.getByRole('button', BROWSER));
    expect(window.sessionStorage.getItem('astrid.runtime.autoConnect')).toBe('1');
  });

  it('still goes in when session storage refuses the flag', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const assign = captureNavigation();
    render(<Harness />);
    openDialog();
    expect(() => fireEvent.click(screen.getByRole('button', BROWSER))).not.toThrow();
    expect(assign).toHaveBeenCalledWith(APP_ENTRY_PATH);
  });

  it('does not consume a prompt whose result arrives after modal departure', async () => {
    const choice = deferred<{ outcome: 'accepted' | 'dismissed' }>();
    const event = promptEvent(choice.promise);
    act(() => window.dispatchEvent(event));
    render(<Harness />);
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: /Install Astrid/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    choice.resolve({ outcome: 'accepted' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const observer = render(<PromptObserver />);
    expect(observer.container).toHaveTextContent('present');
  });
});

function PromptObserver() {
  const { deferredPrompt } = useInstallPromptSignals();
  return <span>{deferredPrompt ? 'present' : 'consumed'}</span>;
}
