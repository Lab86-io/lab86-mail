/** Verify the actual Today page distinguishes a failed read from an empty history. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.goto(process.env.ALBATROSS_PREVIEW_URL || 'http://127.0.0.1:18847/');
  await page.locator('[data-mail-thread-row]').first().waitFor();
  await page.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.briefReadFailed = true;
    globalThis.fetch = async (input, init) => {
      if (globalThis.briefReadFailed && String(input).includes('/api/tools/get_latest_daily_report'))
        return Response.json({ ok: false, error: 'Synthetic read failure' }, { status: 500 });
      return original(input, init);
    };
    window.workspacePreview.state().setPrimaryView('today');
  });
  const alert = page.getByRole('alert').filter({ hasText: 'Your brief couldn’t load.' });
  await alert.waitFor();
  assert.equal(await page.getByText('No edition yet', { exact: true }).count(), 0);
  await page.evaluate(() => {
    globalThis.briefReadFailed = false;
  });
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await alert.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Write a new brief', exact: true }).waitFor();
  console.log(
    JSON.stringify({
      ok: true,
      checks: ['failed read is visible', 'failure is not an empty edition', 'Retry reloads the saved brief'],
    }),
  );
} finally {
  await browser.close();
}
