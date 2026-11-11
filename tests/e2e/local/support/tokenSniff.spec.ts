import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { TokenSniff } from './tokenSniff.ts';

const secret = 'credential-sentinel-unique';

function fakePage(contents = '{}', outboxes = '[]') {
  const events = new EventEmitter();
  const frame = {};
  return Object.assign(events, { route: async () => {}, isClosed: () => false, mainFrame: () => frame, evaluate: async (_fn: unknown, id?: string) => id ? outboxes : contents }) as unknown as Page & EventEmitter;
}

test('Chromium captures reload cancellation, held acknowledgement and retry', async ({ page }) => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(origin);
    let held: import('@playwright/test').Route | undefined;
    await page.route('**/api/commit', async route => { await route.fetch(); held = route; });
    const first = page.evaluate(() => fetch('/api/commit', { method: 'POST' }).catch(() => null));
    await expect.poll(() => Boolean(held)).toBe(true);
    await held!.abort('connectionreset');
    await first;
    await page.unroute('**/api/commit');
    let slow: import('@playwright/test').Route | undefined;
    await page.route('**/api/slow', route => { slow = route; });
    await page.evaluate(() => { void fetch('/api/slow').catch(() => {}); });
    await expect.poll(() => Boolean(slow)).toBe(true);
    await page.reload();
    await page.unroute('**/api/slow');
    await page.evaluate(() => fetch('/api/commit', { method: 'POST' }).then(response => response.text()));
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => Promise.all(Array.from({ length: 4 }, () => fetch('/api/app-state/fixture').then(response => response.text()))));
      await page.reload();
    }
    await sniff.expectClean(page);
  } finally { server.close(); }
});

test('pass-through routing retains browser-added HttpOnly cookie headers', async ({ page, context }) => {
  let received = '';
  const server = createServer((req, res) => { received = req.headers.cookie ?? ''; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await context.addCookies([{ name: 'private', value: secret, url: origin, httpOnly: true }]);
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(origin);
    expect(received).toContain(secret);
    await expect(sniff.expectClean(page)).rejects.toThrow('no credential reached the page');
  } finally { server.close(); }
});

test('pass-through routing captures browser-added user-agent headers', async ({ browser }) => {
  let received = '';
  const server = createServer((req, res) => { received = req.headers['user-agent'] ?? ''; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const context = await browser.newContext({ userAgent: secret });
  try {
    const page = await context.newPage();
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    expect(received).toContain(secret);
    await expect(sniff.expectClean(page)).rejects.toThrow('no credential reached the page');
  } finally { await context.close(); server.close(); }
});

function request(url = 'http://localhost:1234/api/health', body = '', headers: Record<string, string> = {}, allHeaders = async () => headers) {
  return { method: () => 'POST', url: () => url, postData: () => body, headers: () => headers, allHeaders } as unknown as Request;
}

test('an unresolved raw-header capture fails closed with a sanitized request label', async () => {
  const page = fakePage();
  const sniff = new TokenSniff({ secret }, 30);
  await sniff.attach(page);
  const req = request(`http://localhost:1234/api/private/${secret}?key=${secret}`, '', {}, () => new Promise(() => {}));
  page.emit('request', req);
  const error = await sniff.expectClean(page).then(() => '', (failure: Error) => failure.message);
  expect(error).toContain('Incomplete credential scan: POST /other headers (requested)');
  expect(error).not.toContain(secret);
});

test('a rejected raw-header capture fails closed', async () => {
  const page = fakePage();
  const sniff = new TokenSniff({ secret });
  await sniff.attach(page);
  const req = request('http://localhost:1234/api/health', '', {}, async () => { throw new Error(secret); });
  page.emit('request', req);
  const error = await sniff.expectClean(page).then(() => '', (failure: Error) => failure.message);
  expect(error).toContain('POST /health headers (requested; capture failed)');
  expect(error).not.toContain(secret);
});

test('a rejected response-body capture fails closed', async () => {
  const page = fakePage();
  const sniff = new TokenSniff({ secret });
  await sniff.attach(page);
  const req = request();
  page.emit('request', req);
  page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => 'http://localhost:1234/api/health', request: () => req, text: async () => { throw new Error(secret); } });
  page.emit('requestfinished', req);
  const error = await sniff.expectClean(page).then(() => '', (failure: Error) => failure.message);
  expect(error).toContain('POST /health body (responded; capture failed)');
  expect(error).not.toContain(secret);
});

for (const where of ['url', 'body', 'initial header', 'full header', 'response', 'dom', 'local', 'session', 'cookie', 'outbox'] as const) {
  test(`detects a credential in ${where}`, async () => {
    const inPage = JSON.stringify({ dom: where === 'dom' ? secret : '', local: { value: where === 'local' ? secret : '' }, session: { value: where === 'session' ? secret : '' }, cookie: where === 'cookie' ? secret : '' });
    const page = fakePage(inPage, where === 'outbox' ? JSON.stringify([{ value: secret }]) : '[]');
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    const req = request(`http://localhost:1234/api/health${where === 'url' ? `?token=${secret}` : ''}`,
      where === 'body' ? secret : '', where === 'initial header' ? { 'x-test': secret } : {},
      async () => where === 'full header' ? { authorization: secret } : {});
    page.emit('request', req);
    if (where === 'response') page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => 'http://localhost:1234/api/health', request: () => req, text: async () => secret });
    page.emit('requestfinished', req);
    await expect(sniff.expectClean(page, 'timeline')).rejects.toThrow('no credential reached the page');
  });
}

test('navigation drains a delayed response while holding new API dispatch', async ({ page }) => {
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  let began = false;
  let queuedReachedServer = false;
  const server = createServer(async (req, res) => {
    if (req.url === '/api/slow') { began = true; res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"value":"'); await delayed; res.end(`${secret}"}`); return; }
    if (req.url === '/api/queued') queuedReachedServer = true;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(origin);
    await page.evaluate(() => { void fetch('/api/slow').catch(() => {}); });
    await expect.poll(() => began).toBe(true);
    let bypassedGate = false;
    await page.route('**/api/queued', route => { bypassedGate = true; return route.fallback(); });
    const originalRoute = page.route.bind(page);
    let gateReady!: () => void;
    const installed = new Promise<void>(resolve => { gateReady = resolve; });
    (page as any).route = async (...args: Parameters<Page['route']>) => {
      await originalRoute(...args);
      if (args[0] === '**/api/**') gateReady();
    };
    let navigated = false;
    const navigation = sniff.navigate(page, async () => { navigated = true; await page.goto(`${origin}/blank`, { waitUntil: 'commit' }); });
    await installed;
    const queued = page.waitForRequest('**/api/queued');
    await page.evaluate(() => { void fetch('/api/queued').catch(() => {}); });
    await queued;
    expect(queuedReachedServer).toBe(false);
    expect(bypassedGate).toBe(false);
    expect(navigated).toBe(false);
    finish();
    await navigation;
    await expect(sniff.expectClean(page)).rejects.toThrow('no credential reached the page');
  } finally { finish(); server.close(); }
});

test('navigation failure releases the gate', async ({ page }) => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(sniff.navigate(page, async () => { throw new Error('navigation failed'); })).rejects.toThrow('navigation failed');
    expect(await page.evaluate(() => fetch('/api/after').then(response => response.text()))).toBe('ok');
    await sniff.expectClean(page);
  } finally { server.close(); }
});

for (const phase of ['DOM', 'outbox'] as const) {
  for (const capture of ['unresolved headers', 'rejected headers', 'delayed headers', 'unresolved body', 'rejected body', 'delayed body'] as const) {
    test(`${capture} starting during ${phase} inspection cannot pass clean`, async () => {
      const page = fakePage();
      const sniff = new TokenSniff({ secret }, 150);
      await sniff.attach(page);
      let started = false;
      page.evaluate = (async (_fn: unknown, id?: string) => {
        if (!started && Boolean(id) === (phase === 'outbox')) {
          started = true;
          const req = request(undefined, '', {}, async () => {
            if (capture === 'unresolved headers') return new Promise(() => {});
            if (capture === 'rejected headers') throw new Error(secret);
            if (capture === 'delayed headers') return new Promise(resolve => setTimeout(() => resolve({ 'x-secret': secret }), 20));
            return {};
          });
          page.emit('request', req);
          if (capture.endsWith('body')) page.emit('response', {
            headers: () => ({ 'content-type': 'application/json' }), url: () => req.url(), request: () => req,
            text: async () => {
              if (capture === 'unresolved body') return new Promise(() => {});
              if (capture === 'rejected body') throw new Error(secret);
              return new Promise(resolve => setTimeout(() => resolve(secret), 20));
            },
          });
          page.emit('requestfinished', req);
        }
        return id ? '[]' : '{}';
      }) as Page['evaluate'];
      const error = await sniff.expectClean(page, 'timeline').then(() => '', (failure: Error) => failure.message);
      expect(started).toBe(true);
      expect(error).toContain(capture.startsWith('delayed') ? 'no credential reached the page' : 'Incomplete credential scan');
      expect(error).not.toContain(secret);
    });
  }

  test(`a response completing after ${phase} inspection requires a fresh page snapshot`, async () => {
    const page = fakePage();
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    let started = false;
    let contents = '{}';
    page.evaluate = (async (_fn: unknown, id?: string) => {
      if (!started && Boolean(id) === (phase === 'outbox')) {
        started = true;
        const req = request();
        page.emit('request', req);
        page.emit('response', {
          headers: () => ({ 'content-type': 'application/json' }), url: () => req.url(), request: () => req,
          text: () => new Promise(resolve => setTimeout(() => { contents = secret; resolve('{}'); }, 20)),
        });
        page.emit('requestfinished', req);
      }
      return id ? '[]' : contents;
    }) as Page['evaluate'];
    await expect(sniff.expectClean(page, 'timeline')).rejects.toThrow('no credential reached the page');
  });

  for (const event of ['navigation', 'close', 'crash'] as const) {
    test(`${event} during ${phase} inspection fails closed`, async () => {
      const page = fakePage();
      const sniff = new TokenSniff({ secret }, 150);
      await sniff.attach(page);
      page.evaluate = (async (_fn: unknown, id?: string) => {
        if (Boolean(id) === (phase === 'outbox')) {
          if (event === 'navigation') page.emit('framenavigated', page.mainFrame());
          else page.emit(event);
          return new Promise(() => {});
        }
        return id ? '[]' : '{}';
      }) as Page['evaluate'];
      await expect(sniff.expectClean(page, 'timeline')).rejects.toThrow('page navigated, closed or crashed during scan');
      expect(page.listenerCount('framenavigated')).toBe(0);
      expect(page.listenerCount('close')).toBe(0);
      expect(page.listenerCount('crash')).toBe(0);
    });
  }

  test(`unresolved ${phase} inspection uses the scan deadline`, async () => {
    const page = fakePage();
    const sniff = new TokenSniff({ secret }, 50);
    await sniff.attach(page);
    page.evaluate = (async (_fn: unknown, id?: string) => Boolean(id) === (phase === 'outbox') ? new Promise(() => {}) : '{}') as Page['evaluate'];
    await expect(sniff.expectClean(page, 'timeline')).rejects.toThrow('unavailable before scan deadline');
  });
}

test('continuous new captures share one overall scan deadline', async () => {
  const page = fakePage();
  const sniff = new TokenSniff({ secret }, 100);
  await sniff.attach(page);
  let reads = 0;
  page.evaluate = (async () => {
    reads++;
    const req = request();
    page.emit('request', req);
    await new Promise(resolve => setTimeout(resolve, 10));
    page.emit('requestfinished', req);
    return '{}';
  }) as Page['evaluate'];
  const start = Date.now();
  await expect(sniff.expectClean(page)).rejects.toThrow('Incomplete credential scan');
  expect(reads).toBeGreaterThan(1);
  expect(Date.now() - start).toBeLessThan(1000);
});

for (const event of ['navigation', 'close'] as const) {
  test(`${event} during capture drain fails closed`, async () => {
    const page = fakePage();
    const sniff = new TokenSniff({ secret }, 1000);
    await sniff.attach(page);
    page.emit('request', request(undefined, '', {}, () => new Promise(() => {})));
    const clean = sniff.expectClean(page);
    if (event === 'navigation') page.emit('framenavigated', page.mainFrame());
    else page.emit(event);
    await expect(clean).rejects.toThrow('page navigated, closed or crashed during scan');
  });
}

test('Chromium drains a response that starts during the final DOM evaluation', async ({ page }) => {
  let finish!: () => void;
  const heldBody = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === '/api/race') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"value":"');
      await heldBody;
      res.end(`${secret}"}`);
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const evaluate = page.evaluate.bind(page);
  try {
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    let read!: () => void;
    const snapshotRead = new Promise<void>(resolve => { read = resolve; });
    let first = true;
    page.evaluate = (async (...args: Parameters<Page['evaluate']>) => {
      if (first) {
        first = false;
        const response = page.waitForResponse('**/api/race');
        await evaluate(() => { void fetch('/api/race').then(res => res.text()).catch(() => {}); });
        await response;
      }
      const value = await evaluate(...args);
      read();
      return value;
    }) as Page['evaluate'];
    let settled = false;
    const clean = sniff.expectClean(page).then(() => { settled = true; return ''; }, (failure: Error) => { settled = true; return failure.message; });
    await snapshotRead;
    await evaluate(() => 0); // Let the scanner consume the completed DOM snapshot.
    expect(settled).toBe(false);
    finish();
    expect(await clean).toContain('no credential reached the page');
  } finally { page.evaluate = evaluate; finish(); server.close(); }
});

for (const headers of ['complete', 'reject', 'unresolved'] as const) {
  test(`navigation checks ${headers} raw headers even after aborting a blocked request`, async () => {
    const page = fakePage();
    const sniff = new TokenSniff({ secret }, 150);
    await sniff.attach(page);
    let handler!: (route: Route) => Promise<void>;
    page.route = (async (_pattern, callback) => { handler = callback as typeof handler; }) as Page['route'];
    page.unroute = async () => {};
    let resolveHeaders!: (value: Record<string, string>) => void;
    let rejectHeaders!: (error: Error) => void;
    const rawHeaders = new Promise<Record<string, string>>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const req = request(undefined, '', {}, () => rawHeaders);
    let aborted = false;
    let navigated = false;
    const navigation = sniff.navigate(page, async () => {
      expect(aborted).toBe(true);
      navigated = true;
    });
    page.emit('request', req);
    const routed = handler({ request: () => req, abort: async () => {
      aborted = true;
      if (headers === 'complete') resolveHeaders({});
      if (headers === 'reject') rejectHeaders(new Error(secret));
      page.emit('requestfailed', req);
    } } as unknown as Route);
    if (headers === 'complete') await navigation;
    else await expect(navigation).rejects.toThrow('Incomplete credential scan');
    await routed;
    expect(navigated).toBe(headers === 'complete');
    expect(aborted).toBe(true);
    if (headers === 'complete') await sniff.expectClean(page);
    else await expect(sniff.expectClean(page)).rejects.toThrow('Incomplete credential scan');
  });
}

test('navigation aborts late gate-owned requests before they can outlive the old document', async ({ page }) => {
  let reachedServer = false;
  const server = createServer((req, res) => {
    if (req.url === '/api/leaving') reachedServer = true;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    let terminal = false;
    page.on('requestfailed', req => { if (req.url().endsWith('/api/leaving')) terminal = true; });
    await sniff.navigate(page, async () => {
      // This request starts after the initial drain, as an unload callback can.
      await page.evaluate(() => { void fetch('/api/leaving', { keepalive: true }).catch(() => {}); });
      await expect.poll(() => terminal).toBe(true);
      expect(reachedServer).toBe(false);
      await page.reload({ waitUntil: 'commit' });
    });
    await sniff.expectClean(page);
    expect(reachedServer).toBe(false);
  } finally { server.close(); }
});

for (const outcome of ['no terminal event', 'abort rejects', 'abort stalls', 'unexpected response'] as const) {
  test(`navigation fails closed when ${outcome}`, async () => {
    const page = fakePage();
    const sniff = new TokenSniff({ secret }, 100);
    await sniff.attach(page);
    let handler!: (route: Route) => Promise<void>;
    page.route = (async (_pattern, callback) => { handler = callback as typeof handler; }) as Page['route'];
    let unrouted = false;
    page.unroute = async () => { unrouted = true; };
    const req = request();
    const navigation = sniff.navigate(page, async () => {});
    page.emit('request', req);
    void handler({ request: () => req,
      fallback: async () => {},
      abort: async () => {
        if (outcome === 'abort rejects') throw new Error(secret);
        if (outcome === 'abort stalls') return new Promise(() => {});
        if (outcome === 'unexpected response') {
          page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => req.url(), request: () => req, text: async () => '{}' });
          page.emit('requestfinished', req);
        }
      },
    } as unknown as Route);
    await expect(navigation).rejects.toThrow('Incomplete credential scan');
    if (outcome === 'abort stalls') expect(unrouted).toBe(false);
    await expect(sniff.expectClean(page)).rejects.toThrow('Incomplete credential scan');
  });
}

test('navigation settles a fixture-held retry under the gate before draining', async ({ page }) => {
  let reachedServer = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) reachedServer = true;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    let held: Route | undefined;
    await page.route('**/api/held', route => { held = route; });
    await page.evaluate(() => { void fetch('/api/held').catch(() => {}); });
    await expect.poll(() => Boolean(held)).toBe(true);
    await sniff.navigate(page, () => page.reload({ waitUntil: 'commit' }), async () => {
      const retryFailed = page.waitForEvent('requestfailed', req => req.url().endsWith('/api/retry'));
      await page.evaluate(() => { void fetch('/api/retry').catch(() => {}); });
      await retryFailed;
      expect(reachedServer).toBe(false);
      await held!.abort('connectionclosed');
    });
    await sniff.expectClean(page);
    expect(reachedServer).toBe(false);
  } finally { server.close(); }
});

test('navigation waits for an observed response body even after its request finishes', async () => {
  const page = fakePage();
  page.unroute = async () => {};
  const sniff = new TokenSniff({ secret }, 500);
  await sniff.attach(page);
  let finish!: (body: string) => void;
  const body = new Promise<string>(resolve => { finish = resolve; });
  const req = request();
  page.emit('request', req);
  page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => req.url(), request: () => req, text: () => body });
  page.emit('requestfinished', req);
  let navigated = false;
  const navigation = sniff.navigate(page, async () => { navigated = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(navigated).toBe(false);
  finish(secret);
  await navigation;
  expect(navigated).toBe(true);
  await expect(sniff.expectClean(page)).rejects.toThrow('no credential reached the page');
});

test('navigation rejects an unavailable observed response body', async () => {
  const page = fakePage();
  page.unroute = async () => {};
  const sniff = new TokenSniff({ secret }, 50);
  await sniff.attach(page);
  const req = request();
  page.emit('request', req);
  page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => req.url(), request: () => req, text: async () => { throw new Error(secret); } });
  page.emit('requestfinished', req);
  let navigated = false;
  await expect(sniff.navigate(page, async () => { navigated = true; })).rejects.toThrow('POST /health body (responded; capture failed)');
  expect(navigated).toBe(false);
});

test('diagnostics correlate lifecycle events without exposing request data or errors', async () => {
  const page = fakePage();
  page.unroute = async () => {};
  const events: Array<Record<string, unknown>> = [];
  const sniff = new TokenSniff({ secret }, 50, event => events.push(event));
  await sniff.attach(page);
  const req = request(`http://localhost:1234/api/private/${secret}?token=${secret}`, secret, { authorization: secret }, async () => { throw new Error(secret); });
  page.emit('request', req);
  page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => req.url(), request: () => req, text: async () => { throw new Error(secret); } });
  page.emit('requestfailed', req);
  page.emit('framenavigated', page.mainFrame());
  await expect(sniff.expectClean(page)).rejects.toThrow('Incomplete credential scan');
  expect(events.map(event => event.event)).toEqual(expect.arrayContaining(['request', 'headers-begin', 'headers-failed', 'body-begin', 'body-failed', 'requestfailed', 'main-frame-committed']));
  expect(new Set(events.filter(event => event.request).map(event => event.request)).size).toBe(1);
  expect(events.find(event => event.event === 'main-frame-committed')?.navigation).toBe(1);
  expect(JSON.stringify(events)).not.toContain(secret);
});

test('diagnostics record gate abort and a missing terminal without inventing an event', async () => {
  const page = fakePage();
  const events: Array<Record<string, unknown>> = [];
  const sniff = new TokenSniff({ secret }, 50, event => events.push(event));
  await sniff.attach(page);
  let handler!: (route: Route) => Promise<void>;
  page.route = (async (_pattern, callback) => { handler = callback as typeof handler; }) as Page['route'];
  page.unroute = async () => {};
  const req = request();
  const navigation = sniff.navigate(page, async () => {});
  page.emit('request', req);
  await handler({ request: () => req, abort: async () => {} } as unknown as Route);
  await expect(navigation).rejects.toThrow('no terminal event');
  expect(events.map(event => event.event)).toEqual(expect.arrayContaining(['gate-entry', 'abort-begin', 'abort-end']));
  expect(events.map(event => event.event)).not.toContain('requestfailed');
  expect(events.map(event => event.event)).not.toContain('requestfinished');
});

test('workflow diagnostic flag emits only sanitized lifecycle records', async () => {
  const previous = process.env.TOKEN_SNIFF_DIAGNOSTICS;
  const originalLog = console.log;
  const lines: string[] = [];
  process.env.TOKEN_SNIFF_DIAGNOSTICS = '1';
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    const page = fakePage();
    const sniff = new TokenSniff({ secret });
    await sniff.attach(page);
    const req = request(`http://localhost:1234/api/${secret}?value=${secret}`, secret, { authorization: secret }, async () => { throw new Error(secret); });
    page.emit('request', req);
    page.emit('requestfailed', req);
    await expect(sniff.expectClean(page)).rejects.toThrow('Incomplete credential scan');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(line => line.startsWith('TOKEN_SNIFF '))).toBe(true);
    expect(lines.join('\n')).not.toContain(secret);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.TOKEN_SNIFF_DIAGNOSTICS;
    else process.env.TOKEN_SNIFF_DIAGNOSTICS = previous;
  }
});
