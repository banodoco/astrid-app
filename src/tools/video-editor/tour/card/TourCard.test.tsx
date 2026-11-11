import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TourCard } from './TourCard';
import { TOUR_CARD_ENTRANCE_MS } from './useTourCardEntrance';
import { TOUR_FINALE_ENTRANCE_MS } from './TourStrip';
import { COMPARE_REST, TOUR_COMPARE_ENTRANCE_MS } from './TourCompare';
import { EDITOR_TOUR_SCRIPT as SCRIPT } from '../tourScript';
import { EDITOR_TOUR_MEDIA } from '../tourMedia';
import { DISCORD_URL } from '@/pages/Home/publicAstridLinks';
import {
  exitEditorTour,
  getEditorTourState,
  setEditorTourBeat,
  skipEditorTourAnimation,
  startEditorTour,
  type EditorTourAct,
  type EditorTourBeat,
} from '@/shared/state/editorTourStore';

const play = vi.fn(() => Promise.resolve());
const cardReady = () => getEditorTourState().ready.card;

function renderAt(tourAct: EditorTourAct, beat: EditorTourBeat, options: { reducedMotion?: boolean; coarsePointer?: boolean; onSkip?: () => void } = {}) {
  const { reducedMotion = false, coarsePointer = false } = options;
  const onSkip = 'onSkip' in options ? options.onSkip : vi.fn();
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: query === '(pointer: coarse)' ? coarsePointer : reducedMotion, media: query } as MediaQueryList));
  startEditorTour();
  setEditorTourBeat(tourAct, beat);
  const onPrimary = vi.fn();
  const view = render(<TourCard act={tourAct} beat={beat} onPrimary={onPrimary} onSkip={onSkip} />);
  return { ...view, onPrimary, onSkip };
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const entranceOf = (tourAct: EditorTourAct) => (SCRIPT.acts[tourAct].card.visual === 'frame-to-still' ? TOUR_COMPARE_ENTRANCE_MS : TOUR_CARD_ENTRANCE_MS);
const FEEDBACK_TITLE = [SCRIPT.feedback.title.before, SCRIPT.feedback.title.emphasis, SCRIPT.feedback.title.after].join(' ');

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});

afterEach(() => {
  exitEditorTour();
  vi.useRealTimers();
  vi.restoreAllMocks();
  play.mockClear();
});

describe('TourCard', () => {
  it('opens with Astrid\'s welcome and reports ready once its entrance has played', () => {
    const { onPrimary, onSkip } = renderAt(1, 'welcome');
    expect(screen.getByRole('heading')).toHaveTextContent(SCRIPT.welcome.title);
    expect(screen.getByText(SCRIPT.welcome.body)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    advance(TOUR_CARD_ENTRANCE_MS - 1);
    expect(cardReady()).toBe(false);
    advance(1);
    expect(cardReady()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${SCRIPT.welcome.action}`) }));
    fireEvent.click(screen.getByRole('button', { name: /Skip tour/ }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('on compose shows a quiet hint and never reports ready', () => {
    renderAt(1, 'compose');
    expect(screen.getByText(SCRIPT.hints.compose)).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next/ })).toBeNull();
    advance(TOUR_CARD_ENTRANCE_MS * 2);
    expect(cardReady()).toBe(false);
  });

  it('on respond (act 1) offers the reply its Next, with the hint', () => {
    const { onPrimary } = renderAt(1, 'respond');
    expect(screen.getByText(SCRIPT.hints.respond)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    advance(TOUR_CARD_ENTRANCE_MS * 2);
    expect(cardReady()).toBe(false);
  });

  it.each([1, 2, 3] as const)('explains act %i on land and reports ready once its entrance has played', (tourAct) => {
    const { onPrimary, onSkip, container } = renderAt(tourAct, 'land');
    const { title, body, labels } = SCRIPT.acts[tourAct].card;
    expect(screen.getByRole('heading')).toHaveTextContent(title);
    expect(screen.queryByRole('heading', { name: new RegExp(`^${tourAct} · `) })).toBeNull();
    // The top row: the "N of 3" counter and Skip share it; Next stays in the bottom row.
    const topRow = screen.getByText(`${tourAct} of 3`).closest('.justify-between');
    expect(topRow).not.toBeNull();
    expect(topRow).toContainElement(screen.getByRole('button', { name: /Skip tour/ }));
    expect(topRow).not.toContainElement(screen.getByRole('button', { name: /Next/ }));
    expect(screen.queryByRole('button', { name: /Back/ })).toBeNull();
    expect(screen.getByText(body)).toBeInTheDocument();
    for (const label of labels) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    for (const step of SCRIPT.strip) expect(screen.getAllByText(step).length).toBeGreaterThan(0);
    // The strip fills act by act; at rest the video step shows where the flight ends, as a still.
    expect(container.querySelectorAll('ol img, ol video')).toHaveLength(tourAct);
    if (tourAct === 3) expect(container.querySelectorAll('ol img')[2]).toHaveAttribute('src', EDITOR_TOUR_MEDIA.stills[3].displayUrl);

    expect(container.querySelector('.editor-tour-card-playing')).not.toBeNull();
    advance(entranceOf(tourAct) - 1);
    expect(cardReady()).toBe(false);
    advance(1);
    expect(cardReady()).toBe(true);
    expect(container.querySelector('[data-settled]')).not.toBeNull();
    expect(container.querySelector('.editor-tour-card-playing')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /Skip tour/ }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  describe('step 2\'s two parts', () => {
    const dotsOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"] > span.rounded-full')];

    it('shows two dots after "2 of 3" on act 2\'s land: the first lit, the second quiet', () => {
      const { container } = renderAt(2, 'land');
      expect(screen.getByText('2 of 3')).toBeInTheDocument();
      expect(screen.getByText('part 1 of 2')).toHaveClass('opacity-0');
      const dots = dotsOf(container);
      expect(dots).toHaveLength(2);
      expect(dots[0]).toHaveClass('bg-foreground/70');
      expect(dots[1]).not.toHaveClass('bg-foreground/70');
    });

    it('shows no dots on the other acts\' lands', () => {
      for (const tourAct of [1, 3] as const) {
        const view = renderAt(tourAct, 'land');
        expect(dotsOf(view.container)).toHaveLength(0);
        expect(screen.queryByText(/part \d of 2/)).toBeNull();
        view.unmount();
        exitEditorTour();
      }
    });

    it('explains the gallery with title, body and Next last, no picture and no strip, and reports ready', () => {
      const { container, onPrimary, onSkip } = renderAt(2, 'gallery');
      const section = screen.getByRole('region', { name: 'Tour, step 2 of 3, part 2 of 2' });
      expect(section).toHaveClass('w-[380px]', 'p-5');
      expect(screen.getByText('2 of 3')).toBeInTheDocument();
      expect(screen.getByText('part 2 of 2')).toHaveClass('opacity-0');
      const dots = dotsOf(container);
      expect(dots).toHaveLength(2);
      expect(dots[0]).toHaveClass('bg-foreground/70');
      expect(dots[1]).toHaveClass('bg-foreground/70');
      expect(screen.getByRole('heading')).toHaveTextContent(SCRIPT.gallery.title);
      expect(screen.getByText(SCRIPT.gallery.body)).toBeInTheDocument();
      expect(container.querySelector('ol, img, video')).toBeNull();
      const order = [...section.querySelectorAll('h2, p, button')].map((node) => node.tagName + (node.textContent ?? '').slice(0, 12));
      expect(order.at(-1)).toMatch(/^BUTTONNext/);
      advance(TOUR_CARD_ENTRANCE_MS - 1);
      expect(cardReady()).toBe(false);
      advance(1);
      expect(cardReady()).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: /Next/ }));
      fireEvent.click(screen.getByRole('button', { name: /Skip tour/ }));
      expect(onPrimary).toHaveBeenCalledTimes(1);
      expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it('keeps Back at the foot on touch, beside Next', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: query === '(pointer: coarse)', media: query } as MediaQueryList));
      startEditorTour();
      setEditorTourBeat(2, 'gallery');
      const { container } = render(<TourCard act={2} beat="gallery" device="phone" onPrimary={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />);
      const back = screen.getByRole('button', { name: /Back/ });
      expect(back.parentElement).toBe(screen.getByRole('button', { name: /Next/ }).parentElement);
      expect(container.querySelector('ol')).toBeNull();
    });
  });

  it('says "And this is just one example" at the finale: title, then the whole lit chain, then the body, then Next', () => {
    const { onPrimary, container } = renderAt(3, 'finale');
    const heading = screen.getByRole('heading');
    expect(heading).toHaveTextContent('And this is just one example');
    expect(container.querySelector('section')).toHaveAttribute('aria-label', SCRIPT.finale.title);
    const body = screen.getByText(SCRIPT.finale.body);
    const chain = container.querySelector('ol')!;
    expect(heading.compareDocumentPosition(chain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chain.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(SCRIPT.finale.action).toBe('Next');
    for (const recap of SCRIPT.finale.recap) expect(screen.getByText(recap)).toBeInTheDocument();
    expect(container.querySelectorAll('ol img, ol video')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /Skip tour/ })).toBeNull();
    advance(TOUR_FINALE_ENTRANCE_MS);
    expect(cardReady()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(SCRIPT.finale.action) }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  describe('the finale chain', () => {
    const litNodes = (root: Element) => root.querySelectorAll('[data-tour-lit="node"]');
    const litLines = (root: Element) => root.querySelectorAll('[data-tour-lit="line"]');
    const delayOf = (el: Element) => parseInt((el as HTMLElement).style.getPropertyValue('--tour-delay'), 10);

    it('lights node, line, node, line, node in order while the card plays, and ends lit', () => {
      const { container } = renderAt(3, 'finale');
      expect(litNodes(container)).toHaveLength(3);
      expect(litLines(container)).toHaveLength(2);
      // Lit in the accent: the nodes' borders and the lines.
      for (const el of litNodes(container)) expect(el).toHaveClass('border-primary');
      for (const el of litLines(container)) expect(el).toHaveClass('bg-primary');
      const [n1, n2, n3] = [...litNodes(container)];
      const [l1, l2] = [...litLines(container)];
      // Each step starts after the one before it, so the chain lights in reading order.
      const order = [n1, l1, n2, l2, n3].map(delayOf);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size).toBe(5);
      expect(n1).toHaveClass('editor-tour-light');
      expect(l1).toHaveClass('editor-tour-draw');
      expect(container.querySelector('.editor-tour-card-playing')).not.toBeNull();

      // The chain is still lighting when an ordinary card would have settled.
      advance(TOUR_CARD_ENTRANCE_MS);
      expect(cardReady()).toBe(false);
      expect(TOUR_FINALE_ENTRANCE_MS).toBeGreaterThan(delayOf(n3));
      advance(TOUR_FINALE_ENTRANCE_MS - TOUR_CARD_ENTRANCE_MS);
      expect(cardReady()).toBe(true);
      // At rest: no animation runs, and every node and line keeps its lit style.
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(litNodes(container)).toHaveLength(3);
      expect(litLines(container)).toHaveLength(2);
    });

    it('arrives already lit, without playing, when reached by Back (instant)', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
      startEditorTour();
      setEditorTourBeat(3, 'finale', true);
      expect(getEditorTourState().instant).toBe(true);
      const { container } = render(<TourCard act={3} beat="finale" onPrimary={vi.fn()} onBack={vi.fn()} />);
      expect(cardReady()).toBe(true);
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(litNodes(container)).toHaveLength(3);
      expect(litLines(container)).toHaveLength(2);
    });

    it('arrives already lit, without playing, under reduced motion', () => {
      const { container } = renderAt(3, 'finale', { reducedMotion: true });
      expect(cardReady()).toBe(true);
      expect(container.querySelector('.editor-tour-card-reduced')).not.toBeNull();
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(litNodes(container)).toHaveLength(3);
      expect(litLines(container)).toHaveLength(2);
    });

    it('settles lit at once on a skipAnimation bump', () => {
      const { container } = renderAt(3, 'finale');
      advance(200);
      act(() => skipEditorTourAnimation());
      expect(cardReady()).toBe(true);
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(litNodes(container)).toHaveLength(3);
    });

    it('leaves the act cards\' compact strip unlit', () => {
      const { container } = renderAt(3, 'land');
      expect(litNodes(container)).toHaveLength(0);
      expect(litLines(container)).toHaveLength(0);
    });
  });

  it.each([1, 2, 3] as const)('shows act %i its own compose header, above the Press Send line', (tourAct) => {
    renderAt(tourAct, 'compose');
    const header = screen.getByRole('heading', { name: SCRIPT.acts[tourAct].composeHeader });
    expect(header.compareDocumentPosition(screen.getByText(SCRIPT.hints.compose)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(`${tourAct} of 3`).compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.closest('section')).toHaveClass('w-[360px]');
  });

  it('gives every act a distinct compose header', () => {
    const headers = [1, 2, 3].map((tourAct) => SCRIPT.acts[tourAct as EditorTourAct].composeHeader);
    expect(new Set(headers).size).toBe(3);
    for (const tourAct of [1, 2, 3] as const) {
      const view = renderAt(tourAct, 'compose');
      expect(screen.getByRole('heading', { name: SCRIPT.acts[tourAct].composeHeader })).toBeInTheDocument();
      view.unmount();
      exitEditorTour();
    }
  });

  it('asks for feedback at the end, with a Discord link that opens in a new tab', () => {
    const { onPrimary, container } = renderAt(3, 'feedback');
    expect(screen.getByRole('heading')).toHaveTextContent('We really need your feedback');
    expect(container.querySelector('section')).toHaveAttribute('aria-label', FEEDBACK_TITLE);
    expect(screen.getByText(SCRIPT.feedback.body)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: SCRIPT.feedback.discord });
    expect(link).toHaveAttribute('href', DISCORD_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button', { name: /Skip tour/ })).toBeNull();
    advance(TOUR_CARD_ENTRANCE_MS);
    expect(cardReady()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${SCRIPT.feedback.action}`) }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  describe('the feedback title\'s underline', () => {
    const emphasis = (root: Element) => root.querySelector('[data-tour-emphasis]') as HTMLElement;
    const stroke = (root: Element) => emphasis(root).querySelector('path.editor-tour-underline') as SVGPathElement;

    it('underlines the script\'s emphasised word, drawn in once the card has arrived and then kept', () => {
      const { container } = renderAt(3, 'feedback');
      expect(emphasis(container)).toHaveTextContent(new RegExp(`^${SCRIPT.feedback.title.emphasis}$`));
      expect(emphasis(container)).toHaveClass('whitespace-nowrap');
      // Drawn as a dash of the whole path: hidden by the playing entrance's offset, whole at rest.
      expect(stroke(container)).toHaveAttribute('pathLength', '1');
      expect(stroke(container)).toHaveAttribute('stroke-dasharray', '1');
      expect(parseInt(stroke(container).style.getPropertyValue('--tour-delay'), 10)).toBeGreaterThan(0);
      // The stroke hangs out of flow, never part of the title's line box.
      expect(stroke(container).closest('svg')).toHaveClass('absolute', 'pointer-events-none');
      expect(stroke(container).closest('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(container.querySelector('.editor-tour-card-playing')).not.toBeNull();
      advance(TOUR_CARD_ENTRANCE_MS);
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(stroke(container)).toBeInTheDocument();
    });

    it('is already drawn under reduced motion and when reached by Back', () => {
      const { container, unmount } = renderAt(3, 'feedback', { reducedMotion: true });
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(stroke(container)).toBeInTheDocument();
      unmount();
      exitEditorTour();
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
      startEditorTour();
      setEditorTourBeat(3, 'feedback', true);
      const view = render(<TourCard act={3} beat="feedback" onPrimary={vi.fn()} onBack={vi.fn()} />);
      expect(view.container.querySelector('.editor-tour-card-playing')).toBeNull();
      expect(stroke(view.container)).toBeInTheDocument();
    });
  });

  describe('act 2\'s comparison', () => {
    it('is a slider, frame left and still right, that sweeps in from the left while the card plays', () => {
      const { container } = renderAt(2, 'land');
      const [source, model] = SCRIPT.acts[2].card.labels;
      const slider = screen.getByRole('slider', { name: `Compare the ${source.toLowerCase()} (left) with ${model} (right)` });
      const still = container.querySelector('[data-tour-compare-still]') as HTMLElement;
      expect(slider).toHaveAttribute('aria-valuenow', '0');
      expect(slider.closest('[aria-hidden="true"]')).toBeNull();
      // It arrives as the frame alone: the still has yet to wipe in.
      expect(still.style.maskImage).toContain('transparent 0%');
      advance(TOUR_COMPARE_ENTRANCE_MS);
      expect(slider).toHaveAttribute('aria-valuenow', String(COMPARE_REST));
      expect(slider).toHaveAttribute('aria-valuetext', `${source} ${COMPARE_REST}%, ${model} ${100 - COMPARE_REST}%`);
      expect(still.style.maskImage).toBe('');
      expect(still.style.clipPath).toBe(`inset(0 0 0 ${COMPARE_REST}%)`);
    });

    it('rests at once under reduced motion, and still moves', () => {
      const { container } = renderAt(2, 'land', { reducedMotion: true });
      const slider = screen.getByRole('slider', { name: /Compare/ });
      expect(slider).toHaveAttribute('aria-valuenow', String(COMPARE_REST));
      fireEvent.keyDown(slider, { key: 'Home' });
      expect(slider).toHaveAttribute('aria-valuenow', '0');
      expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
    });

    it('rests at once when reached by Back', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
      startEditorTour();
      setEditorTourBeat(2, 'land', true);
      render(<TourCard act={2} beat="land" onPrimary={vi.fn()} onBack={vi.fn()} />);
      expect(screen.getByRole('slider', { name: /Compare/ })).toHaveAttribute('aria-valuenow', String(COMPARE_REST));
      expect(cardReady()).toBe(true);
    });
  });

  it('settles at once on a skipAnimation bump', () => {
    const { container } = renderAt(2, 'land');
    advance(200);
    expect(cardReady()).toBe(false);
    act(() => skipEditorTourAnimation());
    expect(cardReady()).toBe(true);
    expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
  });

  it('replays the entrance for the next beat after a skip', () => {
    const view = renderAt(1, 'land');
    act(() => skipEditorTourAnimation());
    expect(cardReady()).toBe(true);
    act(() => setEditorTourBeat(2, 'land'));
    expect(cardReady()).toBe(false);
    advance(TOUR_CARD_ENTRANCE_MS);
    expect(cardReady()).toBe(false); // still showing act 1: the runner has not moved the card on yet
    view.rerender(<TourCard act={2} beat="land" onPrimary={view.onPrimary} onSkip={view.onSkip} />);
    advance(TOUR_COMPARE_ENTRANCE_MS);
    expect(cardReady()).toBe(true);
  });

  it('with reduced motion is ready at once, only fades in, and keeps videos still', () => {
    const { container } = renderAt(3, 'land', { reducedMotion: true });
    expect(cardReady()).toBe(true);
    expect(container.querySelector('.editor-tour-card-reduced')).not.toBeNull();
    expect(container.querySelector('.editor-tour-card-playing')).toBeNull();
    expect(container.querySelector('.editor-tour-playhead')).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it('plays the act-3 video with motion on', () => {
    renderAt(3, 'land');
    expect(play).toHaveBeenCalled();
  });

  it('plays the act-3 video when the card is reached by Back (instant)', () => {
    startEditorTour();
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
    setEditorTourBeat(3, 'land', true);
    expect(getEditorTourState().instant).toBe(true);
    render(<TourCard act={3} beat="land" onPrimary={vi.fn()} onSkip={vi.fn()} />);
    expect(play).toHaveBeenCalled();
    expect(cardReady()).toBe(true);
  });

  it('names Esc without a skip handler', () => {
    renderAt(1, 'land', { onSkip: undefined });
    expect(screen.queryByRole('button', { name: /Skip tour/ })).toBeNull();
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });

  it('hides keyboard hints on phones', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    renderAt(1, 'compose');
    expect(screen.queryByText('Esc')).not.toBeInTheDocument();
    expect(screen.queryByText('↵')).not.toBeInTheDocument();
  });

  it('hides keyboard hints on coarse pointer devices', () => {
    renderAt(1, 'compose', { coarsePointer: true });
    expect(screen.queryByText('Esc')).not.toBeInTheDocument();
    expect(screen.queryByText('↵')).not.toBeInTheDocument();
  });

  it('on a phone leaves the picture to the spotlit preview, sizes controls for a finger and ends the tour toward a computer', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
    startEditorTour();
    setEditorTourBeat(1, 'land');
    const { container, rerender } = render(<TourCard act={1} beat="land" device="phone" onPrimary={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />);
    expect(container.querySelector('[aria-hidden="true"].h-32')).toBeNull();
    expect(screen.getByRole('button', { name: SCRIPT.controls.next })).toHaveClass('h-11');
    expect(screen.getByRole('button', { name: /Skip tour/ })).toHaveClass('min-h-11');
    setEditorTourBeat(3, 'feedback');
    rerender(<TourCard act={3} beat="feedback" device="phone" onPrimary={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByRole('button', { name: SCRIPT.feedback.mobileAction })).toBeInTheDocument();
  });

  it('a card still showing the previous beat never reports ready for the new one', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
    startEditorTour();
    setEditorTourBeat(1, 'compose'); // the store has moved on; the runner still shows the welcome
    const { container } = render(<TourCard act={1} beat="welcome" onPrimary={vi.fn()} onSkip={vi.fn()} />);
    advance(TOUR_CARD_ENTRANCE_MS * 2);
    expect(container.querySelector('[data-editor-tour-card]')).toHaveAttribute('data-settled');
    expect(cardReady()).toBe(false);
  });

  describe('Back', () => {
    function renderWithBack(tourAct: EditorTourAct, beat: EditorTourBeat) {
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
      startEditorTour();
      setEditorTourBeat(tourAct, beat);
      const onBack = vi.fn();
      const view = render(<TourCard act={tourAct} beat={beat} onPrimary={vi.fn()} onBack={onBack} onSkip={vi.fn()} />);
      return { ...view, onBack };
    }

    it.each(['compose', 'respond', 'land', 'gallery'] as const)('sits right of the counter on the %s top row, with Skip after it', (beat) => {
      const { onBack } = renderWithBack(2, beat);
      const counter = screen.getByText('2 of 3');
      const back = screen.getByRole('button', { name: /Back/ });
      const skip = screen.getByRole('button', { name: /Skip tour/ });
      // Act 2's cards put their part dots between the counter and Back.
      expect(back.parentElement).toBe(counter.parentElement);
      expect(counter.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(counter.closest('.justify-between')).toContainElement(skip);
      expect(back.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(back);
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('is bottom-left on the finale, opposite the primary action', () => {
      const { onBack } = renderWithBack(3, 'finale');
      const back = screen.getByRole('button', { name: /Back/ });
      const primary = screen.getByRole('button', { name: new RegExp(`^${SCRIPT.finale.action}`) });
      expect(back.parentElement).toBe(primary.parentElement);
      expect(back.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(back);
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('is bottom-left on the feedback card, opposite Start creating', () => {
      const { onBack } = renderWithBack(3, 'feedback');
      const back = screen.getByRole('button', { name: /Back/ });
      const primary = screen.getByRole('button', { name: new RegExp(`^${SCRIPT.feedback.action}`) });
      expect(back.parentElement).toBe(primary.parentElement);
      fireEvent.click(back);
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('is absent on the welcome', () => {
      renderWithBack(1, 'welcome');
      expect(screen.queryByRole('button', { name: /Back/ })).toBeNull();
    });

    it('arrives settled and ready at once when the beat was reached by Back', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
      startEditorTour();
      setEditorTourBeat(3, 'land', true);
      const { container } = render(<TourCard act={3} beat="land" onPrimary={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />);
      expect(cardReady()).toBe(true);
      expect(container.querySelector('[data-editor-tour-card]')).toHaveAttribute('data-settled');
    });
  });
});

describe('TourCard arriving with the runner’s move', () => {
  function renderTravelling(tourAct: EditorTourAct, beat: EditorTourBeat, props: { arrived: boolean; working?: boolean }) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: false, media: query } as MediaQueryList));
    startEditorTour();
    setEditorTourBeat(tourAct, beat);
    const onPrimary = vi.fn();
    const view = render(<TourCard act={tourAct} beat={beat} onPrimary={onPrimary} rise={false} {...props} />);
    return { ...view, onPrimary, rerenderWith: (next: { arrived: boolean; working?: boolean }) => view.rerender(<TourCard act={tourAct} beat={beat} onPrimary={onPrimary} rise={false} {...next} />) };
  }

  it('holds its entrance at the start while it travels, and plays it (and only then reports ready) once it has arrived', () => {
    const { container, rerenderWith } = renderTravelling(1, 'land', { arrived: false });
    const card = container.querySelector('[data-editor-tour-card]')!;
    expect(card).toHaveClass('editor-tour-card-playing', 'editor-tour-card-waiting');
    expect(card).not.toHaveAttribute('data-arrived');
    // The card's box is the runner's to bring in: no rise of its own.
    expect(container.querySelector('section')).not.toHaveClass('editor-tour-rise');
    advance(TOUR_CARD_ENTRANCE_MS * 2);
    expect(cardReady()).toBe(false);
    rerenderWith({ arrived: true });
    expect(card).toHaveClass('editor-tour-card-playing');
    expect(card).not.toHaveClass('editor-tour-card-waiting');
    advance(TOUR_CARD_ENTRANCE_MS);
    expect(cardReady()).toBe(true);
  });

  it('starts act 2’s comparison sweep only once the card has arrived', () => {
    const { rerenderWith } = renderTravelling(2, 'land', { arrived: false });
    const handle = () => screen.getByRole('slider');
    advance(TOUR_COMPARE_ENTRANCE_MS);
    expect(Number(handle().getAttribute('aria-valuenow'))).toBe(0);
    rerenderWith({ arrived: true });
    for (let elapsed = 0; elapsed < TOUR_COMPARE_ENTRANCE_MS + 100; elapsed += 16) advance(16);
    expect(Number(handle().getAttribute('aria-valuenow'))).toBe(COMPARE_REST);
  });

  it('on respond, while the reply comes in, keeps the user company with a quiet line and no Next yet', () => {
    const { container, rerenderWith } = renderTravelling(1, 'respond', { arrived: true, working: true });
    expect(screen.getByText(SCRIPT.hints.respondWorking)).toHaveClass('text-muted-foreground');
    expect(screen.queryByRole('button', { name: /Next/ })).toBeNull();
    expect(screen.queryByText(SCRIPT.hints.respond)).toBeNull();
    expect(container.querySelector('[data-editor-tour-card]')).toHaveAttribute('data-editor-tour-card-phase', 'working');
    rerenderWith({ arrived: true });
    expect(screen.getByText(SCRIPT.hints.respond)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeInTheDocument();
    expect(container.querySelector('[data-editor-tour-card]')).not.toHaveAttribute('data-editor-tour-card-phase');
  });
});

describe('TourCard on touch', () => {
  function renderTouch(tourAct: EditorTourAct, beat: EditorTourBeat, device: 'phone' | 'tablet') {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: query === '(pointer: coarse)', media: query } as MediaQueryList));
    startEditorTour();
    setEditorTourBeat(tourAct, beat);
    return render(<TourCard act={tourAct} beat={beat} device={device} onPrimary={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />);
  }

  it.each(['phone', 'tablet'] as const)('has no Send of its own on a %s compose card: the chat’s Send is the one way to send', (device) => {
    renderTouch(2, 'compose', device);
    expect(screen.getByText(SCRIPT.hints.composeTouch)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(`^${SCRIPT.controls.send}`) })).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([SCRIPT.controls.skip, SCRIPT.controls.back]);
  });

  it('keeps a phone’s land explainer compact, to sit above the preview: the title, Back and Next, no body', () => {
    renderTouch(1, 'land', 'phone');
    expect(screen.getByRole('heading')).toHaveTextContent(SCRIPT.acts[1].card.title);
    expect(screen.queryByText(SCRIPT.acts[1].card.body)).toBeNull();
    expect(screen.getByRole('button', { name: /Next/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back/ })).toBeInTheDocument();
  });

  it('keeps the body on a tablet’s land explainer', () => {
    renderTouch(1, 'land', 'tablet');
    expect(screen.getByText(SCRIPT.acts[1].card.body)).toBeInTheDocument();
  });
});
