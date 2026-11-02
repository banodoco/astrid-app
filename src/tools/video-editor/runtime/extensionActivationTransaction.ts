import type { ExtensionContext, DisposeHandle } from '@astrid/editor-sdk';
import { CONTEXT_DISPOSE_SYMBOL } from '@/sdk/context';
import { INTERNAL_EXTENSION_RENDER_SURFACE, attachInternalExtensionRenderSurface } from '@/sdk/internalExtensionRenderSurface';

const commitCallbacks = new WeakMap<ExtensionContext, () => void>();
export function onExtensionContextCommit(context: ExtensionContext, callback: () => void) {
  commitCallbacks.set(context, callback);
}

/** Keep imperative registrations invisible until synchronous activation succeeds. */
export function stageExtensionContext(context: ExtensionContext) {
  let committed = false;
  let disposed = false;
  const pending: Array<() => void> = [];
  const registrations = new Set<{ apply(): void; suspend(): void; dispose(): void }>();
  const staged = { ...context } as any;
  // Registration services all return scoped disposal handles. Other operations
  // retain the host context's semantics; arbitrary extension side effects cannot
  // be rolled back by the host.
  for (const key of ['commands', 'effects', 'transitions', 'clipTypes', 'shaders', 'agentTools', 'dataKinds', 'ui', 'liveSceneAuthoring']) {
    const service = (context as any)[key];
    if (!service) continue;
    staged[key] = Object.fromEntries(Object.entries(service).map(([name, value]) => {
      if (typeof value !== 'function' || !name.startsWith('register')) return [name, value];
      return [name, (...args: unknown[]) => {
        if (disposed) throw new Error('Extension registration context is disposed');
        let cancelled = false;
        let handle: DisposeHandle | undefined;
        const owned = {
          apply() {
            if (!cancelled) handle = value.apply(service, args);
          },
          suspend() {
            const previous = handle;
            handle = undefined;
            previous?.dispose();
          },
          dispose() {
            if (cancelled) return;
            cancelled = true;
            registrations.delete(owned);
            owned.suspend();
          },
        };
        registrations.add(owned);
        if (committed) owned.apply(); else pending.push(owned.apply);
        return owned;
      }];
    }));
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    pending.length = 0;
    for (const handle of [...registrations].reverse()) {
      try { handle.dispose(); } catch { /* Keep draining owned handles. */ }
    }
    (context as any)[CONTEXT_DISPOSE_SYMBOL]?.();
  }
  // Preserve the context's internal disposal/render-surface symbols.
  for (const symbol of Object.getOwnPropertySymbols(context)) {
    if (symbol !== CONTEXT_DISPOSE_SYMBOL && (symbol !== INTERNAL_EXTENSION_RENDER_SURFACE || !staged.ui)) {
      Object.defineProperty(staged, symbol, Object.getOwnPropertyDescriptor(context, symbol)!);
    }
  }
  if (staged.ui) attachInternalExtensionRenderSurface(staged, staged.ui);
  Object.defineProperty(staged, CONTEXT_DISPOSE_SYMBOL, { value: dispose });
  return {
    context: Object.freeze(staged) as ExtensionContext,
    commit() {
      if (disposed || committed) return;
      committed = true;
      commitCallbacks.get(context)?.();
      for (const apply of pending.splice(0)) apply();
    },
    suspend() {
      for (const registration of [...registrations].reverse()) registration.suspend();
    },
    restore() {
      if (disposed) return;
      commitCallbacks.get(context)?.();
      for (const registration of registrations) registration.apply();
    },
    dispose,
  };
}
