import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 950 },
  timezoneId: 'America/Los_Angeles',
});
const page = await context.newPage();
const errors = [];
try {
  await page.request.post(`${process.env.EDITORIAL_PREVIEW_URL || 'http://127.0.0.1:18863'}/__reset`);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.EDITORIAL_PREVIEW_URL || 'http://127.0.0.1:18863', {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-brief-component-id="review-choice"] [role="option"]');
  assert.equal(
    await page.evaluate(
      async () => (await fetch('/api/brief/events', { method: 'POST', body: '{}' })).status,
    ),
    200,
    'preview handles the production telemetry endpoint',
  );
  console.log('ready', await page.locator('[data-brief-component]').count());
  await page.locator('[data-brief-component-id="review-choice"]').getByRole('option').first().click();
  await page
    .locator('[data-brief-component-id="review-choice"]')
    .getByRole('button', { name: 'Save choice', exact: true })
    .click();
  await page.locator('[data-brief-component-id="review-choice"]').getByText('Saved to this brief').waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  const choice = page.locator('[data-brief-component-id="review-choice"]');
  assert.equal(await choice.getByRole('option').first().getAttribute('aria-selected'), 'true');
  await choice.getByRole('button', { name: 'Continue in assistant' }).click();
  const draft = page.locator('[data-brief-component-id="review-draft"]');
  console.log('draft buttons', await draft.getByRole('button').allTextContents());
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'desktop overflow',
  );
  await page.screenshot({ path: '/tmp/editorial-custom-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'mobile overflow',
  );
  await page.screenshot({ path: '/tmp/editorial-custom-mobile.png', fullPage: true });
  await page.goto(`${process.env.EDITORIAL_PREVIEW_URL || 'http://127.0.0.1:18863'}/?catalogue`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-brief-component]').length === 28,
    undefined,
    { timeout: 15000 },
  );
  assert.equal(await page.locator('[data-brief-component]').count(), 28);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'catalogue mobile overflow',
  );

  const card = (name) => page.locator(`[data-brief-component-id="example-${name}"]`);
  const saved = (name) => card(name).getByText('Saved to this brief').waitFor();
  await card('approval-card').getByRole('button', { name: 'Save approval', exact: true }).click();
  await saved('approval-card');
  await card('parameter-slider').getByRole('slider').focus();
  await page.keyboard.press('End');
  await card('parameter-slider').getByRole('button', { name: 'Save values', exact: true }).click();
  await saved('parameter-slider');
  await card('preferences-panel').getByRole('switch').first().click();
  await card('preferences-panel').getByRole('button', { name: 'Save preferences', exact: true }).click();
  await saved('preferences-panel');
  await card('item-carousel').getByRole('button', { name: 'Select', exact: true }).first().click();
  await saved('item-carousel');
  await card('message-draft').getByRole('button', { name: 'Edit draft', exact: true }).click();
  await card('message-draft').getByRole('textbox').fill('Maya, please include the revised escalation terms.');
  await card('message-draft').getByRole('button', { name: 'Save draft', exact: true }).click();
  await saved('message-draft');

  await card('question-flow').getByText('Cost', { exact: true }).click();
  await card('question-flow').getByRole('button', { name: 'Next', exact: true }).click();
  await card('question-flow').getByText('Setup', { exact: true }).click();
  await card('question-flow').getByRole('button', { name: 'Complete', exact: true }).click();
  await saved('question-flow');
  await page.reload({ waitUntil: 'networkidle' });
  await saved('question-flow');
  await saved('approval-card');
  await saved('parameter-slider');
  await saved('preferences-panel');
  await saved('item-carousel');
  await saved('message-draft');
  assert.equal(await card('parameter-slider').getByRole('slider').getAttribute('aria-valuenow'), '60');
  assert.equal(
    await card('message-draft').getByText('Maya, please include the revised escalation terms.').count(),
    1,
  );
  await card('message-draft').getByRole('button', { name: 'Cancel', exact: true }).click();
  await card('message-draft').getByRole('button', { name: 'Restore draft', exact: true }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await card('message-draft').getByRole('button', { name: 'Restore draft', exact: true }).click();
  await card('message-draft').getByRole('button', { name: 'Edit draft', exact: true }).waitFor();
  console.log(
    'Passed: all components render, inputs persist, draft cancellation restores, desktop/mobile have no overflow.',
  );
  for (const variant of ['dark', 'fallback', 'history']) {
    await page.goto(`${process.env.EDITORIAL_PREVIEW_URL || 'http://127.0.0.1:18863'}/?${variant}`, {
      waitUntil: 'networkidle',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${variant} overflow`,
    );
    assert.ok((await page.locator('main').textContent()).includes('Launch review'));
    if (variant === 'dark') await page.screenshot({ path: '/tmp/editorial-custom-dark.png', fullPage: true });
  }
  console.log('errors', errors);
  assert.equal(errors.length, 0, errors.join('\n'));
} finally {
  await browser.close();
}
