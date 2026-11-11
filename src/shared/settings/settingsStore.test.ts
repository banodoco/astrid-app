import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAppStateApi, type FakeAppStateApi } from '@/test/settingsStoreHarness';
import { extensionSettingsGroup as getSettingsGroup } from '@/tools/video-editor/runtime/extensionSettingsBacking';
import { disabledBuiltInExtensions, editorPreferences, skyPreviewEnvironment, tasksPaneExpandedHalf, tasksPaneLocked, themeHour } from './declarations';
import { SettingsStore, type AppStateApi, type SettingRef } from './settingsStore';

const TIMELINE_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const PANES_SNAPSHOT = 'astrid.settings.snapshot.v1:ui.panes';
const LEGACY_TASKS_LOCKED = 'astrid.tasks-pane-locked.v1';

function numberRef(group: string, field: string): SettingRef<number> {
  return { group, field, default: 0, validate: (value) => typeof value === 'number' };
}

let fake: FakeAppStateApi;
let store: SettingsStore;

/** Lets queued microtasks and zero-delay timers run, then waits for any write they started. */
async function settle() {
  await store.flush();
  await vi.advanceTimersByTimeAsync(0);
  await store.flush();
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  fake = createFakeAppStateApi();
  store = new SettingsStore({ api: fake.api, storage: window.localStorage });
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('read', () => {
  it('loads a group once and serves many reads from the loaded record', async () => {
    fake.writeElsewhere('ui.panes', { 'tasks.locked': false, 'tasks.expandedHalf': 'split' });
    const ref = tasksPaneLocked.ref();

    store.get(ref);
    await store.flush();
    for (let i = 0; i < 5; i += 1) expect(store.get(ref)).toBe(false);

    expect(store.isLoaded('ui.panes')).toBe(true);
    expect(fake.calls.filter((call) => call.op === 'get' && call.key === 'ui.panes')).toHaveLength(1);
  });

  it('falls back to the default when the stored value has the wrong type', async () => {
    fake.writeElsewhere('ui.panes', { 'tasks.locked': 'yes' });
    const ref = tasksPaneLocked.ref();

    store.get(ref);
    await store.flush();

    expect(store.get(ref)).toBe(null);
  });

  it('returns the default for an absent field', async () => {
    const ref = tasksPaneLocked.ref();

    store.get(ref);
    await store.flush();

    expect(store.get(ref)).toBe(null);
    expect(store.get(editorPreferences.ref(TIMELINE_ID))).toEqual({});
  });
});

describe('first paint', () => {
  it('returns the localStorage snapshot value before the Runtime read resolves', async () => {
    localStorage.setItem(PANES_SNAPSHOT, JSON.stringify({ content: { 'tasks.locked': true }, pending: [], removed: [] }));
    fake.writeElsewhere('ui.panes', { 'tasks.locked': false });
    const ref = tasksPaneLocked.ref();

    expect(store.get(ref)).toBe(true);
    expect(store.isLoaded('ui.panes')).toBe(false);

    await store.flush();
    expect(store.get(ref)).toBe(false);
  });
});

describe('debounce', () => {
  it('does not write a ui.editor change before 300 ms, then writes every field in one PUT', async () => {
    fake.writeElsewhere('ui.editor', { keep: 'me' });
    const zoom = numberRef('ui.editor', 'zoom');
    const lane = numberRef('ui.editor', 'lane');
    store.get(zoom);
    await store.flush();

    store.set(zoom, 2);
    store.set(lane, 3);
    store.set(zoom, 4);
    await vi.advanceTimersByTimeAsync(299);
    expect(fake.puts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await store.flush();

    const puts = fake.puts();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      key: 'ui.editor',
      expectedVersion: 1,
      content: { keep: 'me', zoom: 4, lane: 3 },
    });
  });

  it('waits 1500 ms for a timeline group', async () => {
    const ref = editorPreferences.ref(TIMELINE_ID);
    store.set(ref, { zoom: 2 });

    await vi.advanceTimersByTimeAsync(1499);
    expect(fake.puts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await store.flush();
    expect(fake.puts()).toHaveLength(1);
    expect(fake.puts()[0]?.key).toBe(`ui.timeline.${TIMELINE_ID}`);
  });

  it('waits 500 ms for an extension group', async () => {
    const ref = numberRef(getSettingsGroup('demo'), 'count');
    store.set(ref, 1);

    await vi.advanceTimersByTimeAsync(499);
    expect(fake.puts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await store.flush();
    expect(fake.puts()).toHaveLength(1);
    expect(fake.puts()[0]?.key).toBe('ext.demo');
  });

  it('writes a ui.panes change on the next tick', async () => {
    store.set(tasksPaneLocked.ref(), true);
    expect(fake.puts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    await store.flush();
    expect(fake.puts()).toHaveLength(1);
    expect(fake.record('ui.panes').content).toEqual({ 'tasks.locked': true });
  });
});

describe('409 retry', () => {
  it('re-reads after a conflict and PUTs only our changed field on top of the other tab\'s fields', async () => {
    const ref = tasksPaneLocked.ref();
    store.get(ref);
    await store.flush();

    store.set(ref, true);
    fake.writeElsewhere('ui.panes', { other: 1, 'tasks.locked': false });
    await vi.advanceTimersByTimeAsync(0);
    await store.flush();

    const puts = fake.puts();
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ expectedVersion: 0 });
    expect(puts[1]).toMatchObject({ expectedVersion: 1, content: { other: 1, 'tasks.locked': true } });
    expect(fake.record('ui.panes')).toEqual({ version: 2, content: { other: 1, 'tasks.locked': true } });
    expect(store.get(ref)).toBe(true);
  });
});

describe('unreachable Runtime', () => {
  it('keeps reads and changes on this browser, then sends them once the Runtime is back', async () => {
    fake.setUnreachable(true);
    const ref = tasksPaneLocked.ref();

    expect(store.get(ref)).toBe(null);
    await expect(store.flush()).resolves.toBeUndefined();

    expect(() => store.set(ref, true)).not.toThrow();
    expect(store.get(ref)).toBe(true);
    expect(JSON.parse(localStorage.getItem(PANES_SNAPSHOT) ?? 'null')).toEqual({
      content: { 'tasks.locked': true },
      pending: ['tasks.locked'],
      removed: [],
    });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(fake.record('ui.panes').content).toBe(null);

    fake.setUnreachable(false);
    await store.refresh();

    expect(fake.record('ui.panes')).toEqual({ version: 1, content: { 'tasks.locked': true } });
    expect(store.get(ref)).toBe(true);
  });
});

describe('one-time import', () => {
  it('imports a legacy browser key into the Runtime and removes the key', async () => {
    localStorage.setItem(LEGACY_TASKS_LOCKED, 'true');
    const ref = tasksPaneLocked.ref();

    expect(store.get(ref)).toBe(true);
    await settle();

    expect(fake.record('ui.panes').content).toEqual({ 'tasks.locked': true });
    expect(localStorage.getItem(LEGACY_TASKS_LOCKED)).toBe(null);
    expect(store.get(ref)).toBe(true);
  });

  it('lets the Runtime win over a legacy key and still removes the key', async () => {
    localStorage.setItem(LEGACY_TASKS_LOCKED, 'true');
    fake.writeElsewhere('ui.panes', { 'tasks.locked': false });
    const ref = tasksPaneLocked.ref();

    expect(store.get(ref)).toBe(true);
    await settle();

    expect(store.get(ref)).toBe(false);
    expect(fake.record('ui.panes').content).toEqual({ 'tasks.locked': false });
    expect(fake.puts()).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_TASKS_LOCKED)).toBe(null);
  });

  it('keeps the legacy key while the Runtime is unreachable', async () => {
    localStorage.setItem(LEGACY_TASKS_LOCKED, 'true');
    fake.setUnreachable(true);
    const ref = tasksPaneLocked.ref();

    expect(store.get(ref)).toBe(true);
    await settle();

    expect(store.get(ref)).toBe(true);
    expect(localStorage.getItem(LEGACY_TASKS_LOCKED)).toBe('true');
  });

  it('never removes a mirror key, and rewrites it after a set', async () => {
    localStorage.setItem('theme-hour', '7');
    const ref = themeHour.ref();

    expect(store.get(ref)).toBe(7);
    await settle();

    expect(fake.record('ui.preferences').content).toEqual({ themeHour: 7 });
    expect(localStorage.getItem('theme-hour')).toBe('7');

    store.set(ref, 9);
    await store.flush();
    expect(localStorage.getItem('theme-hour')).toBe('9');
    expect(store.get(ref)).toBe(9);
  });
});

describe('before the Runtime connects', () => {
  it('makes no Runtime request until connect(), serves the snapshot meanwhile, and then loads and sends what waited', async () => {
    store.dispose();
    store = new SettingsStore({ api: fake.api, storage: window.localStorage, connected: false });
    localStorage.setItem(PANES_SNAPSHOT, JSON.stringify({ content: { 'tasks.locked': true }, pending: [], removed: [] }));
    fake.writeElsewhere('ui.panes', { 'tasks.locked': false, other: 1 });
    const ref = tasksPaneLocked.ref();

    expect(store.get(ref)).toBe(true);
    store.set(tasksPaneExpandedHalf.ref(), 'split');
    await vi.advanceTimersByTimeAsync(5000);
    await store.flush();
    await store.refresh();
    expect(fake.calls).toHaveLength(0);

    await store.connect();
    await settle();

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(store.get(ref)).toBe(false); // the Runtime's record wins over the old snapshot
    expect(fake.record('ui.panes').content).toEqual({ 'tasks.locked': false, 'tasks.expandedHalf': 'split', other: 1 });
  });
});

describe('a refused write', () => {
  it('keeps the change and the legacy key, stops retrying, and tries again on the next change', async () => {
    let refuse = true;
    const puts: number[] = [];
    const api: AppStateApi = {
      get: async () => ({ version: 0, content: null }),
      put: async (_key, content, version) => {
        puts.push(version);
        if (refuse) throw Object.assign(new Error('refused'), { status: 422 });
        return { version: version + 1, content };
      },
    };
    store.dispose();
    store = new SettingsStore({ api, storage: window.localStorage });
    localStorage.setItem('legacy.a', JSON.stringify('legacy-value'));
    const a: SettingRef<string> = { group: 'ui.panes', field: 'a', default: 'A', validate: (v) => typeof v === 'string', legacyKey: 'legacy.a' };

    store.get(a);
    await settle();
    store.set(a, 'user-choice');
    await settle();

    expect(store.get(a)).toBe('user-choice');
    expect(JSON.parse(localStorage.getItem(PANES_SNAPSHOT)!)).toMatchObject({ content: { a: 'user-choice' }, pending: ['a'] });
    const attempts = puts.length;

    await store.refresh();
    await settle();
    expect(puts).toHaveLength(attempts); // no retry loop
    expect(store.get(a)).toBe('user-choice');
    expect(localStorage.getItem('legacy.a')).not.toBeNull(); // the Runtime never confirmed it

    refuse = false;
    store.set(a, 'second-choice');
    await settle();
    expect(puts.length).toBeGreaterThan(attempts);
    expect(store.get(a)).toBe('second-choice');
    expect(localStorage.getItem('legacy.a')).toBeNull();
  });
});

describe('the snapshot as last-known Runtime state', () => {
  it('keeps the other snapshot fields readable and saved when one field changes before the Runtime answers', async () => {
    store.dispose();
    store = new SettingsStore({ api: fake.api, storage: window.localStorage, connected: false });
    localStorage.setItem(PANES_SNAPSHOT, JSON.stringify({ content: { a: 'A-saved', b: 'B-saved' }, pending: [], removed: [] }));
    const field = (name: string): SettingRef<string> => ({ group: 'ui.panes', field: name, default: `${name}-default`, validate: (v) => typeof v === 'string' });

    expect(store.get(field('a'))).toBe('A-saved');
    store.set(field('c'), 'C-new');

    expect(store.get(field('a'))).toBe('A-saved');
    expect(store.get(field('b'))).toBe('B-saved');
    expect(JSON.parse(localStorage.getItem(PANES_SNAPSHOT)!).content).toEqual({ a: 'A-saved', b: 'B-saved', c: 'C-new' });
  });
});

describe('refresh on focus', () => {
  it('re-reads another tab\'s write and notifies subscribers', async () => {
    const ref = tasksPaneLocked.ref();
    const listener = vi.fn();
    store.subscribe(ref, listener);
    await store.flush();
    listener.mockClear();

    fake.writeElsewhere('ui.panes', { 'tasks.locked': false });
    await store.refresh();

    expect(store.get(ref)).toBe(false);
    expect(listener).toHaveBeenCalled();
  });

  it('does not overwrite a pending local change', async () => {
    const ref = tasksPaneLocked.ref();
    store.get(ref);
    await store.flush();

    store.set(ref, true);
    fake.writeElsewhere('ui.panes', { 'tasks.locked': false, other: 2 });
    await store.refresh();

    expect(store.get(ref)).toBe(true);
    expect(fake.record('ui.panes')).toEqual({ version: 2, content: { 'tasks.locked': true, other: 2 } });
  });
});

describe('flush', () => {
  it('writes immediately without waiting for the debounce', async () => {
    store.set(editorPreferences.ref(TIMELINE_ID), { zoom: 3 });
    expect(fake.puts()).toHaveLength(0);

    await store.flush();

    expect(fake.puts()).toHaveLength(1);
    expect(fake.record(`ui.timeline.${TIMELINE_ID}`).content).toEqual({ 'timeline.preferences': { zoom: 3 } });
  });

  it('resolves only after a change made during an in-flight write has been sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holdNextPut = true;
    const api: AppStateApi = {
      get: fake.api.get,
      async put(key, content, expectedVersion) {
        if (holdNextPut) { holdNextPut = false; await gate; }
        return fake.api.put(key, content, expectedVersion);
      },
    };
    store.dispose();
    store = new SettingsStore({ api, storage: window.localStorage });
    const a = numberRef('ui.editor', 'a');
    const b = numberRef('ui.editor', 'b');

    store.set(a, 1);
    await vi.advanceTimersByTimeAsync(300);
    store.set(b, 2);

    const flushed = store.flush();
    release();
    await flushed;

    expect(fake.record('ui.editor').content).toEqual({ a: 1, b: 2 });
  });
});

describe('device scope', () => {
  it('reads and writes localStorage directly and never touches the Runtime', async () => {
    const ref = skyPreviewEnvironment.ref();
    expect(store.get(ref)).toBe(true);

    store.set(ref, false);
    expect(localStorage.getItem('theme-include-environment')).toBe('false');
    expect(store.get(ref)).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    await store.flush();
    expect(fake.calls).toHaveLength(0);

    const other = new SettingsStore({ api: fake.api, storage: window.localStorage });
    expect(other.get(ref)).toBe(false);
    other.dispose();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('oversize', () => {
  it('does not PUT a body over 16 KiB and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const blob: SettingRef<string> = { group: 'ui.big', field: 'blob', default: '', validate: (value) => typeof value === 'string' };
    store.set(blob, 'x'.repeat(17 * 1024));

    await vi.advanceTimersByTimeAsync(0);
    await store.flush();

    expect(fake.puts()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/ui\.big is over the 16384 byte limit/);
  });
});

describe('group names', () => {
  it('names a timeline group ui.timeline.<id>, within 64 characters', () => {
    const ref = editorPreferences.ref(TIMELINE_ID);

    expect(ref.group).toBe(`ui.timeline.${TIMELINE_ID}`);
    expect(ref.group).toHaveLength(48);
    expect(ref.group.length).toBeLessThanOrEqual(64);
  });

  it('names an extension group ext.<id> through getSettingsGroup', () => {
    expect(getSettingsGroup('demo')).toBe('ext.demo');
    expect(getSettingsGroup('Demo Ext!')).toBe('ext.demo-ext-');
    expect(getSettingsGroup('x'.repeat(100))).toHaveLength(64);
  });

  it('keeps the user declarations in their Runtime groups', () => {
    expect(disabledBuiltInExtensions.ref().group).toBe('ui.extensions');
    expect(tasksPaneLocked.ref().group).toBe('ui.panes');
  });
});

describe('a write cut off by a navigation', () => {
  it('keeps the change in the snapshot, and the next page sends it', async () => {
    const ref = numberRef('ui.panes', 'width');
    const cut: AppStateApi = {
      get: fake.api.get,
      // What the page's request registry does to a write still on the wire when the page goes.
      put: async () => { throw new DOMException('This page is navigating away', 'AbortError'); },
    };
    store.dispose();
    store = new SettingsStore({ api: cut, storage: window.localStorage });
    store.get(ref);
    await settle();
    store.set(ref, 640);
    await settle();
    expect(JSON.parse(localStorage.getItem(PANES_SNAPSHOT)!)).toMatchObject({ content: { width: 640 }, pending: ['width'] });
    store.dispose();

    // The reloaded page: a new store on the same browser storage.
    store = new SettingsStore({ api: fake.api, storage: window.localStorage });
    expect(store.get(ref), 'the change is shown before the Runtime answers').toBe(640);
    await settle();
    expect(fake.record('ui.panes').content).toEqual({ width: 640 });
    expect(JSON.parse(localStorage.getItem(PANES_SNAPSHOT)!)).toMatchObject({ pending: [] });
  });
});
