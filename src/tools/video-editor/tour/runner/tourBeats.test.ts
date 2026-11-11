import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  editorTourStage,
  exitEditorTour,
  getEditorTourState,
  markEditorTourReady,
  setEditorTourBeat,
  startEditorTour,
} from '@/shared/state/editorTourStore';
import { backEditorTour, finishEditorTour, returnToEditorTourEnd, runEditorTourPrimary, watchEditorTourSend } from './tourBeats';

let stopWatching: (() => void) | undefined;

beforeEach(() => {
  exitEditorTour();
  localStorage.clear();
  stopWatching = watchEditorTourSend();
  startEditorTour();
  passWelcome();
});

afterEach(() => {
  stopWatching?.();
  stopWatching = undefined;
  exitEditorTour();
  localStorage.clear();
});

/** The welcome card has played its entrance and the user pressed OK. */
function passWelcome() {
  markEditorTourReady('card');
  runEditorTourPrimary();
}

/** Presents the current beat as the parts would: the chat sets its flag, the timeline and card set theirs. */
function readyChat() {
  markEditorTourReady('chat');
}
function readyLand() {
  markEditorTourReady('timeline');
  markEditorTourReady('card');
}

describe('tour beat machine', () => {
  it('opens on the welcome, which waits for its card and then goes to act 1 compose', () => {
    startEditorTour();
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'welcome' });

    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ beat: 'welcome', skipAnimation: 1 });

    markEditorTourReady('card');
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'compose', sent: false });
  });

  it('waits for the chat to be ready before Send is accepted in compose', () => {
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'compose', sent: false });

    runEditorTourPrimary();

    expect(getEditorTourState()).toMatchObject({ beat: 'compose', sent: false, skipAnimation: 1 });
  });

  it('sends on primary once the chat is ready, and the watcher moves compose on to respond', () => {
    readyChat();
    runEditorTourPrimary();

    // Send reset by the respond beat change; the watcher did the move.
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'respond', sent: false, ready: { chat: false } });
  });

  it('keeps respond until the chat is ready, then lands on primary', () => {
    readyChat();
    runEditorTourPrimary();
    expect(getEditorTourState().beat).toBe('respond');

    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ beat: 'respond', skipAnimation: 1 });

    readyChat();
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'land' });
  });

  it('requires both timeline and card before land advances', () => {
    readyChat();
    runEditorTourPrimary();
    readyChat();
    runEditorTourPrimary();
    expect(getEditorTourState().beat).toBe('land');

    markEditorTourReady('timeline');
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'land' });

    markEditorTourReady('card');
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act: 2, beat: 'compose', sent: false });
  });

  it('plays the whole three-act journey and ends on the feedback primary', () => {
    const stages: number[] = [];
    for (const act of [1, 2, 3] as const) {
      // compose: send; act 1 then stops on respond for its Next, acts 2 and 3 go straight to land
      expect(getEditorTourState()).toMatchObject({ act, beat: 'compose' });
      readyChat();
      runEditorTourPrimary();
      if (act === 1) {
        expect(getEditorTourState()).toMatchObject({ act, beat: 'respond' });
        readyChat();
        runEditorTourPrimary();
      }
      expect(getEditorTourState()).toMatchObject({ act, beat: 'land' });
      readyLand();
      stages.push(editorTourStage(act, 'land'));
      runEditorTourPrimary();
      if (act === 2) {
        // Act 2's land is followed by the gallery beat, which keeps act 2's timeline.
        expect(getEditorTourState()).toMatchObject({ act: 2, beat: 'gallery', instant: false });
        runEditorTourPrimary(); // not ready yet: finishes the animation first
        expect(getEditorTourState()).toMatchObject({ beat: 'gallery', skipAnimation: expect.any(Number) });
        readyLand();
        stages.push(editorTourStage(act, 'gallery'));
        runEditorTourPrimary();
      }
    }

    // After act 3 lands, the next primary goes to finale, not a fourth compose.
    expect(getEditorTourState()).toMatchObject({ act: 3, beat: 'finale' });
    expect(stages).toEqual([1, 2, 2, 3]);

    // finale waits on card readiness
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ beat: 'finale', status: 'running' });

    markEditorTourReady('card');
    runEditorTourPrimary(); // Next
    expect(getEditorTourState()).toMatchObject({ act: 3, beat: 'feedback', status: 'running' });
    markEditorTourReady('card');
    runEditorTourPrimary(); // Start creating
    expect(getEditorTourState()).toMatchObject({ status: 'idle' });
  });

  it('the feedback card waits on card readiness', () => {
    setEditorTourBeat(3, 'feedback');
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ beat: 'feedback', status: 'running' });
  });

  it('Esc finishes the tour from every beat', () => {
    const beats = [
      [1, 'welcome'],
      [1, 'compose'],
      [1, 'respond'],
      [2, 'land'],
      [2, 'gallery'],
      [3, 'finale'],
      [3, 'feedback'],
    ] as const;
    for (const [act, beat] of beats) {
      startEditorTour();
      setEditorTourBeat(act, beat);
      finishEditorTour();
      expect(getEditorTourState().status).toBe('idle');
    }
  });

  it('exit focuses the real composer, never the tour\'s read-only one', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    document.body.innerHTML = '<textarea id="tour" data-editor-tour="chat-composer" readonly></textarea>';

    finishEditorTour();
    // The tour's composer unmounts and the real one mounts a frame or two later.
    setTimeout(() => {
      document.body.innerHTML = '<div data-editor-tour="chat-composer"><textarea id="real"></textarea></div>';
    }, 5);

    await vi.waitFor(() => expect(document.activeElement?.id).toBe('real'));
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('finishing while idle is a no-op', () => {
    exitEditorTour();
    const before = getEditorTourState();

    finishEditorTour();
    runEditorTourPrimary();

    expect(getEditorTourState()).toBe(before);
  });

  it('replay starts a larger run at the welcome', () => {
    readyChat();
    runEditorTourPrimary();
    readyChat();
    runEditorTourPrimary();
    readyLand();
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act: 2, beat: 'compose' });
    const firstRun = getEditorTourState().runId;

    startEditorTour();

    expect(getEditorTourState()).toMatchObject({
      runId: firstRun + 1,
      status: 'running',
      act: 1,
      beat: 'welcome',
      sent: false,
      ready: { chat: false, timeline: false, card: false },
    });
  });
});

describe('tour Back', () => {
  const at = (act: 1 | 2 | 3, beat: Parameters<typeof setEditorTourBeat>[1]) => {
    setEditorTourBeat(act, beat);
  };

  it.each([
    [{ act: 1, beat: 'compose' }, { act: 1, beat: 'welcome' }],
    [{ act: 1, beat: 'respond' }, { act: 1, beat: 'compose' }],
    [{ act: 1, beat: 'land' }, { act: 1, beat: 'respond' }],
    [{ act: 2, beat: 'compose' }, { act: 1, beat: 'land' }],
    [{ act: 2, beat: 'land' }, { act: 2, beat: 'compose' }],
    [{ act: 2, beat: 'gallery' }, { act: 2, beat: 'land' }],
    [{ act: 3, beat: 'compose' }, { act: 2, beat: 'gallery' }],
    [{ act: 3, beat: 'land' }, { act: 3, beat: 'compose' }],
    [{ act: 3, beat: 'finale' }, { act: 3, beat: 'land' }],
    [{ act: 3, beat: 'feedback' }, { act: 3, beat: 'finale' }],
  ] as const)('from %o goes to %o, finished (instant) and unsent', (from, to) => {
    at(from.act, from.beat);
    backEditorTour();
    expect(getEditorTourState()).toMatchObject({ ...to, instant: true, sent: false, ready: { chat: false, timeline: false, card: false } });
  });

  it('has no Back on the welcome', () => {
    startEditorTour();
    backEditorTour();
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'welcome', instant: false });
  });

  it('does nothing once the tour has exited', () => {
    at(2, 'land');
    exitEditorTour();
    backEditorTour();
    expect(getEditorTourState()).toMatchObject({ status: 'idle', instant: false });
  });

  it('clears instant on any forward move', () => {
    at(1, 'respond');
    backEditorTour();
    expect(getEditorTourState()).toMatchObject({ beat: 'compose', instant: true });
    readyChat();
    runEditorTourPrimary(); // Send
    expect(getEditorTourState()).toMatchObject({ beat: 'respond', instant: false });
  });

  it('walks the whole journey back to the welcome through the places the user acted', () => {
    at(3, 'feedback');
    const visited: string[] = [];
    for (let i = 0; i < 20 && getEditorTourState().beat !== 'welcome'; i += 1) {
      backEditorTour();
      const { act, beat } = getEditorTourState();
      visited.push(`${act}:${beat}`);
    }
    expect(visited).toEqual(['3:finale', '3:land', '3:compose', '2:gallery', '2:land', '2:compose', '1:land', '1:respond', '1:compose', '1:welcome']);
  });
});

describe('tour Send', () => {
  it('on act 1 moves compose on to respond, where the reply has its Next', () => {
    setEditorTourBeat(1, 'compose');
    readyChat();
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'respond', instant: false });
  });

  it.each([2, 3] as const)('on act %i goes straight to land: no respond step', (act) => {
    setEditorTourBeat(act, 'compose');
    readyChat();
    runEditorTourPrimary();
    expect(getEditorTourState()).toMatchObject({ act, beat: 'land', instant: false });
  });
});

describe('returnToEditorTourEnd', () => {
  it('opens a running tour on its feedback card, settled, as Back from the screen after it', () => {
    returnToEditorTourEnd();
    expect(getEditorTourState()).toMatchObject({ act: 3, beat: 'feedback', instant: true });
  });

  describe('one press of Next', () => {
    it('leaves an explainer as soon as its card is there, while its entrance and the result are still playing', () => {
      readyChat();
      runEditorTourPrimary();
      readyChat();
      runEditorTourPrimary();
      expect(getEditorTourState()).toMatchObject({ act: 1, beat: 'land' });
      // The result's watch: no card yet. A press only ends the watch.
      const skips = getEditorTourState().skipAnimation;
      runEditorTourPrimary();
      expect(getEditorTourState()).toMatchObject({ beat: 'land', skipAnimation: skips + 1 });
      // The explainer has arrived; its entrance has not finished and the timeline has not reported.
      markEditorTourReady('arrived');
      runEditorTourPrimary();
      expect(getEditorTourState()).toMatchObject({ act: 2, beat: 'compose', skipAnimation: skips + 1 });
    });

    it('leaves the reply once its actions are appearing and its card is there, not while it is still streaming', () => {
      readyChat();
      runEditorTourPrimary();
      expect(getEditorTourState().beat).toBe('respond');
      const skips = getEditorTourState().skipAnimation;
      markEditorTourReady('arrived'); // desktop's working card is never counted; were it, the reply still has to finish
      runEditorTourPrimary();
      expect(getEditorTourState()).toMatchObject({ beat: 'respond', skipAnimation: skips + 1 });
      markEditorTourReady('actions');
      runEditorTourPrimary();
      expect(getEditorTourState().beat).toBe('land');
    });

    it('never sends an unfinished prompt', () => {
      markEditorTourReady('arrived');
      runEditorTourPrimary();
      expect(getEditorTourState()).toMatchObject({ beat: 'compose', sent: false });
    });
  });
});
