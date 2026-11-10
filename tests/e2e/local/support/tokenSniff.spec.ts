import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { expect, test, type Page, type Request } from '@playwright/test';
import { TokenSniff } from './tokenSniff.ts';

const secret = 'credential-sentinel-unique';

function fakePage(contents = '{}', outboxes = '[]') {
  const events = new EventEmitter();
  return Object.assign(events, { evaluate: async (_fn: unknown, id?: string) => id ? outboxes : contents }) as unknown as Page & EventEmitter;
}

test('Chromium captures reload cancellation, held acknowledgement and retry', async ({ page }) => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(origin);
    const sniff = new TokenSniff({ secret });
    sniff.attach(page);
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
    await page.evaluate(() => fetch('/api/commit', { method: 'POST' }));
    await sniff.expectClean(page);
  } finally { server.close(); }
});

function request(url = 'http://localhost:1234/api/health', body = '', headers: Record<string, string> = {}, allHeaders = async () => headers) {
  return { method: () => 'POST', url: () => url, postData: () => body, headers: () => headers, allHeaders } as unknown as Request;
}

test('an unresolved raw-header capture fails closed with a sanitized request label', async () => {
  const page = fakePage();
  const sniff = new TokenSniff({ secret }, 30);
  sniff.attach(page);
  page.emit('request', request(`http://localhost:1234/api/private/${secret}?key=${secret}`, '', {}, () => new Promise(() => {})));
  const error = await sniff.expectClean(page).then(() => '', (failure: Error) => failure.message);
  expect(error).toContain('Incomplete credential scan: POST /other headers (requested)');
  expect(error).not.toContain(secret);
});

for (const where of ['url', 'body', 'initial header', 'full header', 'response', 'dom', 'local', 'session', 'cookie', 'outbox'] as const) {
  test(`detects a credential in ${where}`, async () => {
    const inPage = JSON.stringify({ dom: where === 'dom' ? secret : '', local: { value: where === 'local' ? secret : '' }, session: { value: where === 'session' ? secret : '' }, cookie: where === 'cookie' ? secret : '' });
    const page = fakePage(inPage, where === 'outbox' ? JSON.stringify([{ value: secret }]) : '[]');
    const sniff = new TokenSniff({ secret });
    sniff.attach(page);
    const req = request(`http://localhost:1234/api/health${where === 'url' ? `?token=${secret}` : ''}`,
      where === 'body' ? secret : '', where === 'initial header' ? { 'x-test': secret } : {},
      async () => where === 'full header' ? { authorization: secret } : {});
    page.emit('request', req);
    if (where === 'response') page.emit('response', { headers: () => ({ 'content-type': 'application/json' }), url: () => 'http://localhost:1234/api/health', request: () => req, text: async () => secret });
    await expect(sniff.expectClean(page, 'timeline')).rejects.toThrow('no credential reached the page');
  });
}
