import { expect, type Page, type Request } from '@playwright/test';
import { commandOutboxes } from './app.ts';

type Capture = { label: string; state: string; pending: boolean };

/** A credential never reaches the page, requests, door answers or browser storage. */
export class TokenSniff {
  private readonly pending: Array<Promise<void>> = [];
  private readonly captures: Capture[] = [];
  private readonly requests = new WeakMap<Request, Capture>();
  private readonly leaks: string[] = [];

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
    this.pending.push(task.finally(() => { capture.pending = false; }));
  }

  attach(page: Page) {
    page.on('request', (request: Request) => {
      const where = this.label(request.method(), request.url(), 'headers');
      const capture: Capture = { label: where, state: 'requested', pending: true };
      this.requests.set(request, capture);
      this.scan(`the URL of ${where}`, request.url());
      this.scan(`the initial headers of ${where}`, JSON.stringify(request.headers()));
      this.scan(`the body of ${where}`, request.postData());
      this.track(capture, request.allHeaders().catch(() => request.headers()).then(headers => {
        this.scan(`the headers of ${where}`, JSON.stringify(headers));
      }));
    });
    page.on('requestfinished', request => { const capture = this.requests.get(request); if (capture) capture.state = 'finished'; });
    page.on('requestfailed', request => { const capture = this.requests.get(request); if (capture) capture.state = 'failed'; });
    page.on('response', (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (!/json|text/.test(type) || !response.url().includes(`:${new URL(response.url()).port}/api/`)) return;
      const capture: Capture = { label: this.label(response.request().method(), response.url(), 'body'), state: 'responded', pending: true };
      this.track(capture, response.text().then(text => this.scan(`the answer to ${capture.label}`, text)).catch(() => {}));
    });
  }

  async expectClean(page: Page, timelineId?: string) {
    const captures = this.captures.slice();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.pending.slice()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(
          `Incomplete credential scan: ${captures.filter(item => item.pending).map(item => `${item.label} (${item.state})`).join(', ')}`
        )), this.drainMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
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
