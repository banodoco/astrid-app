import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const title = 'How do you want Astrid to think?';
const composer = (page: Page) => page.locator('[data-editor-tour="chat-composer"] textarea').first();
const card = (page: Page) => page.getByRole('region', { name: title });
const captures = resolve('test-results/agent-setup');
const fakeOrigin = () => `http://127.0.0.1:${process.env.FAKE_RUNTIME_PORT}`;
const headers = () => ({ Authorization: `Bearer ${readFileSync(process.env.FAKE_RUNTIME_TOKEN_FILE!, 'utf8').trim()}` });

// Each journey owns the shared fake's state. Do not race scenario controls in parallel workers.
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 1000 } });
test.setTimeout(120_000);

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      // The app follows its sky clock, so select its real theme preference as well.
      await page.addInitScript(hour => {
        localStorage.setItem('theme-hour', String(hour));
        localStorage.setItem('astrid.tasks-pane-locked.v1', 'true');
      }, theme === 'dark' ? 0 : 12);
    });
    async function shot(page: Page, scenario: string, step: string) {
      mkdirSync(captures, { recursive: true });
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*\bdark\b)/);
      await page.screenshot({ path: resolve(captures, `${scenario}-${step}-${theme}.png`), fullPage: true });
    }
    async function open(page: Page, scenario: string) {
      const reset = await page.request.post(`${fakeOrigin()}/__test/reset`, { headers: headers() });
      expect(reset.ok()).toBe(true);
      await control(page, { scenario });
      await page.goto('/tools/video-editor?runtime=1&runtimeProject=demo-project-id&runtimeTimeline=demo-timeline&localTest=1', { waitUntil: 'domcontentloaded' });
      await expect(card(page)).toBeVisible({ timeout: 90_000 });
      await shot(page, scenario, 'choose');
    }
    async function control(page: Page, data: Record<string, unknown>) {
      const result = await page.request.post(`${fakeOrigin()}/__test/agent-setup`, { headers: headers(), data });
      expect(result.ok()).toBe(true);
    }
    async function done(page: Page, scenario: string, name: string) {
      await expect(page.getByText(`Getting ${name} ready…`, { exact: true })).toBeVisible({ timeout: 10_000 });
      await shot(page, scenario, 'starting');
      await expect(page.getByText(`✓ ${name} is set up.`, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(composer(page)).toBeEnabled();
      await expect(composer(page)).toBeFocused();
      await shot(page, scenario, 'done');
    }
    async function hi(page: Page, scenario: string, terminalCommand?: string) {
      await composer(page).fill('hi');
      await shot(page, scenario, 'message');
      await composer(page).press('Enter');
      await expect(page.getByText("Hi! I'm ready.", { exact: true })).toBeVisible({ timeout: 20_000 });
      await shot(page, scenario, 'reply');
      if (!terminalCommand) return;
      // The terminal note follows the first reply once, with the agent row's command and the open project.
      const nudge = page.getByRole('region', { name: 'You can also talk to Astrid from your terminal' });
      await expect(nudge).toBeVisible({ timeout: 10_000 });
      await expect(nudge.locator("code")).toHaveText(terminalCommand);
      await expect(nudge).toContainText('Updated "Demo Project"');
      await shot(page, scenario, 'nudge');
      await nudge.getByRole('button', { name: 'Close' }).click();
      await expect(nudge).toHaveCount(0);
      await page.getByRole('button', { name: /^Chat:/ }).click();
      await page.getByRole('button', { name: 'Use from your terminal' }).click();
      await expect(nudge).toBeVisible();
    }

    test('A: nothing configured locks the composer and reports all five agents honestly and offers another', async ({ page }) => {
      await open(page, 'A');
      await expect(card(page).getByRole('option')).toHaveCount(6); // the five catalog agents plus "Another agent" (c77c8971f)
      await expect(card(page).getByRole('option', { name: /Another agent/ })).toBeVisible();
      await expect(card(page).getByRole('option', { name: /Astrid's agent/ })).toContainText('Set up');
      for (const name of ['Claude Code', 'Codex', 'Hermes', 'DeepSeek Harness']) await expect(card(page).getByRole('option', { name: new RegExp(name) })).toContainText('Not installed');
      await expect(composer(page)).toBeDisabled();
    });

    test('B: signed-in Codex starts before the first message', async ({ page }) => {
      await open(page, 'B');
      await expect(card(page).getByRole('option', { name: /Codex/ })).toContainText('Ready');
      await card(page).getByRole('option', { name: /Codex/ }).click();
      await done(page, 'B', 'Codex');
      await hi(page, 'B', 'codex');
    });

    test('C: Claude sign-in advances by polling after the runtime changes', async ({ page, context }) => {
      await open(page, 'C');
      await card(page).getByRole('option', { name: /Claude Code/ }).click();
      await expect(card(page).getByText('claude auth login', { exact: true })).toBeVisible();
      await expect(card(page).getByText('Waiting for you to sign in…', { exact: true })).toBeVisible();
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await card(page).getByRole('button', { name: 'Copy Claude Code sign-in command' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('claude auth login');
      await shot(page, 'C', 'sign-in');
      await page.waitForTimeout(5000);
      await control(page, { ready: true });
      await done(page, 'C', 'Claude Code');
    });

    test('D: Hermes installation advances automatically', async ({ page }) => {
      await open(page, 'D');
      await card(page).getByRole('option', { name: /Hermes/ }).click();
      await expect(card(page).locator('code').first()).toContainText('scripts/install.sh | bash');
      await expect(card(page).getByRole('button', { name: 'Copy Hermes install command' })).toBeVisible();
      await shot(page, 'D', 'install');
      await control(page, { ready: true });
      await done(page, 'D', 'Hermes');
    });

    test('E: OpenRouter rejects and clears a key, then selects the default and replies without leaking keys', async ({ page }) => {
      const keys = ['sk-or-test-wrong-0000000000', 'sk-or-test-offline-000000000', 'sk-or-test-valid-0000000000'];
      const consoleMessages: string[] = [];
      page.on('console', message => consoleMessages.push(message.text()));
      await page.addInitScript(() => {
        (window as Window & { setupDomHistory?: string[] }).setupDomHistory = [];
        new MutationObserver(() => {
          const html = document.documentElement.outerHTML;
          if (html.includes('sk-or-test-')) (window as Window & { setupDomHistory: string[] }).setupDomHistory.push(html);
        }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
      });
      await open(page, 'E');
      await expect(card(page).getByRole('link', { name: 'Built on oh-my-pi' })).toHaveAttribute('href', 'https://github.com/can1357/oh-my-pi');
      await card(page).getByRole('option', { name: /Astrid's agent/ }).click();
      const input = card(page).getByLabel('OpenRouter key', { exact: true });
      await expect(input).toBeVisible();
      await expect(card(page).getByRole('link', { name: 'Built on oh-my-pi' })).toHaveAttribute('href', 'https://github.com/can1357/oh-my-pi');
      await shot(page, 'E', 'key');
      for (const [index, key] of keys.entries()) {
        await input.fill(key);
        await card(page).getByRole('button', { name: 'Connect', exact: true }).click();
        if (index < 2) {
          await expect(input).toHaveValue('');
          await expect(card(page).getByRole('alert')).toHaveText(index === 0 ? "OpenRouter didn't accept that key." : "Couldn't reach OpenRouter. Check your connection and try again.");
          await shot(page, 'E', index === 0 ? 'wrong-key' : 'offline');
        }
      }
      await expect(card(page).getByRole('radio', { name: 'Claude Sonnet 4' })).toBeChecked();
      await expect(card(page).getByRole('radio')).toHaveCount(2);
      await card(page).getByRole('searchbox').fill('GPT');
      await expect(card(page).getByRole('radio', { name: 'GPT-5' })).toBeVisible();
      await card(page).getByRole('searchbox').clear();
      await shot(page, 'E', 'models');
      await card(page).getByRole('button', { name: 'Use Claude Sonnet 4', exact: true }).click();
      await done(page, 'E', "Astrid's agent");
      await hi(page, 'E', 'astrid');
      await expect(page.getByText('Uses the same sign-in as here.')).toBeVisible();
      const dom = await page.content();
      const history = await page.evaluate(() => (window as Window & { setupDomHistory: string[] }).setupDomHistory);
      for (const key of keys) {
        expect(dom.includes(key)).toBe(false);
        expect(consoleMessages.some(message => message.includes(key))).toBe(false);
      }
      expect(history).toEqual([]);
    });

    test('F: missing runtime shows its fix and can retry immediately', async ({ page }) => {
      const statuses: number[] = [];
      page.on('response', response => { if (response.url().endsWith('/chat/sessions')) statuses.push(response.status()); });
      await open(page, 'F');
      await card(page).getByRole('option', { name: /Codex/ }).click();
      await expect(card(page).getByRole('alert')).toHaveText('Bun is missing. Install it, then try again.');
      await expect(card(page).getByText('curl -fsSL https://bun.sh/install | bash', { exact: true })).toBeVisible();
      await shot(page, 'F', 'fix');
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every(status => status === 502)).toBe(true);
      const beforeRetry = statuses.length;
      await control(page, { createError: null });
      await card(page).getByRole('button', { name: 'Try again', exact: true }).click();
      await done(page, 'F', 'Codex');
      expect(statuses.slice(beforeRetry)).toEqual([200]);
    });

    test('G: a failed first message retries with the same request id', async ({ page }) => {
      const attempts: { body: { request_id: string; prompt: unknown[] }; status: number }[] = [];
      page.on('response', response => { if (response.url().endsWith('/chat/prompt')) attempts.push({ body: response.request().postDataJSON(), status: response.status() }); });
      await open(page, 'G');
      await card(page).getByRole('option', { name: /Codex/ }).click();
      await done(page, 'G', 'Codex');
      await composer(page).fill('hi');
      await composer(page).press('Enter');
      await expect(page.getByRole('button', { name: 'Send now', exact: true })).toBeVisible();
      await shot(page, 'G', 'failed-message');
      await page.getByRole('button', { name: 'Send now', exact: true }).click();
      await expect(page.getByText("Hi! I'm ready.", { exact: true })).toBeVisible({ timeout: 20_000 });
      await shot(page, 'G', 'reply');
      expect(attempts.map(attempt => attempt.status)).toEqual([502, 200]);
      expect(attempts[0].body.request_id).toBeTruthy();
      expect(attempts[1].body.request_id).toBe(attempts[0].body.request_id);
      expect(attempts[1].body.prompt[0]).toEqual(attempts[0].body.prompt[0]);
    });
  });
}
