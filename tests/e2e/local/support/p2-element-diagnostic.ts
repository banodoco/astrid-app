import { rename, writeFile } from 'node:fs/promises';
import type { BrowserContext, Page, Request, Response } from '@playwright/test';
import { withDiagnosticDeadline } from '../p1-diagnostic-safety.ts';

export const P2_ELEMENT_DIAGNOSTIC_FILE = 'p2-element-apply-diagnostic.json';
const MAX_EVENTS = 24;
const MAX_BYTES = 24 * 1024;
const MAX_PENDING_REQUESTS = 8;
const RETENTION_TIMEOUT_MS = 500;
const UI_READ_TIMEOUT_MS = 150;

type Correlation = `apply-${number}`;
export type ElementApplyDiagnosticStage = 'apply-click' | 'request-start' | 'response' | 'request-failed' | 'request-finished' | 'test-outcome' | 'teardown-start' | 'page-close' | 'retained';
export type ElementApplyTerminal = 'unknown' | 'pending' | 'aborted' | 'failed' | 'accepted';
type RequestObservation = 'not-observed' | 'scoped-commit';
type FailureKind = 'none' | 'aborted' | 'failed' | 'unknown';
type ResponseKind = 'none' | 'success' | 'failure' | 'other';
type UiStage = 'apply' | 'request-pending' | 'response-received' | 'failure' | 'aborted' | 'retained' | 'closed' | 'unknown';
type UiConnection = 'connected' | 'disconnected' | 'unknown';
type UiDialog = 'present' | 'absent' | 'unknown';
type UiStatus = 'applied' | 'pending' | 'failed' | 'unknown';
type UiApplyButton = 'idle' | 'applying' | 'applied' | 'refused' | 'unknown';

export type ElementApplyUiState = {
  stage: UiStage;
  connection: UiConnection;
  dialog: UiDialog;
  status: UiStatus;
  applyButton: UiApplyButton;
};

export type ElementApplyDiagnosticEvent = {
  version: 1;
  sequence: number;
  elapsedMs: number;
  stage: ElementApplyDiagnosticStage;
  correlation: Correlation | 'none';
  request: RequestObservation;
  idempotencyKey: 'present' | 'absent' | 'unknown';
  responseStatus: number | 'UNKNOWN';
  response: ResponseKind;
  failure: FailureKind;
  terminal: ElementApplyTerminal;
  ui: ElementApplyUiState;
};

export type ElementApplyDiagnosticSnapshot = {
  version: 1;
  kind: 'p2-element-apply-lifecycle';
  events: ElementApplyDiagnosticEvent[];
  terminal: ElementApplyTerminal;
  pageClosed: boolean;
};

export type ElementApplyDiagnosticArtifact = {
  version: 1;
  kind: 'p2-element-apply-lifecycle';
  status: 'observed' | 'UNKNOWN';
  lifecycle: {
    testOutcome: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'unknown';
    beforePageClose: boolean;
    pageClosed: boolean;
  };
  diagnostic: ElementApplyDiagnosticSnapshot | 'UNKNOWN';
  losses: { write: boolean; events: boolean; ui: boolean };
};

type DiagnosticTestInfo = {
  status?: unknown;
  outputPath(...pathSegments: string[]): string;
  attach(name: string, options: { path: string; contentType: string }): Promise<void>;
};

const UNKNOWN_UI: ElementApplyUiState = Object.freeze({ stage: 'unknown', connection: 'unknown', dialog: 'unknown', status: 'unknown', applyButton: 'unknown' });

function boundedElapsed(startedAt: number): number {
  const value = Date.now() - startedAt;
  return Number.isSafeInteger(value) && value >= 0 && value <= 600_000 ? value : 600_000;
}

function statusCode(value: unknown): number | 'UNKNOWN' {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : 'UNKNOWN';
}

function requestFailureKind(request: Request): FailureKind {
  try {
    const text = request.failure()?.errorText?.toLowerCase() ?? '';
    if (text.includes('abort') || text.includes('cancel') || text.includes('timeout')) return 'aborted';
    if (text) return 'failed';
  } catch { /* A failed request may no longer expose failure metadata. */ }
  return 'unknown';
}

function isCommitRequest(request: Request): boolean {
  try {
    return request.method() === 'POST' && /^\/(?:api\/runtime\/)?v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/.test(new URL(request.url()).pathname);
  } catch {
    return false;
  }
}

function requestBody(request: Request): Record<string, unknown> | undefined {
  try {
    const value = request.postDataJSON();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The catalog Apply request's authenticated provenance and patch shape, not a UI alias, selects the target. */
function isElementApplyRequest(request: Request): boolean {
  const body = requestBody(request);
  if (!isCommitRequest(request) || keyPresence(request) !== 'present' || !body || body.api_version !== 1 || body.label !== 'Edit timeline'
    || body.merge !== 'atomic' || body.dry_run !== false || typeof body.project_id !== 'string'
    || typeof body.timeline_id !== 'string' || typeof body.base_revision_id !== 'string'
    || typeof body.base_publication_id !== 'string') return false;
  const source = body.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) || (source as Record<string, unknown>).via !== 'app') return false;
  const commands = body.commands;
  const steps = body.steps;
  if (!Array.isArray(commands) || commands.length !== 1 || !Array.isArray(steps) || steps.length !== 1) return false;
  const command = commands[0];
  const step = steps[0];
  if (!command || typeof command !== 'object' || Array.isArray(command) || !step || typeof step !== 'object' || Array.isArray(step)) return false;
  const commandRecord = command as Record<string, unknown>;
  const stepRecord = step as Record<string, unknown>;
  const args = commandRecord.args;
  const changes = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>).changes : undefined;
  const firstChange = Array.isArray(changes) && changes.length === 1 ? changes[0] : undefined;
  const change = firstChange && typeof firstChange === 'object' && !Array.isArray(firstChange) ? firstChange as Record<string, unknown> : undefined;
  const path = change?.path;
  return commandRecord.schema_version === 1 && commandRecord.op === 'doc.patch' && commandRecord.version === '1'
    && commandRecord.select === null && Array.isArray(commandRecord.created)
    && stepRecord.intent === 'timeline.apply_element' && Array.isArray(stepRecord.command_ordinals)
    && stepRecord.command_ordinals.length === 1 && stepRecord.command_ordinals[0] === 0
    && Array.isArray(changes) && Array.isArray(stepRecord.patch) && Array.isArray(stepRecord.reads)
    && stepRecord.patch.length === changes.length
    && change?.op === 'list.insert' && change.ref === 'parent' && Array.isArray(path)
    && path.length > 0 && path.every((part) => typeof part === 'string') && path.at(-1) === 'clips';
}

function keyPresence(request: Request): 'present' | 'absent' | 'unknown' {
  try {
    return request.headers()['idempotency-key'] ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

function responseOutcome(status: number | 'UNKNOWN'): { response: ResponseKind; terminal: ElementApplyTerminal } {
  if (status === 'UNKNOWN') return { response: 'other', terminal: 'unknown' };
  if (status >= 200 && status <= 299) return { response: 'success', terminal: 'accepted' };
  if (status >= 400 && status <= 599) return { response: 'failure', terminal: 'failed' };
  return { response: 'other', terminal: 'unknown' };
}

function stateFor(stage: ElementApplyDiagnosticStage, terminal: ElementApplyTerminal): ElementApplyUiState {
  const uiStage: UiStage = stage === 'apply-click' ? 'apply'
    : stage === 'request-start' ? 'request-pending'
      : stage === 'response' ? 'response-received'
        : stage === 'request-failed' || terminal === 'failed' ? 'failure'
          : stage === 'page-close' ? 'closed' : terminal === 'aborted' ? 'aborted'
            : stage === 'retained' ? 'retained' : 'unknown';
  return { ...UNKNOWN_UI, stage: uiStage };
}

function safeUiState(value: unknown): ElementApplyUiState {
  if (value === UNKNOWN_UI || !value || typeof value !== 'object' || Array.isArray(value)) return UNKNOWN_UI;
  const source = value as Record<string, unknown>;
  const stage = ['apply', 'request-pending', 'response-received', 'failure', 'aborted', 'retained', 'closed', 'unknown'].includes(source.stage as string)
    ? source.stage as UiStage : 'unknown';
  const connection = ['connected', 'disconnected', 'unknown'].includes(source.connection as string)
    ? source.connection as UiConnection : 'unknown';
  const dialog = ['present', 'absent', 'unknown'].includes(source.dialog as string)
    ? source.dialog as UiDialog : 'unknown';
  const status = ['applied', 'pending', 'failed', 'unknown'].includes(source.status as string)
    ? source.status as UiStatus : 'unknown';
  const applyButton = ['idle', 'applying', 'applied', 'refused', 'unknown'].includes(source.applyButton as string)
    ? source.applyButton as UiApplyButton : 'unknown';
  return { stage, connection, dialog, status, applyButton };
}

export function elementApplyUiScript(): string {
  return `(() => {
    const installKey = '__timelineP2ElementApplyBoundaryInstalled';
    if (window[installKey]) return;
    window[installKey] = true;
    document.addEventListener('click', (event) => {
      try {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('button');
        if (!button || (button.textContent || '').replace(/\\s+/g, ' ').trim() !== 'Apply') return;
        window.__timelineP2ElementApplyButton = button;
        const notify = window.__timelineP2ElementApplyBoundary;
        if (typeof notify === 'function') void notify({ kind: 'apply-click' });
      } catch { /* Boundary observation is disposable. */ }
    }, true);
  })();`;
}

export function readElementApplyUiState(terminal: ElementApplyTerminal = 'unknown'): ElementApplyUiState {
  try {
    const unknownUi: ElementApplyUiState = { stage: 'unknown', connection: 'unknown', dialog: 'unknown', status: 'unknown', applyButton: 'unknown' };
    const connectionNode = document.querySelector('[data-testid="runtime-connection-status"]');
    const connectionValue = connectionNode?.getAttribute('data-state');
    const connection: UiConnection = connectionValue === 'connected' ? 'connected' : connectionValue === 'disconnected' ? 'disconnected' : 'unknown';
    const dialog = document.querySelector('[role="dialog"]');
    const button = (globalThis as { __timelineP2ElementApplyButton?: unknown }).__timelineP2ElementApplyButton;
    let applyButton: UiApplyButton = 'unknown';
    if (button && typeof button === 'object' && typeof (button as { closest?: unknown }).closest === 'function') {
      const owner = (button as { closest(selector: string): unknown }).closest('[role="dialog"]');
      if (dialog && owner === dialog) {
        applyButton = terminal === 'accepted' ? 'applied'
          : terminal === 'failed' || terminal === 'aborted' ? 'refused'
            : (button as { disabled?: unknown }).disabled === true ? 'applying' : 'idle';
      }
    }
    const status: UiStatus = applyButton === 'applied' ? 'applied'
      : applyButton === 'applying' ? 'pending'
        : applyButton === 'refused' ? 'failed' : 'unknown';
    return { stage: 'retained', connection, dialog: dialog ? 'present' : 'absent', status, applyButton };
  } catch {
    return { stage: 'unknown', connection: 'unknown', dialog: 'unknown', status: 'unknown', applyButton: 'unknown' };
  }
}

export class ElementApplyDiagnosticCollector {
  private readonly startedAt = Date.now();
  private readonly events: ElementApplyDiagnosticEvent[] = [];
  private readonly pendingRequests: Array<{ request: Request; response?: Response; failure?: FailureKind; finished?: boolean }> = [];
  private active?: { correlation: Correlation; request?: Request; terminal: ElementApplyTerminal };
  private applyOrdinal = 0;
  private closed = false;
  private sequence = 0;
  private lostEvents = false;
  private changed?: () => void;

  onChange(listener?: () => void): void { this.changed = listener; }
  get eventsLost(): boolean { return this.lostEvents; }

  recordApplyClick(): void {
    this.applyOrdinal += 1;
    const correlation = `apply-${this.applyOrdinal}` as Correlation;
    this.active = { correlation, terminal: 'unknown' };
    this.record({ stage: 'apply-click', correlation, request: 'not-observed', idempotencyKey: 'unknown', responseStatus: 'UNKNOWN', response: 'none', failure: 'none', terminal: 'unknown' });
    const candidate = this.pendingRequests.pop();
    if (candidate) this.bindRequest(candidate);
  }

  recordRequest(request: Request): void {
    if (!isElementApplyRequest(request)) return;
    const candidate = this.pendingRequests.find((entry) => entry.request === request) ?? this.rememberRequest(request);
    if (this.active && !this.active.request && candidate) this.bindRequest(candidate);
  }

  recordResponse(response: Response): void {
    const request = response.request();
    if (!isElementApplyRequest(request)) return;
    if (!this.active?.request || request !== this.active.request) {
      const candidate = this.pendingRequests.find((entry) => entry.request === request);
      if (candidate) candidate.response = response;
      else this.recordEventLoss();
      return;
    }
    if (this.active.terminal !== 'pending') return;
    const status = statusCode(response.status());
    const outcome = responseOutcome(status);
    this.active.terminal = outcome.terminal;
    this.record({ stage: 'response', correlation: this.active.correlation, request: 'scoped-commit', idempotencyKey: keyPresence(this.active.request), responseStatus: status, response: outcome.response, failure: outcome.terminal === 'failed' ? 'failed' : 'none', terminal: outcome.terminal });
  }

  recordRequestFailed(request: Request): void {
    if (!isElementApplyRequest(request)) return;
    if (!this.active?.request || request !== this.active.request) {
      const candidate = this.pendingRequests.find((entry) => entry.request === request);
      if (candidate) candidate.failure = requestFailureKind(request);
      else this.recordEventLoss();
      return;
    }
    const failure = requestFailureKind(request);
    const terminal: ElementApplyTerminal = failure === 'aborted' ? 'aborted' : failure === 'failed' ? 'failed' : 'unknown';
    this.active.terminal = terminal;
    this.record({ stage: 'request-failed', correlation: this.active.correlation, request: 'scoped-commit', idempotencyKey: keyPresence(request), responseStatus: 'UNKNOWN', response: 'none', failure, terminal });
  }

  recordRequestFinished(request: Request): void {
    if (!isElementApplyRequest(request)) return;
    if (!this.active?.request || request !== this.active.request) {
      const candidate = this.pendingRequests.find((entry) => entry.request === request);
      if (candidate) candidate.finished = true;
      else this.recordEventLoss();
      return;
    }
    // Transport completion alone does not establish a server acceptance.
    if (this.active.terminal === 'pending') this.active.terminal = 'unknown';
    this.recordLifecycle('request-finished');
  }

  recordPageClose(): void {
    this.closed = true;
    this.recordLifecycle('page-close');
  }

  recordLifecycle(stage: 'request-finished' | 'test-outcome' | 'teardown-start' | 'page-close' | 'retained', ui?: ElementApplyUiState): void {
    if (!this.active) return;
    this.record({ stage, correlation: this.active.correlation, request: this.active.request ? 'scoped-commit' : 'not-observed', idempotencyKey: this.active.request ? keyPresence(this.active.request) : 'unknown', responseStatus: 'UNKNOWN', response: 'none', failure: 'none', terminal: this.active.terminal }, ui);
  }

  get hasApplyBoundary(): boolean { return this.events.length > 0; }

  snapshot(): ElementApplyDiagnosticSnapshot {
    const events = this.events.slice(0, MAX_EVENTS).map((event) => ({ ...event, ui: { ...event.ui } }));
    return { version: 1, kind: 'p2-element-apply-lifecycle', events, terminal: this.active?.terminal ?? 'unknown', pageClosed: this.closed };
  }

  recordRetained(ui: ElementApplyUiState = UNKNOWN_UI): void {
    this.recordLifecycle('retained', safeUiState(ui));
  }

  private record(input: Omit<ElementApplyDiagnosticEvent, 'version' | 'sequence' | 'elapsedMs' | 'ui'>, ui?: ElementApplyUiState): void {
    if (this.events.length >= MAX_EVENTS) {
      this.events.splice(1, 1);
      this.lostEvents = true;
    }
    this.events.push({ version: 1, sequence: ++this.sequence, elapsedMs: boundedElapsed(this.startedAt), ...input, ui: ui ? safeUiState(ui) : stateFor(input.stage, input.terminal) });
    this.changed?.();
  }

  private recordEventLoss(): void { this.lostEvents = true; this.changed?.(); }

  private rememberRequest(request: Request): { request: Request; response?: Response; failure?: FailureKind; finished?: boolean } {
    if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) { this.pendingRequests.shift(); this.lostEvents = true; }
    const candidate = { request };
    this.pendingRequests.push(candidate);
    return candidate;
  }

  private bindRequest(candidate: { request: Request; response?: Response; failure?: FailureKind; finished?: boolean }): void {
    if (!this.active || this.active.request) return;
    const pendingIndex = this.pendingRequests.indexOf(candidate);
    if (pendingIndex >= 0) this.pendingRequests.splice(pendingIndex, 1);
    this.active.request = candidate.request;
    this.active.terminal = 'pending';
    this.record({ stage: 'request-start', correlation: this.active.correlation, request: 'scoped-commit', idempotencyKey: keyPresence(candidate.request), responseStatus: 'UNKNOWN', response: 'none', failure: 'none', terminal: 'pending' });
    if (candidate.failure) this.recordRequestFailed(candidate.request);
    else if (candidate.response) this.recordResponse(candidate.response);
    if (candidate.finished) this.recordRequestFinished(candidate.request);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function testOutcome(value: unknown): ElementApplyDiagnosticArtifact['lifecycle']['testOutcome'] {
  return enumValue(value, ['passed', 'failed', 'timedOut', 'skipped', 'interrupted', 'unknown'], 'unknown');
}

/** Rebuild every nested object at the file boundary; never stringify caller-owned data. */
export function serializeElementApplyDiagnostic(value: unknown): string {
  try { return projectElementApplyDiagnostic(value); }
  catch { return `${JSON.stringify({ version: 1, kind: 'p2-element-apply-lifecycle', status: 'UNKNOWN', lifecycle: { testOutcome: 'unknown', beforePageClose: false, pageClosed: false }, diagnostic: 'UNKNOWN', losses: { write: false, events: true, ui: true } })}\n`; }
}

function projectElementApplyDiagnostic(value: unknown): string {
  const source = recordValue(value);
  const lifecycle = recordValue(source.lifecycle);
  const losses = recordValue(source.losses);
  const snapshot = recordValue(source.diagnostic);
  let eventLoss = losses.events === true;
  let uiLoss = losses.ui === true;
  const events: ElementApplyDiagnosticEvent[] = [];
  if (snapshot.version === 1 && snapshot.kind === 'p2-element-apply-lifecycle' && Array.isArray(snapshot.events)) {
    if (snapshot.events.length > MAX_EVENTS) eventLoss = true;
    let previousSequence = 0;
    for (const value of snapshot.events.slice(-MAX_EVENTS)) {
      const event = recordValue(value);
      const stage = enumValue(event.stage, ['apply-click', 'request-start', 'response', 'request-failed', 'request-finished', 'test-outcome', 'teardown-start', 'page-close', 'retained'], 'retained');
      const terminal = enumValue(event.terminal, ['unknown', 'pending', 'aborted', 'failed', 'accepted'], 'unknown');
      const request = enumValue(event.request, ['not-observed', 'scoped-commit'], 'not-observed');
      const idempotencyKey = enumValue(event.idempotencyKey, ['present', 'absent', 'unknown'], 'unknown');
      const response = enumValue(event.response, ['none', 'success', 'failure', 'other'], 'other');
      const failure = enumValue(event.failure, ['none', 'aborted', 'failed', 'unknown'], 'unknown');
      const correlation = typeof event.correlation === 'string' && /^apply-[1-9][0-9]{0,5}$/.test(event.correlation) ? event.correlation as Correlation : 'none';
      const ui = safeUiState(event.ui);
      if (!Object.entries(ui).every(([key, value]) => recordValue(event.ui)[key] === value)) uiLoss = true;
      if (event.version !== 1 || stage !== event.stage || terminal !== event.terminal || request !== event.request
        || idempotencyKey !== event.idempotencyKey || response !== event.response || failure !== event.failure
        || (correlation === 'none' && event.correlation !== 'none')
        || !Number.isSafeInteger(event.sequence) || (event.sequence as number) <= previousSequence || (event.sequence as number) > 1_000_000
        || !Number.isSafeInteger(event.elapsedMs) || (event.elapsedMs as number) < 0 || (event.elapsedMs as number) > 600_000
        || (event.responseStatus !== 'UNKNOWN' && statusCode(event.responseStatus) === 'UNKNOWN')) {
        eventLoss = true;
        continue;
      }
      previousSequence = event.sequence as number;
      events.push({ version: 1, sequence: event.sequence as number, elapsedMs: event.elapsedMs as number, stage, correlation, request, idempotencyKey,
        responseStatus: statusCode(event.responseStatus), response, failure, terminal, ui });
    }
  } else eventLoss = true;
  if (!['unknown', 'pending', 'aborted', 'failed', 'accepted'].includes(snapshot.terminal as string) || typeof snapshot.pageClosed !== 'boolean') eventLoss = true;
  const diagnostic: ElementApplyDiagnosticArtifact['diagnostic'] = snapshot.version === 1 && snapshot.kind === 'p2-element-apply-lifecycle' && Array.isArray(snapshot.events)
    ? { version: 1, kind: 'p2-element-apply-lifecycle', events, terminal: enumValue(snapshot.terminal, ['unknown', 'pending', 'aborted', 'failed', 'accepted'], 'unknown'), pageClosed: snapshot.pageClosed === true }
    : 'UNKNOWN';
  const artifact: ElementApplyDiagnosticArtifact = {
    version: 1, kind: 'p2-element-apply-lifecycle', status: diagnostic === 'UNKNOWN' ? 'UNKNOWN' : 'observed',
    lifecycle: { testOutcome: testOutcome(lifecycle.testOutcome), beforePageClose: lifecycle.beforePageClose === true, pageClosed: lifecycle.pageClosed === true },
    diagnostic, losses: { write: losses.write === true, events: eventLoss, ui: uiLoss },
  };
  const text = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(text, 'utf8') <= MAX_BYTES) return text;
  return `${JSON.stringify({ ...artifact, status: 'UNKNOWN', diagnostic: 'UNKNOWN', losses: { ...artifact.losses, events: true } })}\n`;
}

type Retention = {
  finish(): Promise<boolean>;
};
const retentions = new WeakMap<ElementApplyDiagnosticCollector, Retention>();

export async function retainElementApplyDiagnostic(
  testInfo: DiagnosticTestInfo,
  page: Pick<Page, 'evaluate'> | undefined,
  collector: ElementApplyDiagnosticCollector,
  outcome: unknown,
  phase: 'initial' | 'final' = 'final',
): Promise<boolean> {
  if (!collector.hasApplyBoundary) return false;
  const existing = retentions.get(collector);
  if (existing) return phase === 'final' ? existing.finish() : true;
  const deadline = Date.now() + RETENTION_TIMEOUT_MS;
  try {
    const output = testInfo.outputPath(P2_ELEMENT_DIAGNOSTIC_FILE);
    const beforePageClose = !collector.snapshot().pageClosed;
    let ui = UNKNOWN_UI;
    let writeLoss = false;
    let uiLoss = true;
    let writes = Promise.resolve(true);
    let writing = false;
    let queued: ElementApplyDiagnosticArtifact | undefined;
    const persist = () => {
      const snapshot = collector.snapshot();
      queued = {
        version: 1, kind: 'p2-element-apply-lifecycle', status: 'observed',
        lifecycle: { testOutcome: testOutcome(outcome), beforePageClose, pageClosed: snapshot.pageClosed },
        diagnostic: snapshot, losses: { write: writeLoss, events: collector.eventsLost, ui: uiLoss },
      };
      if (writing) return;
      writing = true;
      writes = (async () => {
        let wrote = false;
        while (queued) {
          const artifact = queued;
          queued = undefined;
          try {
            artifact.losses.write ||= writeLoss;
            await writeFile(`${output}.tmp`, serializeElementApplyDiagnostic(artifact), { encoding: 'utf8', mode: 0o600 });
            await rename(`${output}.tmp`, output);
            wrote = true;
          } catch { writeLoss = true; wrote = false; }
        }
        writing = false;
        return wrote;
      })();
    };
    collector.onChange(persist);
    collector.recordLifecycle('test-outcome');
    if (page && beforePageClose) {
      const sampled = await withDiagnosticDeadline(() => page.evaluate(readElementApplyUiState, collector.snapshot().terminal), UNKNOWN_UI, UI_READ_TIMEOUT_MS);
      ui = safeUiState(sampled);
      uiLoss = ui === UNKNOWN_UI || !Object.entries(ui).every(([key, value]) => recordValue(sampled)[key] === value);
    }
    collector.recordRetained(ui);
    const retention: Retention = {
      async finish() {
        const deadline = Date.now() + RETENTION_TIMEOUT_MS;
        // The context has delivered its final protocol events before this seals the file.
        collector.onChange(undefined);
        persist();
        if (!await withDiagnosticDeadline(() => writes, false, RETENTION_TIMEOUT_MS)) return false;
        return withDiagnosticDeadline(async () => {
          await testInfo.attach(P2_ELEMENT_DIAGNOSTIC_FILE, { path: output, contentType: 'application/json' });
          return true;
        }, false, Math.max(0, deadline - Date.now()));
      },
    };
    retentions.set(collector, retention);
    if (phase === 'final') return await retention.finish();
    return await withDiagnosticDeadline(() => writes, false, Math.max(0, deadline - Date.now()));
  } catch {
    return false;
  }
}

const contextCollectors = new WeakMap<BrowserContext, Array<{ collector: ElementApplyDiagnosticCollector; testInfo: DiagnosticTestInfo }>>();

/** These callbacks are the real App page/context fixtures, also exercised without a browser. */
export async function elementApplyDiagnosticPageFixture(
  { context }: { context: BrowserContext }, use: (page: Page) => Promise<void>, testInfo: DiagnosticTestInfo,
): Promise<void> {
  const page = await context.newPage();
  const collector = new ElementApplyDiagnosticCollector();
  const entries = contextCollectors.get(context) ?? [];
  entries.push({ collector, testInfo });
  contextCollectors.set(context, entries);
  try {
    await installElementApplyDiagnostic(page, collector);
    await use(page);
  } finally {
    await retainElementApplyDiagnostic(testInfo, page, collector, testInfo.status, 'initial');
    collector.recordLifecycle('teardown-start');
    await page.close().catch(() => {});
  }
}

export async function closeElementApplyDiagnosticContext(context: BrowserContext): Promise<void> {
  try { await context.close(); }
  finally {
    for (const { collector, testInfo } of contextCollectors.get(context) ?? []) {
      await retainElementApplyDiagnostic(testInfo, undefined, collector, testInfo.status, 'final');
    }
    contextCollectors.delete(context);
  }
}

export async function installElementApplyDiagnostic(page: Page, collector: ElementApplyDiagnosticCollector): Promise<void> {
  page.on('request', (request) => collector.recordRequest(request));
  page.on('response', (response) => collector.recordResponse(response));
  page.on('requestfinished', (request) => collector.recordRequestFinished(request));
  page.on('requestfailed', (request) => collector.recordRequestFailed(request));
  page.on('close', () => collector.recordPageClose());
  const expose = page.exposeFunction('__timelineP2ElementApplyBoundary', () => collector.recordApplyClick()).catch(() => {});
  const init = page.addInitScript({ content: elementApplyUiScript() }).catch(() => {});
  await Promise.all([expose, init]);
}
