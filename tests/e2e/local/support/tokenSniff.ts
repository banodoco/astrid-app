import { expect, type Frame, type Page, type Request, type Route } from '@playwright/test';
import { commandOutboxes } from './app.ts';

type Capture = { label: string; state: string; pending: boolean; failed?: boolean; request?: Request };
type Diagnostic = { scanner: number; request?: number; label?: string; event: string; navigation: number; time: number };
let nextScanner = 0;

type Admission = { state: 'unclassified' | 'dispatched' | 'blocked'; terminal: boolean };

/** A credential never reaches the page, requests, door answers or browser storage. */
export class TokenSniff {
  private readonly pending: Array<Promise<void>> = [];
  private readonly captures: Capture[] = [];
  private readonly requests = new WeakMap<Request, Capture>();
  private readonly leaks: string[] = [];
  private readonly admissions = new Map<Request, Admission>();
  private changed: (() => void) | undefined;
  private generation = 0;
  private readonly scannerId = ++nextScanner;
  private nextRequest = 0;
  private navigation = 0;
  private readonly requestIds = new WeakMap<Request, number>();

  private diagnostic(event: string, request?: Request) {
    if (!this.diagnostics) return;
    const id = request && this.requestIds.get(request);
    this.diagnostics({ scanner: this.scannerId, ...(id === undefined ? {} : { request: id }),
      ...(request ? { label: this.label(request.method(), request.url(), 'request') } : {}),
      event, navigation: this.navigation, time: Date.now() });
  }

  private signal() { this.generation++; this.changed?.(); }

  private isApi(request: Request) { return new URL(request.url()).pathname.startsWith('/api/'); }

  // Set TOKEN_SNIFF_DIAGNOSTICS=1 for a sanitized, per-request lifecycle log.
  // Only fixed event names, route categories, local IDs, generations and times are emitted.
  constructor(private readonly tokens: Record<string, string>, private readonly drainMs = 10_000,
    private readonly diagnostics: ((event: Diagnostic) => void) | undefined = process.env.TOKEN_SNIFF_DIAGNOSTICS === '1'
      ? event => console.log(`TOKEN_SNIFF ${JSON.stringify(event)}`) : undefined) {}

  private scan(where: string, text: string | null | undefined) {
    if (!text) return;
    for (const [name, token] of Object.entries(this.tokens)) if (text.includes(token)) this.leaks.push(`${name} token in ${where}`);
  }

  private label(method: string, url: string, phase: string): string {
    const pathname = new URL(url).pathname;
    const route = /\/commit$/.test(pathname) ? '/commit' : /\/health$/.test(pathname) ? '/health'
      : /\/handshake$/.test(pathname) ? '/handshake' : pathname.includes('/app-state/') ? '/app-state/:id'
        : pathname === '/build.json' || pathname === '/install-manifest.json' ? pathname : '/other';
    return `${/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method) ? method : 'OTHER'} ${route} ${phase}`;
  }

  private track(capture: Capture, task: Promise<void>) {
    this.captures.push(capture);
    this.pending.push(task.catch(() => { capture.failed = true; }).finally(() => { capture.pending = false; this.signal(); }));
  }

  async attach(page: Page) {
    page.on('request', (request: Request) => {
      this.requestIds.set(request, ++this.nextRequest);
      this.diagnostic('request', request);
      if (this.diagnostics && request.isNavigationRequest?.() && request.frame() === page.mainFrame())
        this.diagnostic('main-frame-navigation-request', request);
      if (this.isApi(request)) this.admissions.set(request, { state: 'unclassified', terminal: false });
      this.signal();
      const where = this.label(request.method(), request.url(), 'headers');
      const capture: Capture = { label: where, state: 'requested', pending: true, request };
      this.requests.set(request, capture);
      this.scan(`the URL of ${where}`, request.url());
      this.scan(`the initial headers of ${where}`, JSON.stringify(request.headers()));
      this.scan(`the body of ${where}`, request.postData());
      this.diagnostic('headers-begin', request);
      this.track(capture, request.allHeaders().then(headers => {
        this.scan(`the headers of ${where}`, JSON.stringify(headers));
        this.diagnostic('headers-end', request);
      }, error => { this.diagnostic('headers-failed', request); throw error; }));
    });
    page.on('requestfinished', request => { this.diagnostic('requestfinished', request); const capture = this.requests.get(request); if (capture) capture.state = 'finished'; const admission = this.admissions.get(request); if (admission) admission.terminal = true; this.signal(); });
    page.on('requestfailed', request => { this.diagnostic('requestfailed', request); const capture = this.requests.get(request); if (capture) capture.state = 'failed'; const admission = this.admissions.get(request); if (admission) admission.terminal = true; this.signal(); });
    page.on('response', (response) => {
      this.diagnostic('response', response.request());
      if (this.admissions.get(response.request())?.state === 'blocked') {
        this.captures.push({ label: this.label(response.request().method(), response.url(), 'route'), state: 'response after blocked dispatch', pending: false, failed: true });
        this.signal();
      }
      const type = response.headers()['content-type'] ?? '';
      if (!/json|text/.test(type) || !response.url().includes(`:${new URL(response.url()).port}/api/`)) return;
      const capture: Capture = { label: this.label(response.request().method(), response.url(), 'body'), state: 'responded', pending: true, request: response.request() };
      this.signal();
      this.diagnostic('body-begin', response.request());
      this.track(capture, response.text().then(text => {
        this.scan(`the answer to ${capture.label}`, text);
        this.diagnostic('body-end', response.request());
      }, error => { this.diagnostic('body-failed', response.request()); throw error; }));
    });
    if (this.diagnostics) {
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) { this.navigation++; this.diagnostic('main-frame-committed'); }
      });
      page.on('domcontentloaded', () => this.diagnostic('domcontentloaded'));
      page.on('load', () => this.diagnostic('load'));
      page.on('close', () => this.diagnostic('page-close'));
      page.on('crash', () => this.diagnostic('page-crash'));
    }
    // Interception stays active through navigations. It preserves the request
    // lifecycle for raw-header capture, while falling through to the browser.
    // Playwright disables HTTP caching while routing is enabled.
    await page.route('**/*', route => {
      this.diagnostic('route-entry', route.request());
      const admission = this.admissions.get(route.request());
      if (admission) admission.state = 'dispatched';
      this.signal();
      return route.fallback();
    });
  }

  private async drain(include: (capture: Capture) => boolean, waiting: () => boolean = () => false,
    deadline = Date.now() + this.drainMs, assertValid: () => void = () => {}) {
    while (true) {
      assertValid();
      const captures = this.captures.filter(include);
      const failed = captures.filter(item => item.failed);
      if (failed.length) throw new Error(`Incomplete credential scan: ${failed.map(item => `${item.label} (${item.state}; capture failed)`).join(', ')}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.diagnostic('drain-timeout');
        for (const capture of captures) if (capture.pending) {
          const kind = capture.label.endsWith(' headers') ? 'headers' : capture.label.endsWith(' body') ? 'body' : 'route';
          this.diagnostic(`drain-pending-${kind}`, capture.request);
        }
        if (waiting()) for (const [request, admission] of this.admissions) {
          if (!admission.terminal) this.diagnostic(`drain-nonterminal-${admission.state}`, request);
        }
        const outstanding = captures.filter(item => item.pending).map(item => `${item.label} (${item.state})`);
        if (waiting()) for (const [request, admission] of this.admissions) {
          if (!admission.terminal) outstanding.push(`${this.label(request.method(), request.url(), 'request')} (${admission.state}; no terminal event)`);
        }
        throw new Error(`Incomplete credential scan: ${outstanding.join(', ') || 'scan deadline exceeded'}`);
      }
      if (!waiting() && !captures.some(item => item.pending)) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.changed = undefined; resolve(); }, remaining);
        this.changed = () => { clearTimeout(timer); this.changed = undefined; resolve(); };
      });
    }
  }

  /** Stop new API dispatch while old-document requests and bodies are captured. */
  async navigate(page: Page, navigate: () => Promise<unknown>, settleTestRequests?: () => Promise<void>) {
    const deadline = Date.now() + this.drainMs;
    const aborts: Capture[] = [];
    const handler = async (route: Route) => {
      this.diagnostic('gate-entry', route.request());
      const admission = this.admissions.get(route.request());
      if (admission) admission.state = 'blocked';
      this.signal();
      const capture: Capture = { label: this.label(route.request().method(), route.request().url(), 'route'), state: 'aborting', pending: true, request: route.request() };
      aborts.push(capture);
      // In particular, beforeunload requests must not wait for navigation to
      // finish and then fall through from a destroyed document. Abort promptly,
      // but keep requiring real terminal events and every raw-header capture.
      const task = (async () => {
        this.diagnostic('abort-begin', route.request());
        try { await route.abort('aborted'); capture.state = 'aborted'; this.diagnostic('abort-end', route.request()); }
        catch (error) { this.diagnostic('abort-failed', route.request()); throw error; }
      })();
      this.track(capture, task);
      await task.catch(() => {}); // The credential ledger retains a failed disposition.
    };
    await page.route('**/api/**', handler);
    this.diagnostic('gate-installed');
    try {
      // A fault fixture may own a deliberately held request. Settle that hold
      // under the gate so its retry cannot race the old-document drain.
      await settleTestRequests?.();
      await this.drain(() => true, () => [...this.admissions.values()].some(item => !item.terminal), deadline);
      this.diagnostic('navigation-begin');
      try { await navigate(); this.diagnostic('navigation-end'); }
      catch (error) { this.diagnostic('navigation-failed'); throw error; }
      await this.drain(() => true, () => [...this.admissions.values()].some(item => !item.terminal), deadline);
    } finally {
      // Removing a still-running handler can fall through to another route.
      // A failed/stalled abort therefore leaves the gate installed, fail-closed.
      if (aborts.every(capture => !capture.pending && !capture.failed)) {
        await page.unroute('**/api/**', handler);
        this.diagnostic('gate-removed');
      } else this.diagnostic('gate-retained');
    }
  }

  async expectClean(page: Page, timelineId?: string) {
    const deadline = Date.now() + this.drainMs;
    let invalid: Error | undefined;
    let rejectInvalid!: (error: Error) => void;
    const invalidated = new Promise<never>((_resolve, reject) => { rejectInvalid = reject; });
    // A lifecycle event can arrive while drain is waiting rather than snapshot.
    void invalidated.catch(() => {});
    const invalidate = () => {
      invalid ??= new Error('Incomplete credential scan: page navigated, closed or crashed during scan');
      rejectInvalid(invalid);
      this.signal();
    };
    const navigated = (frame: Frame) => { if (frame === page.mainFrame()) invalidate(); };
    const assertValid = () => {
      if (invalid) throw invalid;
      if (page.isClosed()) throw new Error('Incomplete credential scan: page closed');
    };
    const snapshot = async <T>(read: () => Promise<T>, label: string): Promise<T> => {
      assertValid();
      if (Date.now() >= deadline) throw new Error('Incomplete credential scan: scan deadline exceeded');
      let timer!: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          read(), invalidated,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error()), Math.max(0, deadline - Date.now()));
          }),
        ]);
      } catch {
        throw invalid ?? new Error(`Incomplete credential scan: ${label} unavailable before scan deadline`);
      } finally { clearTimeout(timer); }
    };
    page.on('framenavigated', navigated);
    page.on('close', invalidate);
    page.on('crash', invalidate);
    try {
      // Requests can start inside either snapshot. Repeat until a full snapshot
      // and its final drain observe no capture/lifecycle changes. Every pass and
      // read shares one deadline; a busy page cannot extend the scan forever.
      while (true) {
        await this.drain(() => true, () => [...this.admissions.values()].some(item => !item.terminal), deadline, assertValid);
        assertValid();
        const generation = this.generation;
        const inPage = await snapshot(() => page.evaluate(() => JSON.stringify({
          dom: document.documentElement.outerHTML,
          local: Object.fromEntries(Object.entries(window.localStorage)),
          session: Object.fromEntries(Object.entries(window.sessionStorage)),
          cookie: document.cookie,
        })), 'page snapshot');
        assertValid();
        this.scan('the page (DOM, storage, cookies)', inPage);
        if (timelineId) {
          const outboxes = await snapshot(() => commandOutboxes(page, timelineId), 'native command outboxes');
          assertValid();
          this.scan('native command outboxes', JSON.stringify(outboxes));
        }
        await this.drain(() => true, () => [...this.admissions.values()].some(item => !item.terminal), deadline, assertValid);
        assertValid();
        if (generation === this.generation) {
          expect(this.leaks, 'no credential reached the page').toEqual([]);
          return;
        }
      }
    } finally {
      page.off('framenavigated', navigated);
      page.off('close', invalidate);
      page.off('crash', invalidate);
    }
  }
}
