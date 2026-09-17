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
      waitUntil: 'networkidle',
      timeout: 60000,
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
    const failures = await page.locator('[data-slot="work-log"][data-work-state="failed"]').count();
    if (failures !== 1) throw Error(`Expected failed work log, got ${failures}`);
    const disclosure = page.getByRole('button', { name: /Did \d things/ }).first();
    if (await disclosure.count()) await disclosure.click();
    await page.locator('[data-shape-kind="threads"]').first().waitFor();
    await page.getByRole('button', { name: 'Archive', exact: true }).first().click();
    await page.getByText('Archived', { exact: true }).first().waitFor();
    await page.screenshot({ path: `/tmp/chat-preview/${name}-complete.png` });
    // Follow streamed size changes only while at the bottom; preserve reading position above it.
    await page.evaluate(() => {
      const log = document.querySelector('[role="log"]');
      const spacer = document.createElement('div');
      spacer.dataset.scrollProbe = 'true';
      spacer.style.height = '800px';
      log.append(spacer);
      log.parentElement.scrollTop = log.parentElement.scrollHeight;
    });
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[role="log"]').parentElement;
      return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2;
    });
    await page.evaluate(() => {
      document.querySelector('[data-scroll-probe]').style.height = '1200px';
    });
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[role="log"]').parentElement;
      return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2;
    });
    await page.evaluate(() => {
      document.querySelector('[role="log"]').parentElement.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).waitFor();
    await page.evaluate(() => {
      document.querySelector('[data-scroll-probe]').style.height = '1600px';
    });
    await page.waitForTimeout(100);
    const readingPosition = await page.evaluate(
      () => document.querySelector('[role="log"]').parentElement.scrollTop,
    );
    if (readingPosition !== 0) throw Error('Streaming pulled the reader away from their position');
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[role="log"]').parentElement;
      return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2;
    });
    await page.evaluate(() => document.querySelector('[data-scroll-probe]').remove());
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.locator('[data-slot="work-log"]').first().scrollIntoViewIfNeeded();
    const transitions = await page
      .locator('[data-slot="work-log"] > button svg')
      .evaluateAll((icons) => icons.map((icon) => getComputedStyle(icon).transitionDuration));
    if (!transitions.length || transitions.some((duration) => duration !== '0s'))
      throw Error('Steps icons animate despite reduced motion');
    await page.screenshot({ path: `/tmp/chat-preview/${name}-dark-reduced-motion.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw Error(`${name} chat overflows`);
    console.log(name, JSON.stringify({ logCount, failures, errors }));
    if (errors.length) throw Error(errors.join('\n'));
    await page.goto(`${process.env.CHAT_PREVIEW_URL || 'http://localhost:18992'}/dev/model-picker`, {
      waitUntil: 'networkidle',
      timeout: 60000,
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
