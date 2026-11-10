import { expect, type Page, type Request, type Route } from '@playwright/test';
import { commandOutboxes } from './app.ts';

type Capture = { label: string; state: string; pending: boolean; failed?: boolean; request?: Request };
type Admission = { state: 'unclassified' | 'dispatched' | 'queued'; terminal: boolean };

/** A credential never reaches the page, requests, door answers or browser storage. */
export class TokenSniff {
  private readonly pending: Array<Promise<void>> = [];
  private readonly captures: Capture[] = [];
  private readonly requests = new WeakMap<Request, Capture>();
  private readonly leaks: string[] = [];
  private readonly admissions = new Map<Request, Admission>();
  private changed: (() => void) | undefined;

  private signal() { this.changed?.(); }

  private isApi(request: Request) { return new URL(request.url()).pathname.startsWith('/api/'); }

  constructor(private readonly tokens: Record<string, string>, private readonly drainMs = 10_000) {}

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
      if (this.isApi(request)) this.admissions.set(request, { state: 'unclassified', terminal: false });
      this.signal();
      const where = this.label(request.method(), request.url(), 'headers');
      const capture: Capture = { label: where, state: 'requested', pending: true, request };
      this.requests.set(request, capture);
      this.scan(`the URL of ${where}`, request.url());
      this.scan(`the initial headers of ${where}`, JSON.stringify(request.headers()));
      this.scan(`the body of ${where}`, request.postData());
      this.track(capture, request.allHeaders().then(headers => {
        this.scan(`the headers of ${where}`, JSON.stringify(headers));
      }));
    });
    page.on('requestfinished', request => { const capture = this.requests.get(request); if (capture) capture.state = 'finished'; const admission = this.admissions.get(request); if (admission) admission.terminal = true; this.signal(); });
    page.on('requestfailed', request => { const capture = this.requests.get(request); if (capture) capture.state = 'failed'; const admission = this.admissions.get(request); if (admission) admission.terminal = true; this.signal(); });
    page.on('response', (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (!/json|text/.test(type) || !response.url().includes(`:${new URL(response.url()).port}/api/`)) return;
      const capture: Capture = { label: this.label(response.request().method(), response.url(), 'body'), state: 'responded', pending: true, request: response.request() };
      this.signal();
      this.track(capture, response.text().then(text => this.scan(`the answer to ${capture.label}`, text)));
    });
    // Interception stays active through navigations. It preserves the request
    // lifecycle for raw-header capture, while falling through to the browser.
    // Playwright disables HTTP caching while routing is enabled.
    await page.route('**/*', route => {
      const admission = this.admissions.get(route.request());
      if (admission) admission.state = 'dispatched';
      this.signal();
      return route.fallback();
    });
  }

  private async drain(include: (capture: Capture) => boolean, waiting: () => boolean = () => false) {
    const deadline = Date.now() + this.drainMs;
    while (true) {
      const captures = this.captures.filter(include);
      const failed = captures.filter(item => item.failed);
      if (failed.length) throw new Error(`Incomplete credential scan: ${failed.map(item => `${item.label} (${item.state}; capture failed)`).join(', ')}`);
      if (!waiting() && !captures.some(item => item.pending)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Incomplete credential scan: ${captures.filter(item => item.pending).map(item => `${item.label} (${item.state})`).join(', ')}; requests still in flight`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.changed = undefined; resolve(); }, remaining);
        this.changed = () => { clearTimeout(timer); this.changed = undefined; resolve(); };
      });
    }
  }

  /** Hold new API dispatch while old-document requests and bodies are captured. */
  async navigate(page: Page, navigate: () => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handler = async (route: Route) => {
      const admission = this.admissions.get(route.request());
      if (admission) admission.state = 'queued';
      this.signal();
      const capture: Capture = { label: this.label(route.request().method(), route.request().url(), 'route'), state: 'queued', pending: true, request: route.request() };
      const task = (async () => { await gate; await route.fallback(); })();
      this.track(capture, task);
      await task.catch(() => {}); // The credential ledger retains a failed disposition.
    };
    await page.route('**/api/**', handler);
    try {
      await this.drain(
        capture => !capture.request || this.admissions.get(capture.request)?.state !== 'queued',
        () => [...this.admissions.values()].some(item => item.state !== 'queued' && !item.terminal),
      );
      await navigate();
    } finally {
      release();
      await page.unroute('**/api/**', handler);
    }
  }

  async expectClean(page: Page, timelineId?: string) {
    await this.drain(() => true);
    const inPage = await page.evaluate(() => JSON.stringify({
      dom: document.documentElement.outerHTML,
      local: Object.fromEntries(Object.entries(window.localStorage)),
      session: Object.fromEntries(Object.entries(window.sessionStorage)),
      cookie: document.cookie,
    }));
    this.scan('the page (DOM, storage, cookies)', inPage);
    if (timelineId) this.scan('native command outboxes', JSON.stringify(await commandOutboxes(page, timelineId)));
    expect(this.leaks, 'no credential reached the page').toEqual([]);
  }
}
