// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { consumeAutoConnectQuery } from '@/integrations/runtime/autoConnectRequest.ts';
import { CONNECTED_MIN_MS, LEAVE_MS, RuntimeConnectionPanel, SETTLED_QUIET_MS } from './RuntimeConnectionPanel.tsx';
import { installCommand, PINOKIO_INSTALL_COPY, RUNTIME_CONNECTION_COPY as COPY } from './copy.ts';
import { CONNECTED_REALM, connectionFor } from './connectionFixture.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function panel(connection: RuntimeConnectionValue) {
  return render(<RuntimeConnectionPanel connection={connection} />);
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

/** Every visible word: the panel's text content, with no hidden helper text. */
const shownText = () => document.body.textContent ?? '';

/** The card every not-connected screen shares. */
const CARD = '.rounded-\\[18px\\]';

/** What a person must never read on these screens (the agent block is the only place for these words). */
const ENGINEER_WORDS = /Runtime|workspace|realm|gateway|loopback|127\.0\.0\.1|ACP|identity|discovery|profile|process|npm run|banodoco/;

const ALL_SCREENS: ReadonlyArray<[string, () => RuntimeConnectionValue]> = [
  ['permission', () => connectionFor({ status: 'needs_permission' })],
  ['permission pending', () => connectionFor({ status: 'needs_permission' }, { isChecking: true })],
  ['blocked', () => connectionFor({ status: 'blocked' })],
  ['not running', () => connectionFor({ status: 'not_running' })],
  ['refused', () => connectionFor({ status: 'refused' })],
  ['phone', () => connectionFor({ status: 'phone' })],
  ['unsupported browser', () => connectionFor({ status: 'unsupported' })],
];

describe('RuntimeConnectionPanel', () => {
  it('a fresh browser after the welcome tour can choose to connect from the permission screen', () => {
    const connect = vi.fn();
    const view = panel(connectionFor({ status: 'needs_permission' }, { connect }));
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission');
    expect(screen.getByRole('heading', { name: 'Connect to Astrid on this computer' })).toBeInTheDocument();
    expect(shownText()).toContain('Chrome will ask to let astrid.haus reach Astrid on this computer. Choose Allow.');
    expect(screen.queryByText(COPY.waiting)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByText('Already have Astrid on this computer?')).not.toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    const installDisclosure = screen.getByRole('button', { name: "Don't have Astrid yet?" });
    expect(installDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    fireEvent.click(installDisclosure);
    expect(installDisclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('code')).toHaveTextContent(installCommand('install'));

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connect).toHaveBeenCalledOnce();
    view.rerender(<RuntimeConnectionPanel connection={connectionFor({ status: 'needs_permission' }, { isChecking: true, connect })} />);
    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
    expect(screen.getByRole('heading', { name: 'Choose Allow in Chrome' })).toBeInTheDocument();
    expect(screen.queryByText(COPY.waiting)).not.toBeInTheDocument();
  });

  it('offers a quiet Pinokio install link after the install command for desktop Chromium', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    panel(connectionFor({ status: 'needs_permission' }));
    const disclosure = screen.getByRole('button', { name: "Don't have Astrid yet?" });
    fireEvent.click(disclosure);
    const pinokioLink = screen.getByRole('link', { name: 'Or install with Pinokio' });
    expect(pinokioLink).toHaveAttribute('href', PINOKIO_INSTALL_COPY.installUrl);
    expect(pinokioLink).toHaveClass('underline', 'underline-offset-4', 'hover:text-foreground');
    expect(pinokioLink.parentElement).toHaveClass('text-sm', 'text-muted-foreground');
    expect(pinokioLink.compareDocumentPosition(screen.getByRole('code')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Get Pinokio' })).not.toBeInTheDocument();
  });

  it('keeps the install disclosure Pinokio link off unsupported browsers', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Firefox/131.0');
    panel(connectionFor({ status: 'needs_permission' }));
    fireEvent.click(screen.getByRole('button', { name: "Don't have Astrid yet?" }));
    expect(screen.queryByRole('link', { name: 'Or install with Pinokio' })).not.toBeInTheDocument();
  });

  it('places an optional onboarding Back action in the card corner only for its caller', () => {
    const onBack = vi.fn();
    const view = render(<RuntimeConnectionPanel connection={connectionFor({ status: 'not_running' })} onBack={onBack} />);
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.closest(CARD)).not.toBeNull();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();

    view.rerender(<RuntimeConnectionPanel connection={connectionFor({ status: 'not_running' })} />);
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it.each(ALL_SCREENS)('%s: speaks of Astrid and never names a Runtime, workspace, port or command', (_name, connection) => {
    panel(connection());
    expect(shownText()).toContain('Astrid');
    expect(shownText()).not.toMatch(ENGINEER_WORDS);
    expect(shownText()).not.toMatch(/\bport\b|\borigin\b/i);
  });

  it('shows the install dialog\'s mink tile in every state, at its size, and no per-state icon', () => {
    for (const [, connection] of ALL_SCREENS) {
      const view = panel(connection());
      const avatar = view.container.querySelector('img[src="/astrid-app-icon-192.png"]');
      expect(avatar).not.toBeNull();
      expect(avatar).toHaveAttribute('alt', '');
      // 76px like .astrid-install-avatar; the file carries its own rounded tile, so nothing rounds it again.
      expect(avatar).toHaveClass('h-[76px]', 'w-[76px]');
      expect(avatar).not.toHaveClass('rounded-xl');
      // The tile is the only picture a card shows; the still editor drawn behind it is aria-hidden scenery.
      expect([...view.container.querySelectorAll('img')].filter((img) => !img.closest('[aria-hidden="true"]'))).toEqual([avatar]);
      // The only svgs are the button's own icon and (while the browser asks) the pointing arrow; none is a status icon.
      expect(view.container.querySelector('.lucide-plug, .lucide-wifi-off, .lucide-shield-alert, .lucide-triangle-alert')).toBeNull();
      cleanup();
    }
  });

  it('lays every card out like the install dialog, over the empty editor, with the waiting line along its foot', () => {
    panel(connectionFor({ status: 'not_running' }));
    const section = screen.getByTestId('runtime-not-connected');
    expect(section).toHaveClass('fixed', 'inset-0');
    // The empty editor is drawn beneath the card, inert and hidden from assistive tech.
    const frame = section.querySelector('[inert]') as HTMLElement;
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(frame.querySelector('header')).not.toBeNull();
    expect(frame.querySelector('main')).not.toBeNull();
    const card = section.querySelector(CARD) as HTMLElement;
    expect(card).toHaveClass('border-border', 'bg-card', 'text-center');
    expect(card.parentElement).toHaveClass('max-w-[576px]');
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('font-theme-heading', 'text-[25px]', 'text-foreground');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.agent.copy })).toHaveClass('w-full');
    // The waiting line is the card's last line, not a banner above it.
    expect(card.lastElementChild).toContainElement(screen.getByText(COPY.waiting));
    expect(card.lastElementChild).toContainElement(screen.getByRole('link', { name: 'Get help' }));
  });

  describe('connecting', () => {
    it('is only the mink on the page background, with no card, heading or button', () => {
      const view = panel(connectionFor({ status: 'connecting' }, { isBooting: true }));

      expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'connecting');
      expect(screen.getByTestId('runtime-not-connected')).toHaveClass('bg-background');
      expect(view.container.querySelector('.astrid-mink-runner')).not.toBeNull();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(view.container.querySelector('img')).toBeNull();
      expect(view.container.querySelector(CARD)).toBeNull();
    });

    it('draws the mark at the boot screen\'s size and marks it for the boot layer to hand its stride to', () => {
      const view = panel(connectionFor({ status: 'connecting' }, { isBooting: true }));

      const mark = view.container.querySelector('.astrid-mink-runner') as HTMLElement;
      expect(mark).toHaveClass('astrid-mink-runner-boot');
      expect(mark).toHaveAttribute('data-boot-mink-continue');
      // Nothing else on the page carries the marker, and no other state does.
      expect(view.container.querySelectorAll('[data-boot-mink-continue]')).toHaveLength(1);
      cleanup();
      const other = panel(connectionFor({ status: 'not_running' }));
      expect(other.container.querySelector('[data-boot-mink-continue]')).toBeNull();
    });

    it('fades in one line under the mark after a second', () => {
      vi.useFakeTimers();
      panel(connectionFor({ status: 'connecting' }, { isBooting: true }));
      expect(screen.queryByText(COPY.connecting.sentence)).not.toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText(COPY.connecting.sentence)).toBeInTheDocument();
      expect(screen.getByText(COPY.connecting.sentence).closest('p')).toHaveClass('text-sm', 'text-muted-foreground');
    });

    it('shows a starting Astrid exactly as connecting', () => {
      vi.useFakeTimers();
      panel(connectionFor({ status: 'connecting' }));
      act(() => { vi.advanceTimersByTime(1000); });

      expect(screen.getByText(COPY.connecting.sentence)).toBeInTheDocument();
      expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'connecting');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });
  });

  it('permission prompt: explains first, sends nothing, and Connect is what asks', () => {
    const connect = vi.fn();
    panel(connectionFor({ status: 'needs_permission' }, { connect }));

    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'permission');
    expect(screen.getByRole('heading', { name: 'Connect to Astrid on this computer' })).toBeInTheDocument();
    expect(screen.getByText('Chrome will ask to let astrid.haus reach Astrid on this computer. Choose Allow.')).toBeInTheDocument();
    const connectButton = screen.getByRole('button', { name: 'Connect' });
    const disclosureButton = screen.getByRole('button', { name: 'What does this allow?' });
    expect(connectButton.compareDocumentPosition(disclosureButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(COPY.permission.allowDetails)).not.toBeInTheDocument();
    fireEvent.click(disclosureButton);
    expect(screen.getByText("This page can talk to Astrid running on your computer, and nothing else. Astrid only lets it work with your Astrid projects, media and jobs. It can't open your other files or apps. Chat messages go to your own agent on this computer. Your work never passes through our servers.")).toBeInTheDocument();
    // Nothing is waiting yet: Connect is what starts it.
    expect(screen.queryByText(COPY.waiting)).not.toBeInTheDocument();
    const installDisclosure = screen.getByRole('button', { name: "Don't have Astrid yet?" });
    expect(installDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /agent/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it('keeps every card in the middle of a phone\'s screen, none along the bottom', () => {
    panel(connectionFor({ status: 'needs_permission' }, { isChecking: true }));
    expect(screen.getByTestId('runtime-not-connected').querySelector('.max-sm\\:items-end')).toBeNull();
    cleanup();
    panel(connectionFor({ status: 'needs_permission' }));
    expect(screen.getByTestId('runtime-not-connected').querySelector('.items-center.justify-center')).not.toBeNull();
    expect(screen.getByTestId('runtime-not-connected').querySelector('.max-sm\\:items-end')).toBeNull();
  });

  it('connect pending: tells the person to choose Allow, says where, and draws the install dialog\'s arrow outside the card, aimed top left', () => {
    // The card where it sits in a 1440 × 900 window (jsdom lays nothing out).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 432, y: 354, left: 432, top: 354, right: 1008, bottom: 604, width: 576, height: 250, toJSON: () => ({}) });
    const view = panel(connectionFor({ status: 'needs_permission' }, { isChecking: true }));

    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'pending');
    expect(screen.getByRole('heading', { name: 'Choose Allow in Chrome' })).toBeInTheDocument();
    expect(screen.getByText('The prompt is at the top left of this window.')).toBeInTheDocument();
    expect(screen.queryByText(COPY.waiting)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    expect(view.container.querySelector('svg.lucide-arrow-up')).toBeNull();
    const arrow = document.body.querySelector('svg.astrid-toolbar-pointer') as SVGElement;
    expect(arrow).not.toBeNull();
    expect(arrow.parentElement).toBe(document.body);
    expect(arrow).toHaveAttribute('data-corner', 'top-left');
    expect(arrow).toHaveAttribute('data-tone', 'page');
    expect(arrow).toHaveAttribute('aria-hidden', 'true');
    // The portal spans the viewport. The arrow is a short gesture towards the browser's prompt at the top left, not a
    // line all the way there: it leaves the card, its head points up and to the left, and it ends nearer the card than the corner.
    expect(arrow.querySelector('text')?.textContent).toBe('UP HERE');
    const numbers = (selector: string) => (arrow.querySelector(selector)?.getAttribute('d')?.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const line = numbers('path.astrid-toolbar-pointer-line');
    const [[startX, startY], [endX, endY]] = [line.slice(0, 2), line.slice(-2)];
    const [barbX, barbY, tipX, tipY, otherBarbX, otherBarbY] = numbers('path.astrid-toolbar-pointer-head');
    expect([tipX, tipY]).toEqual([endX, endY]);
    expect(startY).toBeLessThan(354);
    expect(tipX).toBeLessThan((barbX + otherBarbX) / 2);
    expect(tipY).toBeLessThan((barbY + otherBarbY) / 2);
    expect(Math.hypot(endX - startX, endY - startY)).toBeLessThan(Math.hypot(endX, endY));
    expect(shownText()).not.toContain('just below the address bar');
  });

  it('browser blocked: two numbered steps in the browser, left-aligned, and the page opens by itself', () => {
    const view = panel(connectionFor({ status: 'blocked' }));

    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'blocked');
    expect(screen.getByRole('heading', { name: 'Allow Astrid in Chrome' })).toBeInTheDocument();
    expect(screen.getByText('Chrome is blocking this page from reaching Astrid.')).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem');
    // Numbered in circles as the install dialog numbers its steps.
    expect(steps.map((step) => step.querySelector('[aria-hidden="true"]')?.textContent)).toEqual(['1', '2']);
    expect(steps.map((step) => step.lastElementChild?.textContent)).toEqual([
      'Click the icon at the left of the address bar, then Site settings.',
      'Set Local network access to Allow.',
    ]);
    const list = steps[0].parentElement as HTMLElement;
    expect(list.tagName).toBe('OL');
    expect(list).toHaveClass('text-left', 'text-sm');
    // It waits along the card's foot like every screen that waits.
    const card = screen.getByTestId('runtime-not-connected').querySelector(CARD) as HTMLElement;
    expect(card.lastElementChild).toContainElement(screen.getByText('Come back here and it opens by itself.'));
    // "Local network access" is Chrome's own setting name, the one word of the product's that may appear.
    expect(shownText()).toContain('Local network access');
    expect(shownText()).not.toMatch(/chrome:\/\//);
    expect(view.container.querySelector('code')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it("after permission is granted with nothing answering, shows one repair card and waits for Astrid", () => {
    panel(connectionFor({ status: 'not_running' }));

    expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'not_running');
    expect(screen.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeInTheDocument();
    const sentence = screen.getByText("Your coding agent can start it, or install it if it isn't there yet.");
    expect(sentence).toHaveClass('text-sm', 'text-muted-foreground');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.agent.commandCopy })).toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(installCommand('install'));
    expect(screen.getByText(COPY.waiting)).toBeInTheDocument();
    // The card says what the instructions are for; no line repeats it, and none explains how to open a terminal.
    expect(shownText()).not.toContain('Paste these instructions');
    expect(shownText()).not.toMatch(/Open Terminal|Applications → Utilities/);
    const panelText = screen.getByTestId('runtime-not-connected').textContent ?? '';
    expect(panelText).toContain("isn't there yet");
  });

  const NOT_RUNNING: ReadonlyArray<[string, () => RuntimeConnectionValue]> = [
    ['nothing answers on a return visit', () => connectionFor({ status: 'not_running' })],
    ['Astrid answered but its engine stopped', () => connectionFor({ status: 'not_running' })],
  ];

  it.each(NOT_RUNNING)('not running (%s): one screen with the install line', (_name, connection) => {
    panel(connection());

    expect(screen.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeInTheDocument();
    expect(screen.getByText("Your coding agent can start it, or install it if it isn't there yet.")).toBeInTheDocument();
    expect(screen.getByText(COPY.waiting)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: COPY.agent.commandCopy })).toBeInTheDocument();
    expect(screen.getByRole('code')).toHaveTextContent(installCommand('install'));
    expect(shownText()).not.toMatch(/reload/i);
    expect(screen.queryByText('Set up Astrid on this computer')).not.toBeInTheDocument();
  });

  it.each([
    ['Pinokio', true, false],
    ['non-Pinokio', false, true],
    ['unknown', null, true],
  ] as const)('not-running guidance for %s provenance keeps the matching actions', (provenance, managedByPinokio, showsInstaller) => {
    const connect = vi.fn();
    panel(connectionFor({ status: 'not_running' }, { managedByPinokio, connect }));
    const expectedSentence = managedByPinokio === true ? COPY.notRunning.pinokioHint : COPY.notRunning.sentence;
    const sentence = screen.getByText(expectedSentence);
    expect(sentence).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: COPY.notRunning.retry });
    expect(retry).toBeInTheDocument();
    if (showsInstaller) {
      expect(screen.getByRole('code')).toHaveTextContent(installCommand('install'));
      expect(screen.getByRole('button', { name: COPY.agent.commandCopy })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('code')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: COPY.agent.commandCopy })).not.toBeInTheDocument();
    }
    fireEvent.click(retry);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('Pinokio update guidance gives the visible Stop, Update, Start sequence without installer steps', () => {
    panel(connectionFor({ status: 'update_needed' }, { managedByPinokio: true }));

    expect(screen.getByText('This page needs a newer Astrid. In Pinokio, choose Stop, then Update, then Start.')).toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: COPY.agent.commandCopy })).not.toBeInTheDocument();
    expect(screen.getByText('Update in Pinokio')).toBeInTheDocument();
  });

  it('source update guidance points to updating checkouts and never shows an installer command', () => {
    panel(connectionFor({ status: 'update_needed' }, { managedByPinokio: false }));

    expect(screen.getByText('update your checkouts')).toBeInTheDocument();
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: COPY.agent.commandCopy })).not.toBeInTheDocument();
  });

  describe('refused', () => {
    it('says Astrid is running, names this page, and offers no install command', () => {
      panel(connectionFor({ status: 'refused' }));
      expect(screen.getByTestId('runtime-not-connected')).toHaveAttribute('data-state', 'refused');
      expect(screen.getByRole('heading', { name: "Astrid is running but won't connect to this page" })).toBeInTheDocument();
      expect(screen.getByText(`Astrid on this computer answered, but refused requests from ${window.location.origin}. Open astrid.haus, or update Astrid if this keeps happening.`)).toBeInTheDocument();
      expect(screen.queryByRole('code')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: COPY.agent.commandCopy })).not.toBeInTheDocument();
      expect(shownText()).not.toMatch(/isn't answering|install|curl -fsSL|irm /i);
      expect(screen.getByRole('button', { name: 'Copy for your agent' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByText(COPY.waiting)).toBeInTheDocument();
    });

    it('copies the refusal brief, not the install brief, and Try again reconnects', async () => {
      const writeText = vi.fn(async (_text: string) => undefined);
      stubClipboard(writeText);
      const connect = vi.fn();
      panel(connectionFor({ status: 'refused' }, { connect }));
      fireEvent.click(screen.getByRole('button', { name: 'Copy for your agent' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      const text = writeText.mock.calls[0]![0];
      expect(text).toContain(`refuses requests from the page at ${window.location.origin}`);
      expect(text).toContain(`curl -s -H "Origin: ${window.location.origin}"`);
      expect(text).toContain('/api/runtime/v1/health');
      expect(text).not.toMatch(/set up or restart Astrid/);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(connect).toHaveBeenCalledOnce();
    });
  });

  describe('unsupported browser', () => {
    it.each(['Chrome', 'Edge'])('asks to update %s when its permission API is unsupported and keeps copy fallback', async (browser) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(browser === 'Edge' ? 'Windows NT 10.0 Chrome/100.0 Edg/100.0' : 'Windows NT 10.0 Chrome/100.0');
      stubClipboard(vi.fn(async () => { throw new Error('Clipboard denied'); }));
      panel(connectionFor({ status: 'browser_update_needed' }));
      expect(screen.getByRole('heading', { name: `Update ${browser} to connect` })).toBeInTheDocument();
      expect(screen.getByText(`This version of ${browser} can't reach Astrid on this computer. Update it, then come back.`)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: COPY.unsupported.button }));
      expect(await screen.findByRole('textbox')).toHaveValue(window.location.href);
    });

    it('offers a copyable link for Chrome or Edge', async () => {
      const writeText = vi.fn(async (_text: string) => undefined);
      stubClipboard(writeText);
      panel(connectionFor({ status: 'unsupported' }));

      expect(screen.getByRole('heading', { name: 'Open Astrid in Chrome or Edge' })).toBeInTheDocument();
      expect(screen.getByText('This browser cannot connect to Astrid on your computer.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Copy link for Chrome or Edge' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.href));
      expect(await screen.findByRole('button', { name: 'Copied. Open it in Chrome or Edge.' })).toBeInTheDocument();
    });

    it('keeps connect=1 in the copied link after consuming the installer entry flag', async () => {
      const previousUrl = new URL(window.location.href);
      const writeText = vi.fn(async (_text: string) => undefined);
      stubClipboard(writeText);
      sessionStorage.clear();
      window.history.replaceState({}, '', '/tools/video-editor?timeline=first&connect=1#frame=42');

      try {
        expect(consumeAutoConnectQuery()).toBe(true);
        expect(window.location.href).not.toContain('connect=1');
        panel(connectionFor({ status: 'unsupported' }));
        fireEvent.click(screen.getByRole('button', { name: COPY.unsupported.button }));

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/tools/video-editor?timeline=first&connect=1#frame=42`));
      } finally {
        window.history.replaceState({}, '', `${previousUrl.pathname}${previousUrl.search}${previousUrl.hash}`);
        sessionStorage.clear();
      }
    });

    it('renders the phone screen from provider state without user-agent detection', () => {
      panel(connectionFor({ status: 'phone' }));
      expect(screen.getByRole('heading', { name: 'Open Astrid on your computer' })).toBeInTheDocument();
      expect(screen.getByText('Astrid runs on a computer, so open this page there.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send the link to your computer' })).toBeInTheDocument();
    });

    it('copies this page\'s address and then reads "Link copied" with a check', async () => {
      const previousUrl = window.location.href;
      window.history.replaceState({}, '', '/tools/video-editor?timeline=timeline-7#frame-42');
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      stubClipboard(writeText);
      panel(connectionFor({ status: 'phone' }));
      fireEvent.click(screen.getByRole('button', { name: 'Send the link to your computer' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument());
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/tools/video-editor?timeline=timeline-7#frame-42`);
      expect(screen.getByRole('button', { name: 'Link copied' }).querySelector('svg.lucide-check')).not.toBeNull();
      const previous = new URL(previousUrl);
      window.history.replaceState({}, '', `${previous.pathname}${previous.search}${previous.hash}`);
    });

    it('shows a selectable link when neither sharing nor clipboard is available', () => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      panel(connectionFor({ status: 'phone' }));
      expect(screen.getByRole('textbox', { name: 'Send the link to your computer' })).toHaveValue(window.location.href);
    });
  });

  it('renders nothing once connected: the gate shows the app', () => {
    const { container } = panel(connectionFor({ status: 'connected', realm: CONNECTED_REALM }));
    expect(container).toBeEmptyDOMElement();
  });

  describe('command copying', () => {
    it.each([
      ['not_running', () => connectionFor({ status: 'not_running' }), 'install'],
    ] as const)('%s shows and copies its command', async (_name, connection, mode) => {
      const writeText = vi.fn(async (_text: string) => undefined);
      stubClipboard(writeText);
      panel(connection());
      const command = mode === 'update' ? installCommand('update') : installCommand('install');
      expect(screen.getByRole('code')).toHaveTextContent(command);
      fireEvent.click(screen.getByRole('button', { name: COPY.agent.commandCopy }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    });

    it.each(['not_running', 'update_needed'] as const)('%s prioritizes the complete agent brief and keeps command copying independent', async (status) => {
      if (status === 'update_needed') {
        panel(connectionFor({ status }));
        expect(screen.getByText('update your checkouts')).toBeInTheDocument();
        expect(screen.queryByRole('code')).not.toBeInTheDocument();
        return;
      }
      const writeText = vi.fn(async (_text: string) => undefined);
      stubClipboard(writeText);
      panel(connectionFor({ status }));
      const primary = screen.getByRole('button', { name: 'Copy for your agent' });
      const commandCopy = screen.getByRole('button', { name: 'Copy command' });
      expect(screen.getAllByRole('button')[0]).toBe(primary);
      expect(commandCopy.parentElement).toContainElement(screen.getByRole('code'));
      fireEvent.click(primary);
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      const brief = writeText.mock.calls[0][0];
      expect(brief).toContain(window.location.origin);
      expect(brief).toContain('selected workspace and data root');
      expect(brief).toContain('The installer adopts an existing workspace itself');
      expect(brief).toContain('read the log path printed by the installer');
      expect(brief).toContain('Tell me to choose Allow if Chrome or Edge asks');
      expect(brief).toContain('docs/setup/SKILL.md');
      const command = installCommand(status === 'update_needed' ? 'update' : 'install');
      expect(brief).toContain(command);
      expect(brief).not.toBe(command);
      expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
      fireEvent.click(commandCopy);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(command));
      expect(screen.getByRole('button', { name: 'Command copied' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: COPY.agent.copied })).toBeInTheDocument();
    });

    it('keeps the full agent brief selectable when copying it fails', async () => {
      stubClipboard(vi.fn(async () => { throw new Error('Clipboard denied'); }));
      panel(connectionFor({ status: 'not_running' }));
      fireEvent.click(screen.getByRole('button', { name: 'Copy for your agent' }));
      const field = await screen.findByRole('textbox', { name: COPY.agent.copyFailed }) as HTMLTextAreaElement;
      expect(field.value).toContain('selected workspace and data root');
      expect(field.value).toContain('read the log path printed by the installer');
      expect(field.selectionEnd).toBe(field.value.length);
      expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    });

    it('shows the command in a selectable box if clipboard writing fails', async () => {
      stubClipboard(vi.fn(async () => { throw new Error('Clipboard denied'); }));
      panel(connectionFor({ status: 'not_running' }));
      fireEvent.click(screen.getByRole('button', { name: COPY.agent.commandCopy }));
      expect(await screen.findByText(COPY.agent.copyFailed)).toHaveAttribute('role', 'status');
      const field = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(field.value).toBe(installCommand('install'));
      expect(field.selectionEnd).toBe(field.value.length);
    });
  });

  describe('on the way out (Astrid answered after this screen asked)', () => {
    afterEach(() => document.querySelectorAll('[data-boot-hold]').forEach((node) => node.remove()));

    it('turns the waiting line into "Connected to Astrid" in place, keeps the card, and leaves once the editor beneath has settled', async () => {
      vi.useFakeTimers();
      const left = vi.fn();
      // The editor mounting beneath holds the boot while its workspace and timeline answer (bootLayer.ts).
      const hold = document.createElement('span');
      hold.setAttribute('data-boot-hold', '');
      document.body.append(hold);
      render(<RuntimeConnectionPanel connection={connectionFor({ status: 'not_running' })} exit={{ left }} />);
      const section = screen.getByTestId('runtime-not-connected');
      const card = section.querySelector(CARD) as HTMLElement;

      expect(within(card.lastElementChild as HTMLElement).getByRole('status')).toHaveTextContent(COPY.connected.sentence);
      expect(screen.queryByText(COPY.waiting)).not.toBeInTheDocument();
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(card.textContent).toBe(COPY.connected.sentence);

      act(() => { vi.advanceTimersByTime(CONNECTED_MIN_MS + LEAVE_MS); });
      expect(section).not.toHaveAttribute('data-leaving');
      expect(left).not.toHaveBeenCalled();

      await act(async () => { hold.remove(); await Promise.resolve(); });
      // A hold that comes back within the quiet moment (the editor handing over to its timeline) starts the wait again.
      act(() => { vi.advanceTimersByTime(SETTLED_QUIET_MS - 1); });
      await act(async () => { document.body.append(hold); await Promise.resolve(); });
      act(() => { vi.advanceTimersByTime(SETTLED_QUIET_MS); });
      expect(section).not.toHaveAttribute('data-leaving');
      await act(async () => { hold.remove(); await Promise.resolve(); });
      act(() => { vi.advanceTimersByTime(SETTLED_QUIET_MS); });
      expect(section).toHaveAttribute('data-leaving');
      expect(left).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(LEAVE_MS); });
      expect(left).toHaveBeenCalledOnce();
    });

    it.each(ALL_SCREENS)('%s: shows only the connected line during the exit hold', (_name, connection) => {
      vi.useFakeTimers();
      render(<RuntimeConnectionPanel connection={connection()} exit={{ left: vi.fn() }} onBack={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent(COPY.connected.sentence);
      expect(screen.queryByRole('heading')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('shows "Connected" for its moment even when the editor is already there', () => {
      vi.useFakeTimers();
      const left = vi.fn();
      render(<RuntimeConnectionPanel connection={connectionFor({ status: 'not_running' })} exit={{ left }} />);
      const section = screen.getByTestId('runtime-not-connected');
      act(() => { vi.advanceTimersByTime(CONNECTED_MIN_MS + SETTLED_QUIET_MS - 1); });
      expect(section).not.toHaveAttribute('data-leaving');
      act(() => { vi.advanceTimersByTime(1); });
      expect(section).toHaveAttribute('data-leaving');
      act(() => { vi.advanceTimersByTime(LEAVE_MS); });
      expect(left).toHaveBeenCalledOnce();
    });

    it('from the connecting screen, which asked nothing: no "Connected" moment, the mark stays until the editor has settled', async () => {
      vi.useFakeTimers();
      const left = vi.fn();
      const hold = document.createElement('span');
      hold.setAttribute('data-boot-hold', '');
      document.body.append(hold);
      render(<RuntimeConnectionPanel connection={connectionFor({ status: 'connecting' }, { isBooting: true })} exit={{ left }} />);
      const section = screen.getByTestId('runtime-not-connected');
      expect(section).toHaveAttribute('data-state', 'connecting');
      expect(screen.queryByText(COPY.connected.sentence)).not.toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(CONNECTED_MIN_MS); });
      expect(section).not.toHaveAttribute('data-leaving');

      await act(async () => { hold.remove(); await Promise.resolve(); });
      act(() => { vi.advanceTimersByTime(SETTLED_QUIET_MS); });
      expect(section).toHaveAttribute('data-leaving');
      act(() => { vi.advanceTimersByTime(LEAVE_MS); });
      expect(left).toHaveBeenCalledOnce();
    });
  });
});
