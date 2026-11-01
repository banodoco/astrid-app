import type { Page, Response } from '@playwright/test';

/** Observe the actual admission, stopping promptly when the mounted UI refuses it. */
export async function waitForRenderAdmission(
  page: Page,
  admissionUrl: string,
  render: () => Promise<unknown>,
  { timeoutMs = 30_000, pollIntervalMs = 100 } = {},
): Promise<Response> {
  let admitted: Response | undefined;
  const onResponse = (response: Response) => {
    if (response.request().method() === 'POST' && response.url() === admissionUrl) admitted ??= response;
  };
  const blocker = page.locator('[data-video-editor-render-blocker="true"]');
  const deadline = performance.now() + timeoutMs;
  page.on('response', onResponse);
  try {
    await render();
    for (;;) {
      if (admitted) return admitted;
      if (await blocker.isVisible()) {
        const error = (await blocker.textContent())?.trim();
        if (error) throw new Error(`mounted App Render action refused admission: ${error}`);
      }
      if (performance.now() >= deadline) throw new Error('mounted App Render action did not POST a task within the admission deadline');
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  } finally {
    page.off('response', onResponse);
  }
}
