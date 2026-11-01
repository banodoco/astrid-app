import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Shot } from '@/domains/generation/types';
import { useNameEditing } from './useNameEditing.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function actions() {
  return {
    setEditingName: vi.fn(),
    setEditingNameValue: vi.fn(),
  } as never;
}

const shot = { id: 'shot-1', name: 'Original' } as Shot;

describe('native shot name form completion', () => {
  it('keeps the form open until the same durable submission is accepted', async () => {
    const pending = deferred<void>();
    const update = vi.fn(() => pending.promise);
    const editorActions = actions();
    const { result } = renderHook(() => useNameEditing({
      selectedShot: shot,
      state: { isEditingName: true, editingName: '  Keep this exact draft  ' },
      actions: editorActions,
      onUpdateShotName: update,
    }));

    let completion!: Promise<void>;
    act(() => { completion = result.current.handleNameSave() as Promise<void>; });
    expect(update).toHaveBeenCalledWith('Keep this exact draft');
    expect(editorActions.setEditingName).not.toHaveBeenCalledWith(false);

    await act(async () => {
      pending.resolve();
      await completion;
    });
    expect(editorActions.setEditingName).toHaveBeenCalledWith(false);
  });

  it('retires a deferred completion when the hook unmounts', async () => {
    const pending = deferred<void>();
    const update = vi.fn(() => pending.promise);
    const editorActions = actions();
    const { result, unmount } = renderHook(() => useNameEditing({
      selectedShot: shot,
      state: { isEditingName: true, editingName: 'Retire this draft' },
      actions: editorActions,
      onUpdateShotName: update,
    }));

    let completion!: Promise<void>;
    act(() => { completion = result.current.handleNameSave() as Promise<void>; });
    unmount();

    await act(async () => {
      pending.resolve();
      await completion;
    });

    expect(editorActions.setEditingName).not.toHaveBeenCalled();
    expect(editorActions.setEditingNameValue).not.toHaveBeenCalled();
  });

  it('restores the exact input and keeps the form open when acceptance refuses', async () => {
    const pending = deferred<void>();
    const update = vi.fn(() => pending.promise);
    const editorActions = actions();
    const { result } = renderHook(() => useNameEditing({
      selectedShot: shot,
      state: { isEditingName: true, editingName: '  Refused draft  ' },
      actions: editorActions,
      onUpdateShotName: update,
    }));

    let completion!: Promise<void>;
    act(() => { completion = result.current.handleNameSave() as Promise<void>; });
    await act(async () => {
      pending.reject(new Error('Runtime refused the original guard'));
      await completion;
    });

    expect(editorActions.setEditingNameValue).toHaveBeenCalledWith('  Refused draft  ');
    expect(editorActions.setEditingName).toHaveBeenCalledWith(true);
    expect(editorActions.setEditingName).not.toHaveBeenCalledWith(false);
  });
});
