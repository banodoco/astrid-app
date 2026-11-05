import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { finishEditorTour } from '@/tools/video-editor/tour/runner/tourBeats';
import { registerBrowserTourFinish } from '@/tools/video-editor/tour/runner/tourBeats';
import { startEditorTour, setEditorTourBeat, getEditorTourState } from '@/shared/state/editorTourStore';
import { useEffect } from 'react';
const spies = vi.hoisted(() => ({ record: vi.fn(), connected: vi.fn() }));
vi.mock('@/tools/video-editor/tour/runner/tourRecord', () => ({ recordEditorTour: spies.record, buildEditorTourRecord: vi.fn() }));
vi.mock('./BrowserTourEditor', () => ({ BrowserTourEditor: ({onFinish, atEnd = false}: {onFinish:()=>void; atEnd?: boolean}) => {
  useEffect(() => {
    const off = registerBrowserTourFinish(onFinish);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') finishEditorTour(); };
    window.addEventListener('keydown', onKey);
    startEditorTour();
    return () => { off(); window.removeEventListener('keydown', onKey); };
  }, [onFinish]);
  return <><h1>{atEnd ? 'Last card' : 'Welcome to Astrid'}</h1><button onClick={finishEditorTour}>Skip</button><button onClick={() => { setEditorTourBeat(3, 'feedback'); finishEditorTour(); }}>Done</button></>;
} }));
vi.mock('./WelcomeConnection', () => ({ default: ({ onBack }: { onBack: () => void }) => { spies.connected(); return <><h1>Connect your machine</h1><button onClick={onBack}>Back</button></>; } }));
vi.mock('./WelcomeRunMode', () => ({ WelcomeRunMode: ({ onContinue, runMode, setRunMode }: { onContinue: (phase: 'setup') => void; runMode: 'hosted' | 'local'; setRunMode: (mode: 'hosted' | 'local') => void }) => <><h1>How do you want to run the app?</h1><button onClick={() => { setRunMode('hosted'); onContinue('setup'); }}>Connect</button><button onClick={() => { setRunMode('local'); onContinue('setup'); }}>Local</button><span>{runMode}</span></> }));
vi.mock('./WelcomeLocalSetup', () => ({ WelcomeLocalSetup: ({ onBack, onContinue }: { onBack: () => void; onContinue?: () => void }) => <><h1>Have your agent set it up</h1><span>npm run dev:local</span><button onClick={onContinue}>Continue to Astrid</button><button onClick={onBack}>Back</button></> }));
import { WelcomeFlow } from './WelcomeFlow';
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); spies.record.mockClear(); spies.connected.mockClear();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36');
  window.history.replaceState({}, '', '/tools/video-editor');
});
afterEach(() => vi.unstubAllGlobals());
for (const action of ['Skip', 'Done']) it(`${action} opens the run-mode choice`, async () => {
  render(<WelcomeFlow entry="tour" />);
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('tour');
  expect(screen.getByText('Welcome to Astrid')).toBeInTheDocument();
  expect(spies.connected).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(action));
  await waitFor(() => expect(screen.getByText('How do you want to run the app?')).toBeInTheDocument());
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('choose');
  expect(getEditorTourState().status).toBe('idle');
  expect(spies.record).not.toHaveBeenCalled();
});

it('Escape opens the run-mode choice', async () => {
  render(<WelcomeFlow entry="tour" />);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(await screen.findByText('How do you want to run the app?')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('choose');
});

it('moves from the choice to local setup or connection and back', async () => {
  render(<WelcomeFlow entry="choose" />);
  fireEvent.click(screen.getByText('Local'));
  expect(await screen.findByText('Have your agent set it up')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('setup');
  fireEvent.click(screen.getByText('Back'));
  expect(await screen.findByText('How do you want to run the app?')).toBeInTheDocument();
  expect(screen.getByText('local')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Connect'));
  expect(await screen.findByRole('main', { name: 'Set up Astrid' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Astrid' }));
  expect(await screen.findByText('Connect your machine')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('connection');
});

it('returns from connection to the saved hosting choice', async () => {
  render(<WelcomeFlow entry="choose" />);
  fireEvent.click(screen.getByText('Connect'));
  expect(await screen.findByRole('main', { name: 'Set up Astrid' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Astrid' }));
  expect(await screen.findByText('Connect your machine')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('connection');

  fireEvent.click(screen.getByText('Back'));
  expect(await screen.findByText('How do you want to run the app?')).toBeInTheDocument();
  expect(screen.getByText('hosted')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('choose');
});

it('returns from the local screen with local selected, including after loading that phase directly', async () => {
  render(<WelcomeFlow entry="local" />);
  expect(await screen.findByText('Have your agent set it up')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Back'));
  expect(await screen.findByText('How do you want to run the app?')).toBeInTheDocument();
  expect(screen.getByText('local')).toBeInTheDocument();
});

it('keeps a saved local setup when an installer connection handoff arrives', async () => {
  localStorage.setItem('astrid:welcome-v1', 'local');
  render(<WelcomeFlow entry="connection" />);
  expect(await screen.findByText('Have your agent set it up')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('local');
  expect(spies.connected).not.toHaveBeenCalled();
});

it('keeps local mode through a reload in setup and an installer connection handoff', async () => {
  const first = render(<WelcomeFlow entry="choose" />);
  fireEvent.click(screen.getByText('Local'));
  expect(await screen.findByText('Have your agent set it up')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-run-mode-v1')).toBe('local');
  localStorage.setItem('astrid:welcome-v1', 'setup');
  // Simulate the next document using the persisted phase and installer query route.
  window.history.replaceState({}, '', '/tools/video-editor?connect=1');
  first.unmount();
  render(<WelcomeFlow entry="connection" />);
  expect(await screen.findByText('Have your agent set it up')).toBeInTheDocument();
  expect(screen.getByText('npm run dev:local')).toBeInTheDocument();
  expect(spies.connected).not.toHaveBeenCalled();
});

it('keeps the combined work destination and hash through the setup completion handoff', async () => {
  const replaced: string[] = [];
  const browserWindow = window;
  vi.stubGlobal('window', new Proxy(browserWindow, { get(target, property) {
    if (property === 'location') return { href: target.location.href, origin: target.location.origin, pathname: target.location.pathname,
      search: target.location.search, hash: target.location.hash, replace: (url: string) => replaced.push(url) };
    const value = Reflect.get(target, property, target);
    return ['addEventListener', 'removeEventListener', 'dispatchEvent'].includes(String(property)) ? value.bind(target) : value;
  } }));
  window.history.replaceState({}, '', '/tools/video-editor?project=requested&timeline=cut&connect=1#edit');
  render(<WelcomeFlow entry="setup" />);
  expect(screen.getByRole('main', { name: 'Set up Astrid' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Astrid' }));
  expect(replaced).toEqual(['/tools/video-editor?project=requested&timeline=cut&connect=1#edit']);
  expect(spies.connected).not.toHaveBeenCalled();
  vi.stubGlobal('window', browserWindow);
});

it('does not let a stale onboarding tab overwrite completed setup', () => {
  localStorage.setItem('astrid:welcome-v1', 'complete');
  render(<WelcomeFlow entry="choose" />);
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('complete');
});

it.each([['local editor', { localBuild: true }], ['phone', { localBuild: false }]])('%s goes from the tour to setup before connection', async (_name, props) => {
  if (_name === 'phone') {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
  }
  render(<WelcomeFlow entry="tour" {...props} />);
  fireEvent.click(screen.getByText('Done'));
  if (_name === 'local editor') {
    expect(await screen.findByText('Have your agent set it up')).toBeInTheDocument();
    expect(screen.getByText('npm run dev:local')).toBeInTheDocument();
  } else {
    expect(await screen.findByRole('main', { name: 'Set up Astrid' })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Astrid' }));
  expect(await screen.findByText('Connect your machine')).toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('connection');
  expect(screen.queryByText('How do you want to run the app?')).not.toBeInTheDocument();
  // Back returns to where the user came from (the tour's last card), never to the skipped run-mode choice.
  fireEvent.click(screen.getByText('Back'));
  expect(await screen.findByText('Last card')).toBeInTheDocument();
  expect(screen.queryByText('How do you want to run the app?')).not.toBeInTheDocument();
  expect(localStorage.getItem('astrid:welcome-v1')).toBe('tour');
});
