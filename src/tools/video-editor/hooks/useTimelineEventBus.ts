import type { CommitHistoryOptions, ScheduleSaveFn } from '@/tools/video-editor/hooks/useTimelineCommit.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';

type TimelineEventMap = {
  /** Exact upstream local basis and result, before save debounce/coalescing. */
  localCommit: (before: TimelineData | null, after: TimelineData) => void;
  beforeCommit: (currentData: TimelineData, options: CommitHistoryOptions) => void;
  /**
   * Server-authoritative data is about to replace local state (accepted poll,
   * conflict reload, registry refresh). History listens to invalidate undo
   * entries whose snapshots predate the remote boundary — restoring them would
   * silently revert the other client's persisted work.
   */
  remoteCommit: (currentData: TimelineData, nextData: TimelineData) => void;
  pruneSelection: (validIds: Set<string>) => void;
  scheduleSave: ScheduleSaveFn;
  saveSuccess: () => void;
  /**
   * A user edit was dropped because the timeline data is not loaded (the
   * applyEdit/moveClipToRow null-data early returns). The write-ack watchdog
   * listens so "edits while data is null" is visible instead of silent.
   */
  lostEdit: () => void;
};

type TimelineEventName = keyof TimelineEventMap;

export class TimelineEventBus {
  private listeners = new Map<TimelineEventName, Set<(...args: unknown[]) => void>>();

  on<K extends TimelineEventName>(eventName: K, listener: TimelineEventMap[K]) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener as (...args: unknown[]) => void);
    this.listeners.set(eventName, listeners);

    return () => {
      this.off(eventName, listener);
    };
  }

  off<K extends TimelineEventName>(eventName: K, listener: TimelineEventMap[K]) {
    const listeners = this.listeners.get(eventName);
    if (!listeners) {
      return;
    }

    listeners.delete(listener as (...args: unknown[]) => void);
    if (listeners.size === 0) {
      this.listeners.delete(eventName);
    }
  }

  emit<K extends TimelineEventName>(eventName: K, ...args: Parameters<TimelineEventMap[K]>) {
    const listeners = this.listeners.get(eventName);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      listener(...args);
    }
  }
}
