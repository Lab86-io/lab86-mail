import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

await mkdir('/tmp/chat-preview', { recursive: true });
await mkdir('/tmp/model-picker', { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH || '/home/jjalangtry/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('**/api/**', (route) =>
      route.fulfill({ json: { ok: true, result: { ok: true }, route: 'ask', confidence: 1 } }),
    );
    await page.goto(`${process.env.CHAT_PREVIEW_URL || 'http://localhost:18992'}/dev/chat-preview`, {
      waitUntil: 'domcontentloaded',
    });
    await page
      .getByRole('button', { name: 'What needs my reply today? Open the most urgent one.', exact: true })
      .click({ timeout: 60000 });
    await page.locator('[data-slot="work-log"]').first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: `/tmp/chat-preview/${name}-live.png` });
    await page
      .getByRole('button', { name: 'Stop', exact: true })
      .waitFor({ state: 'hidden', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.chat-reveal'));
    const logCount = await page.locator('[data-slot="work-log"]').count();
    if (logCount < 1) throw Error('Missing work log');
    const failures = await page.locator('[data-slot="work-log"][data-state="failed"]').count();
    if (failures !== 1) throw Error(`Expected failed work log, got ${failures}`);
    const disclosure = page.getByRole('button', { name: /Did \d things/ }).first();
    if (await disclosure.count()) await disclosure.click();
    await page.locator('[data-shape-kind="threads"]').first().waitFor();
    await page.getByRole('button', { name: 'Archive', exact: true }).first().click();
    await page.getByText('Archived', { exact: true }).first().waitFor();
    await page.screenshot({ path: `/tmp/chat-preview/${name}-complete.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw Error(`${name} chat overflows`);
    console.log(name, JSON.stringify({ logCount, failures, errors }));
    if (errors.length) throw Error(errors.join('\n'));
    await page.goto(`${process.env.CHAT_PREVIEW_URL || 'http://localhost:18992'}/dev/model-picker`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByPlaceholder('Search models, or type a vendor/model id').waitFor({ timeout: 60000 });
    await page.screenshot({ path: `/tmp/model-picker/${name}.png`, animations: 'disabled' });
    const pickerSearch = page.getByPlaceholder('Search models, or type a vendor/model id');
    await pickerSearch.fill('haiku');
    if ((await page.getByRole('option').count()) !== 1) throw Error('Model search did not isolate Haiku');
    await pickerSearch.press('ArrowDown');
    await pickerSearch.press('Enter');
    await pickerSearch.waitFor({ state: 'hidden' });
    await page.getByRole('combobox').first().filter({ hasText: 'Claude Haiku 4.5' }).waitFor();
    await context.close();
  }
} finally {
  await browser.close();
}
