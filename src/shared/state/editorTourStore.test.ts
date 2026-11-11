import { describe, expect, it } from 'vitest';
import {
  editorTourStage,
  exitEditorTour,
  getEditorTourState,
  markEditorTourReady,
  markEditorTourSent,
  setEditorTourBeat,
  showEditorTourBeat,
  startEditorTour,
} from './editorTourStore';

describe('editorTourStore', () => {
  it('lands each act on its land beat and keeps it', () => {
    expect(editorTourStage(1, 'welcome')).toBe(0);
    expect(editorTourStage(1, 'compose')).toBe(0);
    expect(editorTourStage(1, 'respond')).toBe(0);
    expect(editorTourStage(1, 'land')).toBe(1);
    expect(editorTourStage(2, 'compose')).toBe(1);
    expect(editorTourStage(2, 'land')).toBe(2);
    expect(editorTourStage(2, 'gallery')).toBe(2);
    expect(editorTourStage(3, 'respond')).toBe(2);
    expect(editorTourStage(3, 'land')).toBe(3);
    expect(editorTourStage(3, 'finale')).toBe(3);
    expect(editorTourStage(3, 'feedback')).toBe(3);
  });

  it('starts a fresh run and resets per-beat flags on every beat change', () => {
    const before = getEditorTourState().runId;
    startEditorTour();
    expect(getEditorTourState()).toMatchObject({ runId: before + 1, status: 'running', act: 1, beat: 'welcome' });

    markEditorTourSent();
    markEditorTourReady('chat');
    expect(getEditorTourState()).toMatchObject({ sent: true, ready: { chat: true, timeline: false, card: false } });

    setEditorTourBeat(1, 'respond');
    expect(getEditorTourState()).toMatchObject({ sent: false, ready: { chat: false, timeline: false, card: false } });

    exitEditorTour();
    expect(getEditorTourState().status).toBe('idle');
  });

  it('keeps the shown beat apart from the beat until the runner shows it, and resets it on start', () => {
    startEditorTour();
    expect(getEditorTourState()).toMatchObject({ beat: 'welcome', shownBeat: 'welcome' });
    setEditorTourBeat(1, 'compose');
    expect(getEditorTourState()).toMatchObject({ beat: 'compose', shownBeat: 'welcome' });
    showEditorTourBeat('compose');
    expect(getEditorTourState().shownBeat).toBe('compose');
    startEditorTour();
    expect(getEditorTourState().shownBeat).toBe('welcome');
  });
});
