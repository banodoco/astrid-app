// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __getSelectionStateForTests, __resetSelectionStoreForTests, userSelectTimelineClip } from '@/shared/state/selectionStore.ts';
import { PublicAstridShell } from './PublicAstridShell.tsx';

const motionPreferenceListeners = new Set<(event: MediaQueryListEvent) => void>();
let prefersReducedMotion = false;

vi.mock('./PublicAstridMountedEditor.tsx', async () => {
  const React = await import('react');
  return {
    PublicAstridMountedEditor: ({
      onConversationReady,
      onOpenVerifiedResult,
      attempt,
    }: {
      onConversationReady: (attempt: number) => void;
      onOpenVerifiedResult: () => void;
      example: unknown;
    }) => {
      const [playing, setPlaying] = React.useState(false);
      React.useEffect(() => onConversationReady(attempt), [attempt, onConversationReady]);
      const exposeTestHandoff = new URLSearchParams(window.location.search).get('test-verified-result') === '1';
      return (
        <>
          <div data-astrid-preview-frame-ready="true" />
          <button type="button" onClick={() => setPlaying((value) => !value)}>{playing ? 'Pause' : 'Play'}</button>
          {exposeTestHandoff && (
            <button type="button" onClick={() => {
              userSelectTimelineClip('light-study-02', { additive: false });
              onOpenVerifiedResult();
            }}>
              Open test verified result
            </button>
          )}
        </>
      );
    },
  };
});

function setRoute(search: string) {
  window.history.replaceState({}, '', `/home${search}`);
}

function readRouteStatus() {
  return document.querySelector('[data-astrid-route-status]')?.textContent ?? '';
}

function observeRouteAnnouncements() {
  const messages: string[] = [];
  let lastMessage = '';
  const observer = new MutationObserver(() => {
    const message = readRouteStatus();
    if (message && message !== lastMessage) {
      lastMessage = message;
      messages.push(message);
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  return {
    messages,
    ignoreCurrent: () => {
      messages.length = 0;
      lastMessage = readRouteStatus();
    },
    disconnect: () => observer.disconnect(),
  };
}

async function flushAnnouncementObserver() {
  await act(async () => {
    await Promise.resolve();
  });
}

function configureMotionPreference(initial: boolean) {
  prefersReducedMotion = initial;
  motionPreferenceListeners.clear();
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: media.includes('prefers-reduced-motion') && prefersReducedMotion,
    media,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => motionPreferenceListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => motionPreferenceListeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => motionPreferenceListeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => motionPreferenceListeners.delete(listener),
    dispatchEvent: () => false,
  }));
}

function changeMotionPreference(next: boolean) {
  prefersReducedMotion = next;
  act(() => {
    for (const listener of motionPreferenceListeners) listener({ matches: next } as MediaQueryListEvent);
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe('PublicAstridShell route announcements', () => {
  beforeEach(() => {
  vi.useFakeTimers();
  __resetSelectionStoreForTests();
  configureMotionPreference(false);
  // Use an explicit App link for the shared setup.
  setRoute('?experience=app');
  });

  it.each([
    ['/home', 'App.'],
    ['/home?experience=agent', 'Agent.'],
    // The flat preview link lands on the default App view.
    ['/home?view=preview', 'App.'],
  ])('announces the direct-link state once after shell commit: %s', async (path, expected) => {
    setRoute(path.replace('/home', ''));
    const announcements = observeRouteAnnouncements();
    const rendered = render(<StrictMode><PublicAstridShell /></StrictMode>);
    const status = rendered.container.querySelector('[data-astrid-route-status]');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(readRouteStatus()).toBe(expected);
    expect(status?.parentElement).toHaveClass('astrid-public-site');
    expect(status?.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByRole('status').filter((element) => element.hasAttribute('data-astrid-route-status'))).toHaveLength(1);
    await flushAnnouncementObserver();
    expect(announcements.messages).toEqual([expected]);
    await advance(1_000);
    expect(readRouteStatus()).toBe(expected);
    expect(announcements.messages).toEqual([expected]);
    announcements.disconnect();
  });

  it('announces each audience change only after its route motion settles', async () => {
    render(<PublicAstridShell />);
    expect(readRouteStatus()).toBe('App.');
    const announcements = observeRouteAnnouncements();
    await flushAnnouncementObserver();
    announcements.ignoreCurrent();

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await advance(719);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('App.');
    expect(announcements.messages).toEqual([]);
    await advance(1);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('Agent.');

    fireEvent.click(screen.getByRole('button', { name: 'App' }));
    await advance(720);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('App.');
    expect(announcements.messages).toEqual(['Agent.', 'App.']);
    announcements.disconnect();
  });

  it('links each named open-source integration without switching away from Agent', async () => {
    vi.useRealTimers();
    render(<PublicAstridShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    for (const [name, repository] of [
      ['ComfyUI', 'Comfy-Org/ComfyUI'],
      ['Wan2GP', 'deepbeepmeep/Wan2GP'],
      ['HyperFrames', 'heygen-com/hyperframes'],
      ['AI Toolkit', 'ostris/ai-toolkit'],
    ]) {
      const link = await screen.findByRole('link', { name: `${name} on GitHub` }, { timeout: 4_500 });
      expect(link).toHaveAttribute('href', `https://github.com/${repository}`);
      expect(link).toHaveAttribute('target', '_blank');
      link.focus();
      expect(link).toHaveFocus();
      fireEvent.click(link);
      expect(screen.getByRole('main')).toHaveAttribute('data-audience', 'agent');
    }
    expect(screen.getByText('For example:')).toBeInTheDocument();
    expect(screen.getByText('It works with popular tools, but you can also integrate anything you’d like.')).toBeInTheDocument();
  });

  it('cancels a stale announcement when a switch is reversed mid-motion', async () => {
    render(<PublicAstridShell />);
    const announcements = observeRouteAnnouncements();
    await flushAnnouncementObserver();
    announcements.ignoreCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await advance(120);
    fireEvent.click(screen.getByRole('button', { name: 'App' }));
    await advance(1_000);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('App.');
    expect(announcements.messages).toEqual([]);
    announcements.disconnect();
  });

  it('tracks Back and Forward popstate changes and ignores a no-op history state', async () => {
    render(<PublicAstridShell />);
    const announcements = observeRouteAnnouncements();
    await flushAnnouncementObserver();
    announcements.ignoreCurrent();

    act(() => {
      window.history.replaceState({}, '', '/home?experience=agent');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await advance(720);
    expect(readRouteStatus()).toBe('Agent.');

    act(() => {
      window.history.replaceState({}, '', '/home?experience=agent');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await advance(720);

    act(() => {
      window.history.replaceState({}, '', '/home');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(window.location.search).toBe('');
    await advance(720);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('App.');
    expect(announcements.messages).toEqual(['Agent.', 'App.']);
    announcements.disconnect();
  });

  it('uses next paint for reduced motion and invalidates a pending normal-motion timer when preference changes', async () => {
    render(<PublicAstridShell />);
    const announcements = observeRouteAnnouncements();
    await flushAnnouncementObserver();
    announcements.ignoreCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await advance(100);
    changeMotionPreference(true);
    expect(readRouteStatus()).toBe('App.');
    await advance(16);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('Agent.');
    expect(announcements.messages).toEqual(['Agent.']);

    fireEvent.click(screen.getByRole('button', { name: 'App' }));
    expect(readRouteStatus()).toBe('Agent.');
    await advance(16);
    await flushAnnouncementObserver();
    expect(readRouteStatus()).toBe('App.');
    expect(announcements.messages).toEqual(['Agent.', 'App.']);
    announcements.disconnect();
  });

  it('does not announce no-op, playback, resize or unrelated rerenders', async () => {
    // Let Vite's lazy editor import resolve with real timers before exercising playback.
    vi.useRealTimers();
    const rendered = render(<PublicAstridShell />);
    await screen.findByRole('button', { name: 'Play' }, {}, { timeout: 4_500 });
    expect(readRouteStatus()).toBe('App.');
    const announcements = observeRouteAnnouncements();
    await flushAnnouncementObserver();
    announcements.ignoreCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'App' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    window.dispatchEvent(new Event('resize'));
    rendered.rerender(<PublicAstridShell />);
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    expect(readRouteStatus()).toBe('App.');
    await flushAnnouncementObserver();
    expect(announcements.messages).toEqual([]);
    announcements.disconnect();
  });

  it('switches Agent to App when the receded editor behind the conversation is clicked', async () => {
    vi.useRealTimers();
    setRoute('?experience=agent');
    render(<PublicAstridShell />);
    const stage = screen.getByRole('group', { name: /editor preview/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }, {}, { timeout: 4_500 }));
    expect(screen.getByRole('main')).toHaveAttribute('data-audience', 'agent');
    fireEvent.click(stage);
    expect(screen.getByRole('main')).toHaveAttribute('data-audience', 'app');
    expect(new URL(window.location.href).searchParams.get('experience')).toBeNull();
  });

  it('returns a verified result to App on its exact clip without starting playback', async () => {
    vi.useRealTimers();
    setRoute('?experience=agent&test-verified-result=1');
    render(<PublicAstridShell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open test verified result' }));

    const currentUrl = new URL(window.location.href);
    expect(currentUrl.searchParams.get('experience')).toBeNull();
    expect(currentUrl.searchParams.get('view')).toBeNull();
    expect(screen.getByRole('main')).toHaveAttribute('data-audience', 'app');
    expect(__getSelectionStateForTests().timeline.selectedClipId).toBe('light-study-02');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});
