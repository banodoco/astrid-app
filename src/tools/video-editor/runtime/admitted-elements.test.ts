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
  version: 1, projectId, realmId, selectionDigest, projects: [], elements,
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

  it('ends loading on a genuine failure and retains the diagnostic', async () => {
    host.setAdmittedElementScope('project', []);
    await expect(host.refreshAdmittedElements(async () => { throw new Error('Admission endpoint refused this pack'); }))
      .rejects.toThrow('refused');
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: 'Admission endpoint refused this pack' });

    await host.refreshAdmittedElements(async () => list('project', digestOf('5'), []));
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'ready', error: null });
  });

  it('bounds a stalled load and ignores its late completion', async () => {
    vi.useFakeTimers();
    try {
      host.setAdmittedElementScope('project', [ref('old')]);
      const pending = deferred<ProjectElementComponent>();
      const loading = host.refreshAdmittedElements(async () => list('project', digestOf('6'), [entry('old', digestOf('6'))]), () => pending.promise);
      const rejected = expect(loading).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(host.ADMITTED_ELEMENT_LOAD_TIMEOUT_MS);
      await rejected;
      expect(host.getAdmittedElementReadiness().phase).toBe('error');

      pending.resolve(Blocks);
      await Promise.resolve();
      expect(host.getAdmittedElementSelection().selectionDigest).not.toBe(digestOf('6'));
      expect(host.admittedComponent(ref('old'))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the activated build and rejects a list for another project or a changed realm', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [entry('old', digestOf('1'))]), async () => Blocks);
    const activated = host.getAdmittedElementSelection();

    await expect(host.refreshAdmittedElements(async () => list('other', digestOf('b'), [entry('old', digestOf('2'))]), async () => Blocks))
      .rejects.toThrow('another project');
    expect(host.getAdmittedElementSelection()).toBe(activated);

    await expect(host.refreshAdmittedElements(async () => list('project', digestOf('c'), [entry('old', digestOf('3'))], 'other-realm'), async () => Blocks))
      .rejects.toThrow('realm changed');
    expect(host.getAdmittedElementSelection()).toBe(activated);
    expect(host.admittedComponent(ref('old'))).toBe(Blocks);
  });

  it('keeps the previous verified build when a new bundle fails verification', async () => {
    host.setAdmittedElementScope('project', [ref('old')]);
    await host.refreshAdmittedElements(async () => list('project', digestOf('a'), [entry('old', digestOf('1'))]), async () => Blocks);
    const activated = host.getAdmittedElementSelection();

    await expect(host.refreshAdmittedElements(async () => list('project', digestOf('b'), [entry('old', digestOf('2'))]),
      async () => { throw new Error('Project element blocks does not match the digest the Runtime admitted'); }))
      .rejects.toThrow('does not match');

    expect(host.getAdmittedElementSelection()).toBe(activated);
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error' });
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
});
