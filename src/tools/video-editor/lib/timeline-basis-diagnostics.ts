/** Private, synchronous binding: capture once before the loader's first await.
 * No provider API, error, document or request identity crosses this seam.
 */
export type BasisOperation = 'loader' | 'history' | 'parent' | 'shot' | 'internal';
export type BasisObservation = { operation: BasisOperation; operationOrdinal: number; operationState: 'start' | 'end' | 'refused' };
type Observer = (observation: BasisObservation) => void;
const bindings = new WeakMap<object, Observer>();

export function withTimelineBasisDiagnostics<T>(provider: object, observer: Observer, read: () => T): T {
  const previous = bindings.get(provider);
  bindings.set(provider, observer);
  try { return read(); }
  finally {
    if (previous) bindings.set(provider, previous);
    else bindings.delete(provider);
  }
}

export function timelineBasisDiagnostics(provider: object) {
  const observer = bindings.get(provider);
  let ordinal = 0;
  return (operation: BasisOperation) => {
    const operationOrdinal = ++ordinal;
    const emit = (operationState: BasisObservation['operationState']) => {
      try { observer?.({ operation, operationOrdinal, operationState }); }
      catch { /* A listener cannot affect a loader result or its original error. */ }
    };
    emit('start');
    return (completed: boolean) => emit(completed ? 'end' : 'refused');
  };
}
