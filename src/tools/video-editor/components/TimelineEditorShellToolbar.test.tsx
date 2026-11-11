// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitEditorTour, startEditorTour } from '@/shared/state/editorTourStore.ts';
import { TimelineEditorShellToolbar } from './TimelineEditorShellToolbar.tsx';
import { createTimelineStore, TimelineStoreProvider } from '@/tools/video-editor/hooks/timelineStore.ts';

// '' is same-origin; a gateway origin is the hosted build.
let hostedOrigin = '';
vi.mock('@/integrations/runtime/connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/integrations/runtime/connection.ts')>()),
  runtimeOrigin: () => hostedOrigin,
}));

describe('TimelineEditorShellToolbar', () => {
  it('refreshes canonical history whenever its dropdown opens', async () => {
    const refreshCanonicalHistory = vi.fn(async () => {});
    const store = createTimelineStore();
    store.setState((state) => ({
      chrome: {
        ...state.chrome,
        canonicalHistorySupported: true,
        refreshCanonicalHistory,
      },
    }));

    render(
      <TimelineStoreProvider store={store}>
        <TimelineEditorShellToolbar
          touchChrome={false}
          condensed={false}
          onDividerPointerDown={() => {}}
          onDividerPointerMove={() => {}}
          onDividerPointerUp={() => {}}
          onDividerPointerCancel={() => {}}
          onDividerLostPointerCapture={() => {}}
          isTimelineMaximized={false}
          setIsTimelineMaximized={() => {}}
        />
      </TimelineStoreProvider>,
    );

    fireEvent.click(screen.getByTitle('History'));
    await waitFor(() => expect(refreshCanonicalHistory).toHaveBeenCalledTimes(1));
  });

  it('has no Elements button', () => {
    const store = createTimelineStore();
    render(
      <TimelineStoreProvider store={store}>
        <TimelineEditorShellToolbar
          touchChrome={false}
          condensed={false}
          onDividerPointerDown={() => {}}
          onDividerPointerMove={() => {}}
          onDividerPointerUp={() => {}}
          onDividerPointerCancel={() => {}}
          onDividerLostPointerCapture={() => {}}
          isTimelineMaximized={false}
          setIsTimelineMaximized={() => {}}
        />
      </TimelineStoreProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Elements' })).toBeNull();
    expect(screen.queryByTitle('Elements')).toBeNull();
    expect(screen.getByTitle('History')).toBeTruthy();
  });

  describe('the save badge', () => {
    const renderToolbar = (saveStatus: 'saved' | 'saving' | 'dirty' | 'retrying' | 'error', isConflictExhausted = false,
      recoveryDraft: { updatedAt: string; baseVersion: number; retryAllowed: boolean } | null = null) => {
      const store = createTimelineStore();
      store.setState((state) => ({ chrome: { ...state.chrome, saveStatus, isConflictExhausted, recoveryDraft } }));
      return render(
        <TimelineStoreProvider store={store}>
          <TimelineEditorShellToolbar
            touchChrome={false}
            condensed={false}
            onDividerPointerDown={() => {}}
            onDividerPointerMove={() => {}}
            onDividerPointerUp={() => {}}
            onDividerPointerCancel={() => {}}
            onDividerLostPointerCapture={() => {}}
            isTimelineMaximized={false}
            setIsTimelineMaximized={() => {}}
          />
        </TimelineStoreProvider>,
      );
    };

    it('reads Not saved, never Saved, while a refused change is still offered as a browser draft', () => {
      // After a refused save and a reload the editor shows the saved timeline,
      // but the refused change is only in this browser's recovery slot.
      renderToolbar('saved', false, { updatedAt: '2026-11-11T21:59:52.755Z', baseVersion: 0, retryAllowed: true });
      expect(screen.queryByText('saved')).toBeNull();
      const badge = screen.getByText('Not saved');
      expect(badge.className).toContain('text-muted-foreground');
    });

    it('reads Saved once no draft is offered and the timeline is saved', () => {
      renderToolbar('saved');
      expect(screen.queryByText('Not saved')).toBeNull();
      expect(screen.getByText('saved')).toBeTruthy();
    });

    it('reads Error in red when a save fails with no recovery card up', () => {
      renderToolbar('error');
      const badge = screen.getByText('error');
      expect(badge.className).toContain('bg-destructive');
    });

    it('reads Not saved, neutral and muted, while the Astrid stopped / restarted card is showing', () => {
      act(() => setRecoveryCardShowing(true));
      try {
        renderToolbar('error');
        expect(screen.queryByText('error')).toBeNull();
        const badge = screen.getByText('Not saved');
        expect(badge.className).not.toContain('bg-destructive');
        expect(badge.className).toContain('text-muted-foreground');
      } finally {
        act(() => setRecoveryCardShowing(false));
      }
    });

    it('reads Not saved, neutral and muted, while a save conflict is open: a choice, not an error', () => {
      renderToolbar('error', true);
      expect(screen.queryByText('error')).toBeNull();
      const badge = screen.getByText('Not saved');
      expect(badge.className).not.toContain('bg-destructive');
      expect(badge.className).toContain('text-muted-foreground');
    });

    describe('on the hosted build', () => {
      afterEach(() => { hostedOrigin = ''; });

      it('never reads a red Error for a save that failed during a stop, even once the card has cleared', () => {
        hostedOrigin = 'http://127.0.0.1:17340';
        renderToolbar('error');
        expect(screen.queryByText('error')).toBeNull();
        const badge = screen.getByText('Not saved');
        expect(badge.className).not.toContain('bg-destructive');
        expect(badge.className).toContain('text-muted-foreground');
      });

      it('keeps the other statuses as they are', () => {
        hostedOrigin = 'http://127.0.0.1:17340';
        for (const status of ['saving', 'dirty', 'retrying'] as const) {
          const view = renderToolbar(status);
          expect(screen.getByText(status)).toBeTruthy();
          expect(screen.queryByText('Not saved')).toBeNull();
          view.unmount();
        }
      });
    });

    it('is hidden while the editor tour runs, since the demo timeline saves nothing', () => {
      try {
        renderToolbar('dirty');
        expect(screen.getByText('dirty').className).not.toContain('invisible');

        act(() => startEditorTour());
        const badge = screen.getByText('dirty');
        expect(badge.className).toContain('invisible');
        expect(badge).toHaveAttribute('aria-hidden', 'true');

        act(() => exitEditorTour());
        expect(screen.getByText('dirty').className).not.toContain('invisible');
      } finally {
        act(() => exitEditorTour());
      }
    });

    it('still says saved when nothing is wrong, card or not', () => {
      act(() => setRecoveryCardShowing(true));
      try {
        renderToolbar('saved');
        expect(screen.getByText('saved')).toBeTruthy();
        expect(screen.queryByText('Not saved')).toBeNull();
      } finally {
        act(() => setRecoveryCardShowing(false));
      }
    });
  });
});
