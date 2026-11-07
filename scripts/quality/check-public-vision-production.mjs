#!/usr/bin/env node
/**
 * Assert that the *served production page*, not merely the JSON exporter,
 * renders its current GitHub-authored vision after a successful deployment.
 */
import { chromium, expect } from '@playwright/test';

const PAGE = 'https://astrid.haus/vision';
const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const attempts = 4;
const delayMs = 15_000;

async function publishedVision() {
  const response = await fetch(FEED, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Public vision feed HTTP ${response.status}`);
  const json = await response.json();
  if (json.schemaVersion !== 1 || !json.vision?.title ||
      !Array.isArray(json.pillars) || !Array.isArray(json.principles) ||
      !Array.isArray(json.gaps)) {
    throw new Error('Published vision feed is incomplete');
  }
  return json;
}

async function checkPage(browser, content) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const response = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok()) throw new Error(`Production vision page HTTP ${response?.status() ?? 'no response'}`);
    // The current failure is a *rendered error state*, despite HTTP 200.
    await expect(page.locator('main.astrid-vision h1')).toHaveText(content.vision.title, { timeout: 15_000 });
    await expect(page.locator('.astrid-vision-principles h3')).toHaveCount(content.pillars.length);
    await expect(page.locator('.astrid-vision-standards-list h3')).toHaveCount(content.principles.length);
    await expect(page.locator('#gap-aa-001')).toBeAttached();
    await expect(page.getByRole('alert')).toHaveCount(0);
    console.log(`Production vision page renders ${content.pillars.length} pillars, ${content.principles.length} principles, and the first live gap.`);
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const content = await publishedVision();
        await checkPage(browser, content);
        return;
      } catch (error) {
        lastError = error;
        console.error(`Production vision check ${attempt}/${attempts}: ${error instanceof Error ? error.message : error}`);
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw new Error(`Production vision never rendered the current feed after ${attempts} checks: ${lastError?.message ?? 'unknown error'}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
