// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicAstridSite } from './PublicAstridSite';
import { PUBLIC_ASTRID_SHARE_PAGES } from './publicAstridShare';

const conversationLoad = vi.hoisted(() => ({ defer: false, ready: null as null | (() => void) }));

vi.mock('./PublicAstridSky.tsx', async (original) => ({
  ...await original<typeof import('./PublicAstridSky')>(),
  PublicAstridSky: ({ reducedMotion }: { reducedMotion: boolean }) => <div data-testid="sky" data-reduced={reducedMotion} />,
}));
vi.mock('./publicAstridExampleSelection.ts', async (original) => ({
  ...await original<typeof import('./publicAstridExampleSelection')>(),
  loadActivePublicAstridExample: async () => ({}),
}));
vi.mock('./PublicAstridMountedEditor.tsx', async () => {
  const React = await import('react');
  return { PublicAstridMountedEditor: ({ active, attempt, conversationActive, onConversationReady }: { active: boolean; attempt: number; conversationActive: boolean; onConversationReady: (attempt: number) => void }) => {
    const [selection, setSelection] = React.useState('first');
    React.useEffect(() => {
      conversationLoad.ready = () => onConversationReady(attempt);
      if (!conversationLoad.defer) conversationLoad.ready();
    }, [attempt, onConversationReady]);
    return <div data-testid="editor" data-active={active}>
      <button onClick={() => setSelection('second')}>Select second clip</button>
      <span data-testid="selection">{selection}</span>
      <div className="astrid-editor-tilt"><div className="astrid-editor-surfaces">
        <div className="astrid-player-surface" data-astrid-preview-frame-ready="true" />
        <div className="astrid-timeline-surface" />
        <div className="astrid-chat-surface" />
        <div data-astrid-inspector-ready="true" />
      </div></div>
      <div className="astrid-preview-transport-outlet" />
    </div>;
  } };
});

type DeferredTransition = {
  update: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
  skipTransition: ReturnType<typeof vi.fn>;
};
let transitions: DeferredTransition[];
let motion: boolean;
let hidden: boolean;
let frames: Map<number, FrameRequestCallback>;
let queries: Map<string, Set<() => void>>;

function deferTransitions() {
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const finished = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const skipTransition = vi.fn();
    transitions.push({ update, resolve, reject, skipTransition });
    return { finished, skipTransition };
  }) });
}

function historyAt(path: string, state: unknown = null) {
  act(() => {
    window.history.replaceState(state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

async function update(transition: DeferredTransition) {
  await act(async () => { transition.update(); await Promise.resolve(); });
}

async function finish(transition: DeferredTransition, rejected = false) {
  await act(async () => {
    if (rejected) transition.reject(new Error('skipped transition'));
    else transition.resolve();
    await Promise.resolve();
  });
}

async function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  await act(async () => { callbacks.forEach((callback) => callback(performance.now())); });
}

function changeMotion(value: boolean) {
  motion = value;
  act(() => queries.get('(prefers-reduced-motion: reduce)')?.forEach((listener) => listener()));
}

function changeVisibility(value: boolean) {
  hidden = value;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
}

async function mountedHome() {
  const view = render(<StrictMode><PublicAstridSite /></StrictMode>);
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('editor')).toBeInTheDocument();
  });
  // The bounded third-party readiness fallback is deliberately preserved.
  await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
  await paint();
  await paint();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  transitions = [];
  frames = new Map();
  queries = new Map();
  motion = false;
  hidden = false;
  // The App view is explicit; an unqualified home URL intentionally lands in Agent.
  window.history.replaceState(null, '', '/home?experience=app');
  delete (document as Document & { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.astridPageTransition;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
    if (!queries.has(media)) queries.set(media, new Set());
    const listeners = queries.get(media)!;
    return {
      media, get matches() { return media.includes('prefers-reduced-motion') && motion; },
      onchange: null,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as MediaQueryList;
  });
  let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) });
});

afterEach(() => {
  conversationLoad.defer = false;
  conversationLoad.ready = null;
  cleanup();
  delete (document as Document & { startViewTransition?: unknown }).startViewTransition;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('public Site lifecycle and navigation ownership', () => {
  it('reveals direct Agent entry only after the conversation has mounted', async () => {
    conversationLoad.defer = true;
    window.history.replaceState(null, '', '/home?experience=agent');
    const view = render(<PublicAstridSite />);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId('editor')).toBeInTheDocument();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    await paint();
    await paint();
    const stage = document.querySelector('.astrid-editor-stage');
    expect(stage).toHaveAttribute('data-revealed', 'false');
    act(() => conversationLoad.ready?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(stage).toHaveAttribute('data-astrid-readiness', 'settled');
    expect(stage).toHaveAttribute('data-revealed', 'true');
    view.unmount();
  });

  it('retains Home state and scroll across repeated round trips, with no hidden callout frames', async () => {
    const view = await mountedHome();
    const home = document.querySelector('.astrid-public-site')!;
    const editor = screen.getByTestId('editor');
    fireEvent.click(screen.getByText('Select second clip'));
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await paint();
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(427);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    for (let trip = 0; trip < 3; trip += 1) {
      fireEvent.click(screen.getByRole('link', { name: 'Vision & Issues' }));
      expect(window.location.pathname).toBe('/vision');
      expect(home).toHaveAttribute('data-astrid-lifecycle', 'retained');
      expect(home.parentElement).toHaveAttribute('inert');
      expect(home.parentElement).toHaveAttribute('aria-hidden', 'true');
      expect(editor).toHaveAttribute('data-active', 'false');
      expect(screen.getAllByTestId('sky')).toHaveLength(1);
      expect(frames.size).toBe(0);
      const reads = vi.spyOn(home, 'getBoundingClientRect');
      fireEvent(window, new Event('resize'));
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(frames.size).toBe(0);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      expect(document.activeElement).toHaveClass('astrid-vision');
      expect(document.title).toBe(PUBLIC_ASTRID_SHARE_PAGES.vision.title);
      fireEvent.click(screen.getByRole('link', { name: 'Astrid home' }));
      fireEvent.click(screen.getByRole('link', { name: 'Astrid home' }));
      expect(back).toHaveBeenCalledTimes(trip + 1);
      historyAt('/home?experience=agent');
      expect(document.querySelector('.astrid-public-site')).toBe(home);
      expect(screen.getByTestId('editor')).toBe(editor);
      expect(screen.getByTestId('selection')).toHaveTextContent('second');
      expect(home).toHaveAttribute('data-audience', 'agent');
      expect(home.parentElement).not.toHaveAttribute('inert');
      expect(home).toHaveFocus();
      expect(window.scrollTo).toHaveBeenLastCalledWith(0, 427);
      expect(document.title).toBe(PUBLIC_ASTRID_SHARE_PAGES.home.title);
      await paint();
    }
    view.unmount();
    expect(frames.size).toBe(0);
    for (const listeners of queries.values()) expect(listeners.size).toBe(0);
  });

  it('rejects deferred audience/page commits and same-destination stale cleanup', async () => {
    await mountedHome();
    deferTransitions();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    const audience = transitions[0];
    fireEvent.click(screen.getByRole('link', { name: 'Vision & Issues' }));
    const oldVision = transitions[1];
    historyAt('/home?experience=app');
    const home = transitions[2];
    fireEvent.click(screen.getByRole('link', { name: 'Vision & Issues' }));
    const currentVision = transitions[3];
    await update(audience);
    await update(oldVision);
    await update(home);
    expect(document.querySelector('.astrid-public-site')).toHaveAttribute('data-audience', 'app');
    expect(document.querySelector('.astrid-vision')).toBeNull();
    await finish(oldVision, true);
    expect(document.documentElement.dataset.astridPageTransition).toBe('vision');
    await update(currentVision);
    expect(document.querySelector('.astrid-vision')).not.toBeNull();
    await finish(currentVision);
    expect(document.documentElement).not.toHaveAttribute('data-astrid-page-transition');
    await finish(audience);
    await finish(home);
    expect(document.title).toBe(PUBLIC_ASTRID_SHARE_PAGES.vision.title);
  });

  it('allows a same-rendered-audience reversal to invalidate a deferred audience request', async () => {
    await mountedHome();
    deferTransitions();
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'App' }));
    await update(transitions[1]);
    await update(transitions[0]);
    await finish(transitions[0], true);
    expect(document.querySelector('.astrid-public-site')).toHaveAttribute('data-audience', 'app');
    expect(window.location.search).toBe('');
  });

  it('deduplicates Vision links and invalidates pending commits at disposal', async () => {
    const view = await mountedHome();
    deferTransitions();
    const push = vi.spyOn(window.history, 'pushState');
    const visionLink = screen.getByRole('link', { name: 'Vision & Issues' });
    fireEvent.click(visionLink);
    fireEvent.click(visionLink);
    expect(push).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(1);
    const title = document.title;
    view.unmount();
    await update(transitions[0]);
    await finish(transitions[0], true);
    expect(document.title).toBe(title);
    expect(document.documentElement).not.toHaveAttribute('data-astrid-page-transition');
    expect(frames.size).toBe(0);
    for (const listeners of queries.values()) expect(listeners.size).toBe(0);
  });

  it('uses live motion/visibility inputs and settles pending navigation without hidden work', async () => {
    await mountedHome();
    deferTransitions();
    fireEvent.click(screen.getByRole('link', { name: 'Vision & Issues' }));
    changeMotion(true);
    expect(document.querySelector('.astrid-vision')).not.toBeNull();
    expect(screen.getByTestId('sky')).toHaveAttribute('data-reduced', 'true');
    expect(transitions[0].skipTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveAttribute('data-astrid-page-transition');
    await update(transitions[0]);
    changeVisibility(true);
    expect(screen.queryByTestId('sky')).toBeNull();
    expect(frames.size).toBe(0);
    changeVisibility(false);
    changeMotion(false);
    expect(screen.getByTestId('sky')).toHaveAttribute('data-reduced', 'false');
    historyAt('/home');
    const returning = transitions[1];
    changeVisibility(true);
    expect(document.querySelector('.astrid-vision')).toBeNull();
    expect(document.querySelector('.astrid-public-site')).toHaveAttribute('data-astrid-visual-active', 'false');
    expect(frames.size).toBe(0);
    await update(returning);
    changeVisibility(false);
    await paint();
    expect(document.querySelector('.astrid-public-site')).toHaveAttribute('data-astrid-visual-active', 'true');
  });

  it('keeps desktop geometry event-driven and quiescent when reduced motion is enabled', async () => {
    await mountedHome();
    // Idle geometry does not enqueue frames.
    expect(frames.size).toBe(0);
    changeMotion(true);
    await paint();
    await paint();
    expect(frames.size).toBe(0);
    fireEvent(window, new Event('resize'));
    expect(frames.size).toBe(1);
    await paint();
    expect(frames.size).toBe(0);
    changeMotion(false);
    await paint();
    await paint();
    expect(frames.size).toBe(0);
    fireEvent(window, new Event('resize'));
    expect(frames.size).toBe(1);
    changeVisibility(true);
    expect(frames.size).toBe(0);
  });

  it('moves focus to Vision and cancels the Home sky replay', async () => {
    await mountedHome();
    fireEvent.click(screen.getByRole('button', { name: 'Watch a day go by' }));
    expect(document.querySelector('.astrid-brand-mink-button')).toHaveAttribute('data-pose', 'facing');
    fireEvent.click(screen.getByRole('link', { name: 'Vision & Issues' }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toHaveClass('astrid-vision');
    expect(document.querySelector('.astrid-brand-mink-button')).toHaveAttribute('data-pose', 'profile');
    // Vision's new section tracker schedules one initial measurement/alignment
    // frame on mount; drain those before checking for any continuing Home replay.
    await paint();
    await paint();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(frames.size).toBe(0);
    historyAt('/home');
    expect(document.querySelector('dialog')).toBeNull();
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const)('preserves %s link handling', async (modifier) => {
    await mountedHome();
    const push = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByRole('link', { name: 'Vision & Issues' }), { [modifier]: true });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/home');
  });

  it('opens Home from direct Vision without retaining a second active sky', async () => {
    window.history.replaceState(null, '', '/vision');
    render(<PublicAstridSite />);
    expect(document.querySelector('.astrid-public-site')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Astrid home' }));
    expect(window.location.pathname).toBe('/');
    expect(document.querySelector('.astrid-public-site')).toHaveAttribute('data-astrid-lifecycle', 'active');
    expect(screen.getAllByTestId('sky')).toHaveLength(1);
  });
});
