import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectElementComponent, ProjectElementEntry, ProjectElementList } from './admittedElementLoader';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const digestOf = (char: string) => char.repeat(64);
const Blocks: ProjectElementComponent = () => null;

let host: typeof import('./admitted-elements');
beforeEach(async () => {
  vi.resetModules();
  host = await import('./admitted-elements');
});

const ref = (revision = 'old') => ({ packId: 'project_pack', kind: 'effect' as const, id: 'blocks', revision });
const entry = (revision: string, digest: string): ProjectElementEntry => ({
  ref: ref(revision),
  digest,
  url: `/api/runtime/packs/project-elements/project/${digest}.js`,
  descriptor: { id: 'blocks', kind: 'effect', packId: 'project_pack', revision, label: 'Blocks', description: '',
    parameters: [], defaults: {}, renderability: { preview: 'supported', browserExport: 'supported', workerExport: 'unknown' } } as never,
  authoring: { packRoot: '/canonical', descriptorPath: '/canonical/element.yaml', componentPath: '/canonical/component.tsx', status: 'ready' },
});
const list = (projectId: string, selectionDigest: string, elements: ProjectElementEntry[], realmId = 'realm'): ProjectElementList => ({
  version: 1, projectId, realmId, selectionDigest, legacy: [], projects: [], elements,
});

describe('atomic admitted host refresh', () => {
  it('reports scoped preparation while the list is read, then settles even when an exact pin is absent', async () => {
    const missing = { packId: 'project_pack', kind: 'effect' as const, id: 'missing', revision: 'missing-revision' };
    expect(host.isAdmittedElementPreviewPreparing('project', [missing])).toBe(true);
    host.setAdmittedElementScope('project', [missing]);
    const pending = deferred<ProjectElementList>();
    const loading = host.refreshAdmittedElements(() => pending.promise, async () => Blocks);
    await Promise.resolve();
    expect(host.getAdmittedElementReadiness()).toMatchObject({ projectId: 'project', phase: 'loading', error: null });
    expect(host.isAdmittedElementPreviewPreparing('project', [missing])).toBe(true);

    pending.resolve(list('project', digestOf('7'), []));
    await loading;

    expect(host.getAdmittedElementReadiness().phase).toBe('ready');
    expect(host.admittedComponent(missing)).toBeUndefined();
    expect(host.isAdmittedElementPreviewPreparing('project', [missing])).toBe(false);
    expect(host.isAdmittedElementPreviewPreparing('other-project', [missing])).toBe(true);
    expect(host.isAdmittedElementPreviewPreparing('project', [{ ...missing, revision: 'new-unchecked-pin' }])).toBe(true);
  });

  it('publishes only the exact requested pin and loads only that listed digest', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    const load = vi.fn(async (_entry: ProjectElementEntry) => Blocks);

    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [entry('old', digestOf('1')), entry('new', digestOf('2'))]), load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toMatchObject({ digest: digestOf('1') });
    expect(host.admittedComponent(ref('old'))).toBe(Blocks);
    expect(host.admittedComponent(ref('new'))).toBeUndefined();
    expect(host.getAdmittedElementSelection().elements).toHaveLength(1);
    expect(host.getAdmittedElementSelection().elements[0]).toMatchObject({ projectId: 'project', descriptor: { revision: 'old' } });
  });

  it('keeps the same published selection when the Runtime list is unchanged, and reuses a verified module by digest', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    const load = vi.fn(async (_entry: ProjectElementEntry) => Blocks);
    const read = async () => list('project', digestOf('a'), [entry('old', digestOf('1'))]);

    const first = await host.refreshAdmittedElements(read, load);
    const second = await host.refreshAdmittedElements(read, load);

    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads a new digest for the same exact revision when the Runtime re-admits it', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    const load = vi.fn(async (_entry: ProjectElementEntry) => Blocks);

    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [entry('old', digestOf('1'))]), load);
    await host.refreshAdmittedElements(async () => list('project', digestOf('b'), [entry('old', digestOf('2'))]), load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]).toMatchObject({ digest: digestOf('2') });
    expect(host.getAdmittedElementSelection().selectionDigest).toBe(digestOf('b'));
  });

  it('records a failed list as the error readiness with its reason, and a later good list clears it', async () => {
    host.setAdmittedElementScope('project', []);
    await expect(host.refreshAdmittedElements(async () => { throw new Error('Admission endpoint refused this pack'); }))
      .resolves.toBe(host.getAdmittedElementSelection());
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: 'Admission endpoint refused this pack' });

    await host.refreshAdmittedElements(async () => list('project', digestOf('5'), []));
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'ready', error: null });
  });

  it('never rejects into prompts or the editor: a network failure and a malformed list both settle, unloaded, and log once', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      host.setAdmittedElementScope('project', [ref('old')]);
      const network = () => Promise.reject(new TypeError('Failed to fetch'));
      const malformed = async () => {
        const { parseProjectElementList } = await import('./admittedElementLoader');
        return parseProjectElementList({ version: 2 }, 'project');
      };

      await expect(host.refreshAdmittedElements(network)).resolves.toBeDefined();
      await expect(host.refreshAdmittedElements(network)).resolves.toBeDefined();
      await expect(host.refreshAdmittedElements(malformed)).resolves.toBeDefined();

      expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: 'Runtime returned an invalid project element list.' });
      expect(host.admittedComponent(ref('old'))).toBeUndefined();
      expect(host.isAdmittedElementPreviewPreparing('project', [ref('old')])).toBe(false);
      expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
        'Project elements unavailable: Failed to fetch',
        'Project elements unavailable: Runtime returned an invalid project element list.',
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps prompts working when the list read fails: the agent context refresh resolves and the project authoring still reads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    try {
      await expect(host.refreshProjectElementContext('project')).resolves.toBe(host.getAdmittedElementSelection());
      expect(host.getAdmittedElementReadiness()).toMatchObject({ projectId: 'project', phase: 'error', error: 'Failed to fetch' });
      expect(host.projectPackContext('project')).toMatchObject({ status: 'not-created', projectId: 'project' });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('bounds a stalled load and ignores its late completion', async () => {
    vi.useFakeTimers();
    try {
      host.setAdmittedElementScope('project', [ref('old')]);
      const pending = deferred<ProjectElementComponent>();
      const loading = host.refreshAdmittedElements(async () => list('project', digestOf('6'), [entry('old', digestOf('6'))]), () => pending.promise);
      await vi.advanceTimersByTimeAsync(host.ADMITTED_ELEMENT_LOAD_TIMEOUT_MS);
      await loading;
      expect(host.getAdmittedElementReadiness().error).toContain('timed out');
      expect(host.getAdmittedElementReadiness().phase).toBe('error');

      pending.resolve(Blocks);
      await Promise.resolve();
      expect(host.getAdmittedElementSelection().selectionDigest).not.toBe(digestOf('6'));
      expect(host.admittedComponent(ref('old'))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the activated build and records an error for a list for another project or a changed realm', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [entry('old', digestOf('1'))]), async () => Blocks);
    const activated = host.getAdmittedElementSelection();

    await host.refreshAdmittedElements(async () => list('other', digestOf('b'), [entry('old', digestOf('2'))]), async () => Blocks);
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: 'Element selection belongs to another project' });
    expect(host.getAdmittedElementSelection()).toBe(activated);

    await host.refreshAdmittedElements(async () => list('project', digestOf('c'), [entry('old', digestOf('3'))], 'other-realm'), async () => Blocks);
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: 'Element selection realm changed; reload the editor.' });
    expect(host.getAdmittedElementSelection()).toBe(activated);
    expect(host.admittedComponent(ref('old'))).toBe(Blocks);
  });

  it('keeps the previous verified build when a new bundle fails verification', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [entry('old', digestOf('1'))]), async () => Blocks);
    const activated = host.getAdmittedElementSelection();

    await expect(host.refreshAdmittedElements(async () => list('project', digestOf('b'), [entry('old', digestOf('2'))]),
      async () => { throw new Error('Project element blocks does not match the digest the Runtime admitted'); }))
      .resolves.toBe(activated);

    expect(host.getAdmittedElementSelection()).toBe(activated);
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: expect.stringContaining('does not match') });
  });

  it('activates a healthy sibling, reports only the failed ref, and retries the same list', async () => {
    const good = entry('good', digestOf('1'));
    const bad = entry('bad', digestOf('2'));
    host.setAdmittedElementScope('project', [good.ref, bad.ref]);
    let fail = true;
    const read = async () => list('project', digestOf('a'), [good, bad]);
    const load = vi.fn(async (item: ProjectElementEntry) => {
      if (item === bad && fail) throw new Error('bad bundle rejected');
      return Blocks;
    });
    await host.refreshAdmittedElements(read, load);
    expect(host.admittedComponent(good.ref)).toBe(Blocks);
    expect(host.admittedComponent(bad.ref)).toBeUndefined();
    expect(host.admittedElementFailure(bad.ref)).toBe('bad bundle rejected');
    expect(host.admittedElementFailure(good.ref)).toBeUndefined();
    fail = false;
    await host.refreshAdmittedElements(read, load);
    expect(host.admittedComponent(bad.ref)).toBe(Blocks);
    expect(host.admittedElementFailure(bad.ref)).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('retains the previous verified exact-ref build when its replacement fails alongside a healthy sibling', async () => {
    const old = entry('old', digestOf('1'));
    const replacement = entry('old', digestOf('2'));
    const sibling = entry('sibling', digestOf('3'));
    const Sibling: ProjectElementComponent = () => null;
    host.setAdmittedElementScope('project', [old.ref, sibling.ref]);
    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [old]), async () => Blocks);
    await host.refreshAdmittedElements(async () => list('project', digestOf('b'), [replacement, sibling]), async item => {
      if (item === replacement) throw new Error('replacement rejected');
      return Sibling;
    });
    expect(host.admittedComponent(old.ref)).toBe(Blocks);
    expect(host.admittedComponent(sibling.ref)).toBe(Sibling);
    expect(host.admittedElementFailure(old.ref)).toBe('replacement rejected');
  });

  it('retains a fulfilled sibling when another bundle stalls and ignores the late completion', async () => {
    vi.useFakeTimers();
    try {
      const good = entry('good', digestOf('1'));
      const slow = entry('slow', digestOf('2'));
      const pending = deferred<ProjectElementComponent>();
      host.setAdmittedElementScope('project', [good.ref, slow.ref]);
      const loading = host.refreshAdmittedElements(async () => list('project', digestOf('a'), [good, slow]),
        item => item === good ? Promise.resolve(Blocks) : pending.promise);
      await vi.advanceTimersByTimeAsync(host.ADMITTED_ELEMENT_LOAD_TIMEOUT_MS);
      await loading;
      expect(host.admittedComponent(good.ref)).toBe(Blocks);
      expect(host.admittedComponent(slow.ref)).toBeUndefined();
      expect(host.admittedElementFailure(slow.ref)).toContain('timed out');
      expect(host.admittedElementFailure(good.ref)).toBeUndefined();
      pending.resolve(Blocks);
      await Promise.resolve();
      expect(host.admittedComponent(slow.ref)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('fences a late project A completion after switching to project B and never leaks the old exact map', async () => {
    host.setAdmittedElementScope('project-a', [ref('old')]);
    const pending = deferred<ProjectElementList>();
    const loading = host.refreshAdmittedElements(() => pending.promise, async () => Blocks);
    await Promise.resolve();

    host.setAdmittedElementScope('project-b', [ref('b')]);
    expect(host.getAdmittedElementSelection().projectId).toBe('project-b');
    expect(host.admittedComponent(ref('old'))).toBeUndefined();

    pending.resolve(list('project-a', digestOf('a'), [entry('old', digestOf('1'))]));
    await loading;
    expect(host.getAdmittedElementSelection().projectId).toBe('project-b');
    expect(host.getAdmittedElementReadiness()).toMatchObject({ projectId: 'project-b', phase: 'loading' });
    expect(host.getAdmittedElementSelection().elements).toEqual([]);

    await host.refreshAdmittedElements(async () => list('project-b', digestOf('b'), [entry('b', digestOf('2'))]), async () => Blocks);
    expect(host.getAdmittedElementSelection().projectId).toBe('project-b');
    expect(host.admittedComponent(ref('b'))).toBe(Blocks);
    expect(host.admittedComponent(ref('old'))).toBeUndefined();
  });

  it('ignores an older completion after a newer refresh has won', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    const pending = deferred<ProjectElementList>();
    const slow = host.refreshAdmittedElements(() => pending.promise, async () => Blocks);
    await Promise.resolve();

    const winner = await host.refreshAdmittedElements(async () => list('project', digestOf('b'), [entry('old', digestOf('2'))]), async () => Blocks);
    pending.resolve(list('project', digestOf('a'), [entry('old', digestOf('1'))]));
    await slow;

    expect(host.getAdmittedElementSelection()).toBe(winner);
    expect(host.getAdmittedElementSelection().selectionDigest).toBe(digestOf('b'));
  });

  it('publishes nothing when no project is scoped', async () => {
    const before = host.getAdmittedElementSelection();
    await expect(host.refreshAdmittedElements()).resolves.toBe(before);
    expect(host.getAdmittedElementSelection().projectId).toBeNull();
    expect(host.getAdmittedElementReadiness().phase).toBe('ready');
  });

  it('aborts a pending bundle fetch on a project switch and never evaluates or publishes it', async () => {
    host.setAdmittedElementScope('project-a', [ref('old')]);
    const evaluated = vi.fn();
    let aborted = false;
    const started = deferred<void>();
    const load = vi.fn((_entry: ProjectElementEntry) => new Promise<ProjectElementComponent>((resolve, reject) => {
      // Stands in for fetch + digest check + import(): once the project is left, nothing may reach evaluation.
      started.resolve(undefined as never);
      setTimeout(() => { if (aborted) reject(new Error('aborted')); else { evaluated(); resolve(Blocks); } }, 0);
    }));
    const loading = host.refreshAdmittedElements(async () => list('project-a', digestOf('a'), [entry('old', digestOf('1'))]), load);
    await started.promise;
    host.setAdmittedElementScope('project-b', [ref('old')]);
    aborted = true;
    await loading;

    expect(host.getAdmittedElementSelection().components).toEqual({});
    expect(host.getAdmittedElementSelection().projectId).toBe('project-b');
    expect(host.admittedComponent(ref('old'))).toBeUndefined();
    expect(host.getAdmittedElementReadiness()).toMatchObject({ projectId: 'project-b', phase: 'loading' });
    expect(evaluated).not.toHaveBeenCalled();
  });

  it('aborts the in-flight list fetch itself when the scope changes', async () => {
    vi.doMock('@/integrations/runtime/connection', () => ({ runtimeOrigin: () => '', runtimeApiBase: () => '/api/runtime' }));
    vi.resetModules();
    host = await import('./admitted-elements');
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }));
    try {
      host.setAdmittedElementScope('project-a', [ref('old')]);
      const loading = host.refreshAdmittedElements();
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0].aborted).toBe(false);
      host.setAdmittedElementScope('project-b', []);
      expect(signals[0].aborted).toBe(true);
      await loading;
      expect(host.getAdmittedElementReadiness()).toMatchObject({ projectId: 'project-b', phase: 'loading' });
    } finally { vi.unstubAllGlobals(); vi.doUnmock('@/integrations/runtime/connection'); }
  });

  it('reports legacy elements by name so their clips can say they need re-admitting', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    const legacy = [{ packId: 'project_pack', kind: 'effect' as const, id: 'blocks' }];
    await host.refreshAdmittedElements(async () => ({ ...list('project', digestOf('a'), []), legacy }), async () => Blocks);

    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'ready', legacy });
    expect(host.isLegacyElementRef(ref('old'))).toBe(true);
    expect(host.isLegacyElementRef({ ...ref('old'), id: 'other' })).toBe(false);
    expect(host.LEGACY_ELEMENT_REASON).toBe('Project elements admitted before this version need re-admitting: run project-pack admit again.');
  });
});
