// Passive, bounded observation of the existing C4 edit. No action replacement.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function installC4Observation(page, context, { evidence, stamp, origin, projectId, timelineId }) {
  const maxRecords = 2048;
  const nodeEvents = [];
  let nodeOverflow = 0;
  const add = (kind, value) => {
    const row = { kind, epochMs: Date.now(), monotonicMs: performance.now(), ...value };
    if (nodeEvents.length < maxRecords) nodeEvents.push(row);
    else nodeOverflow++;
  };
  const requests = new WeakMap();
  let nextRequest = 0;
  const selectedRequest = request => {
    const url = new URL(request.url());
    return url.origin === origin && url.pathname.startsWith('/api/runtime/')
      && (url.pathname.includes('/timelines/') || !['GET', 'HEAD', 'OPTIONS'].includes(request.method()));
  };
  const requestListener = request => {
    try {
      if (!selectedRequest(request)) return;
      const url = new URL(request.url());
      const body = request.postDataBuffer();
      const id = ++nextRequest;
      requests.set(request, id);
      add('request', {
        id, method: request.method(), pathname: url.pathname, resourceType: request.resourceType(),
        isTargetCommit: url.pathname === '/api/runtime/v1/projects/' + projectId + '/timelines/' + timelineId + '/commit'
          && request.method() === 'POST',
        bodyBytes: body?.length ?? 0,
        bodySha256: body ? createHash('sha256').update(body).digest('hex') : null,
      });
    } catch (error) { add('observer-error', { source: 'request', error: String(error) }); }
  };
  const responseListener = response => {
    try {
      const id = requests.get(response.request());
      if (id !== undefined) add('response', { id, status: response.status() });
    } catch (error) { add('observer-error', { source: 'response', error: String(error) }); }
  };
  const failedListener = request => {
    try {
      const id = requests.get(request);
      if (id !== undefined) add('request-failed', { id, error: request.failure()?.errorText ?? 'UNKNOWN' });
    } catch (error) { add('observer-error', { source: 'request-failed', error: String(error) }); }
  };
  page.on('request', requestListener);
  page.on('response', responseListener);
  page.on('requestfailed', failedListener);

  // Installed before navigation. This enables the existing product producer;
  // it neither replaces fetch nor reaches into a save owner or command port.
  await context.addInitScript(({ limit }) => {
    window.__timelineSaveDiagnosticsEnabled = true;
    const records = [];
    let overflow = 0;
    let observerErrors = 0;
    let ownerSummaryOverflow = 0;
    let sequence = 0;
    let nextField = 0;
    const fieldAliases = new WeakMap();
    const owners = new Map();
    const text = value => typeof value === 'string' ? value.slice(0, 240) : null;
    const own = (value, name) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    const firstField = () => document.querySelector('[data-track-id="V1"] input[aria-label="Track name"]')
      ?? document.querySelector('input[aria-label="Track name"]');
    const fieldSnapshot = field => {
      if (!(field instanceof HTMLInputElement)) return null;
      if (!fieldAliases.has(field)) fieldAliases.set(field, ++nextField);
      // Reading only the existing own data property gives the controlled prop,
      // distinct from the transient DOM value. No React callback is invoked.
      const propsKey = Object.getOwnPropertyNames(field).find(key => key.startsWith('__reactProps$'));
      const props = propsKey ? own(field, propsKey) : undefined;
      const controlled = own(props, 'value');
      const row = field.closest('[data-track-id]');
      return {
        fieldAlias: fieldAliases.get(field), connected: field.isConnected,
        firstTrackNameField: firstField() === field,
        trackId: text(row?.getAttribute('data-track-id')),
        domValue: text(field.value), valueAttribute: text(field.getAttribute('value')),
        defaultValue: text(field.defaultValue),
        controlledValue: typeof controlled === 'string' ? text(controlled) : typeof controlled === 'number' ? controlled : 'UNKNOWN',
        controlledValueSource: propsKey ? 'React own props data property; observed only' : 'UNAVAILABLE',
        readOnly: field.readOnly, disabled: field.disabled,
        controlledReadOnly: typeof own(props, 'readOnly') === 'boolean' ? own(props, 'readOnly') : 'UNKNOWN',
        onChangePresent: typeof own(props, 'onChange') === 'function',
        onKeyDownPresent: typeof own(props, 'onKeyDown') === 'function',
        onBlurPresent: typeof own(props, 'onBlur') === 'function',
        active: document.activeElement === field,
      };
    };
    const ownerSnapshot = () => [...owners.values()].slice(-16).map(owner => ({ ...owner }));
    const record = (kind, value = {}, field = firstField()) => {
      try {
        const row = { sequence: ++sequence, kind, epochMs: Date.now(), monotonicMs: performance.now(),
          ...value, field: fieldSnapshot(field), ownerEvents: ownerSnapshot() };
        if (records.length < limit) records.push(row);
        else overflow++;
      } catch { observerErrors++; }
    };
    const saveListener = event => {
      try {
        const detail = event.detail;
        if (own(detail, 'version') !== 1 || typeof own(detail, 'phase') !== 'string') return;
        // The existing producer emits a fixed, frozen, scalar-only projection.
        const safe = JSON.parse(JSON.stringify(detail));
        if (typeof safe.ownerAlias === 'number') {
          const previous = owners.get(safe.ownerAlias) ?? { ownerAlias: safe.ownerAlias };
          const next = { ...previous, lastPhase: safe.phase, lastSequence: safe.sequence,
            lastGeneration: safe.generation, lastCurrent: safe.current, lastClosed: safe.closed };
          if (safe.phase === 'handoff-ready') {
            next.handoffSequence = safe.sequence;
            next.handoffGeneration = safe.generation;
          }
          if (['owner-closed', 'owner-retired', 'lifecycle-cancel', 'owner-error'].includes(safe.phase)) {
            next.lastInvalidationPhase = safe.phase;
            next.lastInvalidationSequence = safe.sequence;
          }
          owners.set(safe.ownerAlias, next);
          if (owners.size > 16) {
            owners.delete(owners.keys().next().value);
            ownerSummaryOverflow++;
          }
        }
        record('timeline:save-diagnostic', { detail: safe });
      } catch { observerErrors++; }
    };
    window.addEventListener('timeline:save-diagnostic', saveListener);
    window.addEventListener('shot-timeline:timing', event => {
      try {
        const detail = event.detail;
        const phase = own(detail, 'phase');
        if (!['local-commit', 'debounce-fired', 'editor-ack'].includes(phase)) return;
        record('shot-timeline:timing', { detail: {
          phase, traceId: text(own(detail, 'traceId')), at: own(detail, 'at'),
          version: own(detail, 'version'), saveDelayMs: own(detail, 'saveDelayMs'),
        } });
      } catch { observerErrors++; }
    });
    const eventTypes = ['beforeinput', 'input', 'change', 'keydown', 'keyup', 'focusin', 'blur', 'focusout'];
    for (const capture of [true, false]) {
      for (const type of eventTypes) {
        document.addEventListener(type, event => {
          try {
            const field = event.target;
            if (!(field instanceof HTMLInputElement) || field.getAttribute('aria-label') !== 'Track name') return;
            const detail = { type, listenerPhase: capture ? 'capture' : 'bubble',
              trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
              key: text(event.key), inputType: text(event.inputType), data: text(event.data) };
            record('input-event', detail, field);
            // Observe React's restoration after the same event. No await, sleep,
            // extra input event, preventDefault, propagation change or retry.
            if (capture) queueMicrotask(() => record('after-event-microtask', detail, field));
          } catch { observerErrors++; }
        }, { capture, passive: true });
      }
    }
    let priorFieldState = '';
    const observeField = () => {
      try {
        const state = JSON.stringify(fieldSnapshot(firstField()));
        if (state !== priorFieldState) {
          priorFieldState = state;
          record('controlled-field-observation');
        }
      } catch { observerErrors++; }
    };
    new MutationObserver(observeField).observe(document, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['value', 'readonly', 'disabled', 'aria-label', 'data-track-id'],
    });
    Object.defineProperty(window, '__p61C4DiagnosticRead', { value: () => ({
      version: 1, status: 'observed', records: [...records], overflow, observerErrors, ownerSummaryOverflow,
      totalRecords: sequence, finalField: fieldSnapshot(firstField()), finalOwnerEvents: ownerSnapshot(),
      finalTrackNameFields: [...document.querySelectorAll('input[aria-label="Track name"]')].slice(0, 16).map(fieldSnapshot),
      readinessLimit: 'Owner milestones are existing event observations, not direct access to mutable owner internals.',
    }), configurable: false });
    record('observer-installed');
  }, { limit: maxRecords });

  return {
    action(name) { add('action', { name }); },
    async finish() {
      let browserObservation;
      let deadline;
      try {
        // A collection deadline applies only after the unchanged product
        // assertion has finished; it does not delay or retry the edit.
        browserObservation = await Promise.race([
          page.evaluate(() => typeof window.__p61C4DiagnosticRead === 'function'
            ? window.__p61C4DiagnosticRead() : { status: 'UNAVAILABLE' }),
          new Promise(resolve => { deadline = setTimeout(() => resolve({
            status: 'UNAVAILABLE', reason: 'observer collection deadline', deadlineMs: 1000,
          }), 1000); }),
        ]);
      } catch (error) { browserObservation = { status: 'UNAVAILABLE', error: String(error) }; }
      finally { clearTimeout(deadline); }
      page.off('request', requestListener);
      page.off('response', responseListener);
      page.off('requestfailed', failedListener);
      const result = { version: 1, mode: 'passive C4 diagnostic; not certification',
        projectId, timelineId, originalEdit: 'P61 copied-realm edit',
        nodeEvents, nodeOverflow, browserObservation,
        limitation: 'No product assertion, input action, transport request, save delay or timeout is replaced. Missing/overflow observations remain unknown.' };
      // Diagnostic collection must not replace the original assertion/exit.
      try { writeFileSync(path.join(evidence, stamp + '-c4-diagnostic.json'), JSON.stringify(result, null, 2) + '\n'); }
      catch (error) { console.error('C4 diagnostic artifact unavailable:', String(error)); }
      return result;
    },
  };
}
