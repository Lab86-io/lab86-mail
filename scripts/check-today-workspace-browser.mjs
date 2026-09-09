/** Run `bun run build`, then in another terminal:
 * `bun scripts/preview-narrative-tools.mjs --today`
 * Run checks: `bun scripts/check-today-workspace-browser.mjs`.
 * Set CHROMIUM_PATH if using a browser outside Playwright's installation.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:18839', { waitUntil: 'networkidle' });
  } catch (cause) {
    throw new Error(
      'Today preview is unreachable. Run bun scripts/preview-narrative-tools.mjs --today first.',
      { cause },
    );
  }
  await page.getByRole('heading', { name: 'Bring CardHunt across the line' }).waitFor();
  assert.equal(await page.locator('[data-today-thread]').count(), 2);
  await page.screenshot({ path: '/tmp/today-workspace-desktop.png', fullPage: true });
  const guide = page.getByRole('button', { name: 'Open guided work', exact: true });
  await guide.focus();
  await page.keyboard.press('Enter');
  assert.equal((await page.evaluate(() => globalThis.__todayState())).guidedWorkId, 'cardhunt');
  assert.equal(
    (await page.evaluate(() => globalThis.__todayRequests)).length,
    0,
    'Navigation must not execute or mutate work',
  );
  const card = page.locator('[data-today-thread]').first();
  await card.getByRole('button', { name: 'That’s wrong' }).click();
  const input = card.getByRole('textbox', { name: 'What should the narrative know instead?' });
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  await input.fill('The QA review is tomorrow, not today.');
  await card.getByRole('button', { name: 'Save correction' }).click();
  await card.getByText('Correction saved in narrative memory.').waitFor();
  const correction = (await page.evaluate(() => globalThis.__todayRequests))[0];
  assert.equal(correction.action, 'correct');
  assert.deepEqual(correction.sourceIds, ['meeting', 'pr']);
  await page.getByRole('button', { name: 'Review & create work' }).click();
  assert.match((await page.evaluate(() => globalThis.__todayState())).captureSeed, /Read the deck/);
  await page.locator('[data-today-thread]').nth(1).getByRole('button', { name: 'Not today' }).click();
  await page
    .getByText('Not today. Your choice is saved in narrative memory; the work itself is unchanged.')
    .waitFor();
  assert.equal((await page.evaluate(() => globalThis.__todayRequests))[1].action, 'defer');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Mark work done' }).click();
  await page.getByText('Marked done. Your work record has been updated.').waitFor();
  assert.equal(await page.getByText('Existing work · done', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Open guided work', exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => globalThis.__todayRequests))[0].state, 'done');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'No horizontal overflow on narrow screens',
  );
  await page.screenshot({ path: '/tmp/today-workspace-narrow.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/today-workspace-dark.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: [
        'keyboard guided navigation without writes',
        'correction focus and save',
        'review-before-create',
        'defer feedback',
        'explicit completion',
        'narrow layout',
        'dark mode screenshot',
        'no runtime errors',
      ],
      data: 'synthetic only',
    }),
  );
} finally {
  await browser.close();
}
