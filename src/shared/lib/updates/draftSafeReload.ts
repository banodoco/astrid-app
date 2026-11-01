import { useCallback, useEffect, useRef, useState } from 'react';

export type DraftSafeReloadGuard = {
  label: string;
  flush: () => Promise<void>;
  /** Synchronous final check, so a draft edited while another guard was flushing cannot slip through. */
  isDirty?: () => boolean;
  /** Recovery-only navigation never authorizes an installer POST. */
  flushForReload?: () => Promise<void>;
  isDirtyForReload?: () => boolean;
  retainUnresolved?: boolean;
};

const guards = new Map<symbol, DraftSafeReloadGuard>();
let guardsVersion = 0;
let mutationVersion = 0;
let failureVersion = 0;
function protectUnsavedDrafts(event: BeforeUnloadEvent): void {
  if (![...guards.values()].some(guard => guard.isDirty?.())) return;
  event.preventDefault();
  event.returnValue = '';
}

/** Called synchronously at edit entry points, before any async work. */
export function invalidateDraftReload(): void { mutationVersion++; }
/** A later background success cannot rescue the explicit click that saw this failure. */
export function recordDraftReloadFailure(): void { failureVersion++; }

/** Test cases represent separate pages; retained owners deliberately outlive React cleanup. */
export function resetDraftReloadGuardsForTest(): void {
  if (import.meta.env.MODE !== 'test') throw new Error('Draft owners may only be reset by tests.');
  guards.clear();
  window.removeEventListener('beforeunload', protectUnsavedDrafts);
  guardsVersion++;
  invalidateDraftReload();
}

/** Register an editor draft that must reach durable storage before an update reload. */
export function registerDraftSafeReloadGuard(guard: DraftSafeReloadGuard): () => void {
  if (guards.size === 0 && typeof window !== 'undefined') window.addEventListener('beforeunload', protectUnsavedDrafts);
  const key = Symbol(guard.label);
  guards.set(key, guard);
  guardsVersion++;
  return () => {
    if (guard.retainUnresolved && guard.isDirty?.()) return;
    if (guards.delete(key)) guardsVersion++;
    if (guards.size === 0 && typeof window !== 'undefined') window.removeEventListener('beforeunload', protectUnsavedDrafts);
  };
}

/** Flush every draft owner, including retained unmounted work. Failures keep the page open. */
export async function flushDraftsBeforeReload(intent: 'update' | 'reload' = 'update'): Promise<() => boolean> {
  const mutation = mutationVersion;
  const failure = failureVersion;
  for (let attempt = 0; attempt < 5; attempt++) {
    const version = guardsVersion;
    const pending = [...guards.values()];
    const outcomes = await Promise.allSettled(pending.map((guard) => Promise.resolve().then(() =>
      intent === 'reload' && guard.flushForReload ? guard.flushForReload() : guard.flush())));
    const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [`${pending[index]!.label}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
      : []);
    if (failures.length) throw new Error(failures.join('; '));
    if (intent === 'update' && (mutation !== mutationVersion || failure !== failureVersion)) {
      throw new Error('Drafts changed or failed while saving. Save them and try again.');
    }
    if (version !== guardsVersion) continue;
    if (pending.every((guard) => !(intent === 'reload' && guard.isDirtyForReload
      ? guard.isDirtyForReload() : guard.isDirty?.()))) return captureDraftReloadWitness(intent);
  }
  throw new Error('Drafts kept changing while they were being saved.');
}

/** Bind an admission to the exact registered owners observed after flushing. */
export function captureDraftReloadWitness(intent: 'update' | 'reload' = 'update'): () => boolean {
  const version = guardsVersion;
  const mutation = mutationVersion;
  const failure = failureVersion;
  const owners = [...guards.values()];
  return () => version === guardsVersion && mutation === mutationVersion && failure === failureVersion
    && owners.every((owner) => intent === 'update'
      ? typeof owner.isDirty === 'function' && !owner.isDirty()
      : !(owner.isDirtyForReload?.() ?? owner.isDirty?.()));
}

/** Keep one mounted surface's latest flush implementation registered for update reloads. */
export function useDraftSafeReload(label: string, flush: () => Promise<void>, enabled = true, isDirty: () => boolean = () => false): void {
  const latest = useRef({ flush, isDirty });
  latest.current = { flush, isDirty };

  useEffect(() => {
    if (!enabled) return;
    return registerDraftSafeReloadGuard({
      label,
      flush: () => latest.current.flush(),
      isDirty: () => latest.current.isDirty(),
    });
  }, [enabled, label]);
}

/** Run a caller's reload only after every registered draft has reached durable storage. */
export function useGuardedReload(reloadImpl: () => void = () => window.location.reload()): {
  flush: () => Promise<false | (() => boolean)>;
  reload: () => Promise<void>;
  error: string | null;
  pending: boolean;
} {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const flush = useCallback(async () => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      return await flushDraftsBeforeReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);
  const reload = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const validate = await flushDraftsBeforeReload('reload');
      if (!validate()) throw new Error('Drafts changed before reload. Try again.');
      reloadImpl();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [reloadImpl]);
  return { flush, reload, error, pending };
}
