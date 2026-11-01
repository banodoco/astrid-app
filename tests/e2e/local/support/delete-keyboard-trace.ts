import type { CDPSession, Page, TestInfo } from '@playwright/test';

/** Read the real listener closures; never replace callbacks, selection, or ports. */
export async function traceDeleteKeyboard(page: Page, testInfo: TestInfo) {
  if (process.env.TIMELINE_DELETE_KEYBOARD_TRACE !== '1') return undefined;
  const cdp = await page.context().newCDPSession(page);
  const entries: unknown[] = [];
  const send = (method: string, params: Record<string, unknown> = {}) =>
    cdp.send(method as Parameters<CDPSession['send']>[0], params as never) as Promise<any>;
  const properties = async (objectId: string) => send('Runtime.getProperties', { objectId, ownProperties: true });
  const describe = async (value: any): Promise<unknown> => {
    if (!value?.objectId) return value?.value ?? value?.description ?? value?.type;
    if (value.type === 'function') return value.description;
    const result = await send('Runtime.callFunctionOn', { objectId: value.objectId, returnByValue: true,
      silent: true, throwOnSideEffect: true, functionDeclaration: `function() {
        const node = (value) => value instanceof Element ? {
          tag: value.tagName, clip: value.getAttribute('data-clip-id'),
          selected: value.getAttribute('data-selected'), connected: value.isConnected,
        } : value === null ? null : typeof value;
        if (this instanceof KeyboardEvent) return { key: this.key, target: node(this.target),
          focused: this.target === document.activeElement, defaultPrevented: this.defaultPrevented,
          editable: this.target instanceof Element && !!this.target.closest("input, textarea, select, [contenteditable='true']") };
        if (this instanceof Set) return { selection: Array.from(this) };
        if (Array.isArray(this)) return { values: this.map(value =>
          value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : typeof value) };
        const result = { keys: Object.keys(this) };
        for (const key of ['selectedClipIds', 'selectedDataItems', 'agentSelectionOwner', 'clipId', 'status', 'error']) {
          if (key in this) result[key] = this[key] instanceof Set ? Array.from(this[key])
            : Array.isArray(this[key]) ? this[key].length : String(this[key]);
        }
        for (const key of ['clipDelete', 'handleDeleteClips', 'handleDeleteClip', 'applyEdit', 'capture', 'finish', 'submit']) {
          if (key in this) result[key] = typeof this[key];
        }
        if ('shellRootRef' in this) result.shellRoot = { node: node(this.shellRootRef?.current),
          containsFocus: this.shellRootRef?.current?.contains(document.activeElement) ?? false };
        const data = this.dataRef?.current ?? (this.current?.rows ? this.current : this.rows && this.meta ? this : null);
        if (data) result.data = { head: data.head, clips: Object.keys(data.meta ?? {}),
          groups: data.config?.pinnedShotGroups, projection: data.editProjection };
        if ('current' in this && !data) result.current = node(this.current);
        return result;
      }` });
    return result.exceptionDetails ? { inspectionError: result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text } : result.result.value;
  };
  const scopeValues = async (objectId: string) => {
    const { result } = await properties(objectId);
    return Object.fromEntries(await Promise.all(result.filter((item: any) => item.value)
      .map(async (item: any) => [item.name, await describe(item.value)])));
  };
  let pausedWork = Promise.resolve();
  cdp.on('Debugger.paused', (pause) => {
    pausedWork = pausedWork.then(async () => {
      try {
        const frames = [];
        for (const frame of pause.callFrames.slice(0, 5)) {
          const scopes = [];
          for (const scope of frame.scopeChain.filter((scope) => ['local', 'closure'].includes(scope.type)).slice(0, 3)) {
            scopes.push({ type: scope.type, name: scope.name, values: await scopeValues(scope.object.objectId) });
          }
          frames.push({ functionName: frame.functionName, location: frame.location, scopes });
        }
        entries.push({ reason: pause.reason, exception: pause.data?.description, frames });
      } catch (error) {
        entries.push({ inspectionError: String(error) });
      } finally {
        await send('Debugger.resume');
      }
    });
  });
  await send('Debugger.enable');
  const seen = new Set<string>();
  const inspectFunction = async (fn: any, path: string, depth = 0): Promise<void> => {
    if (!fn?.objectId || seen.has(fn.objectId) || depth > 5) return;
    seen.add(fn.objectId);
    entries.push({ path, source: fn.description });
    await send('Debugger.setBreakpointOnFunctionCall', { objectId: fn.objectId });
    const details = await properties(fn.objectId);
    const scopes = details.internalProperties?.find((item: any) => item.name === '[[Scopes]]')?.value;
    if (!scopes?.objectId) return;
    for (const scope of (await properties(scopes.objectId)).result) {
      if (!scope.value?.description?.startsWith('Closure')) continue;
      entries.push({ path, scope: scope.value.description, values: await scopeValues(scope.value.objectId) });
      for (const binding of (await properties(scope.value.objectId)).result) {
        const value = binding.value;
        if (!value?.objectId) continue;
        if (value.type === 'function' && /handleDeleteClips|Timeline edit refused|earlier timeline saves before deleting|uploading-/.test(value.description)) {
          await inspectFunction(value, `${path}.${binding.name}`, depth + 1);
        } else if (value.type === 'object' && value.subtype !== 'null') {
          for (const member of (await properties(value.objectId)).result) {
            if (['handleDeleteClips', 'applyEdit', 'capture', 'finish', 'submit'].includes(member.name)
              && member.value?.type === 'function') {
              await inspectFunction(member.value, `${path}.${binding.name}.${member.name}`, depth + 1);
            }
          }
        }
      }
    }
  };
  try {
    const windowObject = await send('Runtime.evaluate', { expression: 'window' });
    const { listeners } = await send('DOMDebugger.getEventListeners', { objectId: windowObject.result.objectId });
    for (const listener of listeners.filter((listener: any) => listener.type === 'keydown')) {
      const fn = listener.originalHandler ?? listener.handler;
      if (/['"]Delete['"]/.test(fn?.description ?? '')) await inspectFunction(fn, 'window.keydown');
    }
    await send('Debugger.setPauseOnExceptions', { state: 'all' });
  } catch (error) {
    await cdp.detach();
    throw error;
  }
  return async () => {
    try {
      await send('Debugger.setPauseOnExceptions', { state: 'none' });
      await pausedWork;
      await send('Debugger.disable');
    } finally {
      await cdp.detach();
      await testInfo.attach('delete-keyboard-listener-scopes', {
        contentType: 'application/json', body: Buffer.from(JSON.stringify(entries, null, 2)),
      });
    }
  };
}
