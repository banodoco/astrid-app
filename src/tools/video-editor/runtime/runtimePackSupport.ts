import { useSyncExternalStore } from 'react';

/** The one calm line a pack surface shows while the connected Runtime has no packs yet. */
export const PACKS_NEED_NEWER_ASTRID = 'Packs need a newer Astrid. Update to use them.';

// Set by useRuntimePackExtensions: true once the Runtime answers its inventory route with 404 (it predates packs).
let unsupported = false;
const listeners = new Set<() => void>();

export function setRuntimePacksUnsupported(value: boolean): void {
  if (unsupported === value) return;
  unsupported = value;
  for (const listener of listeners) listener();
}

export function usePacksUnsupported(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => unsupported,
    () => false,
  );
}
