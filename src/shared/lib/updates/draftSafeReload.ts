import { useCallback, useEffect, useRef, useState } from 'react';

export type DraftSafeReloadGuard = {
  label: string;
  flush: () => Promise<void>;
  /** Synchronous final check, so a draft edited while another guard was flushing cannot slip through. */
  isDirty?: () => boolean;
};

const guards = new Map<symbol, DraftSafeReloadGuard>();
let guardsVersion = 0;

/** Register an editor draft that must reach durable storage before an update reload. */
export function registerDraftSafeReloadGuard(guard: DraftSafeReloadGuard): () => void {
  const key = Symbol(guard.label);
  guards.set(key, guard);
  guardsVersion++;
  return () => {
    if (guards.delete(key)) guardsVersion++;
  };
}

/** Flush every draft owner, including retained unmounted work. Failures keep the page open. */
export async function flushDraftsBeforeReload(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const version = guardsVersion;
    const pending = [...guards.values()];
    const outcomes = await Promise.allSettled(pending.map((guard) => guard.flush()));
    const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [`${pending[index]!.label}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
      : []);
    if (failures.length) throw new Error(failures.join('; '));
    if (version !== guardsVersion) continue;
    if (pending.every((guard) => !guard.isDirty?.())) return;
  }
  throw new Error('Drafts kept changing while they were being saved.');
}

/** Bind an admission to the exact registered owners observed after flushing. */
export function captureDraftReloadWitness(): () => boolean {
  const version = guardsVersion;
  const owners = [...guards.values()];
  return () => version === guardsVersion && owners.every((owner) => typeof owner.isDirty === 'function' && !owner.isDirty());
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
  flush: () => Promise<boolean>;
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
      await flushDraftsBeforeReload();
      return true;
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
      await flushDraftsBeforeReload();
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
