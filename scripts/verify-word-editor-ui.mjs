import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:18848';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 798, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = async () => (await page.request.get(`${base}/fixture-word-state`)).json();
  const open = async () => {
    await page.request.post(`${base}/fixture-reset`);
    await page.goto(`${base}/?kind=word`);
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    await page.frameLocator('iframe[title="Document editor"]').getByRole('textbox').waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Save')
          ?.disabled,
    );
  };
  await open();
  await page.getByRole('textbox', { name: 'File name', exact: true }).fill('Edited title');
  await page.getByRole('textbox', { name: 'File name', exact: true }).press('Enter');
  await page.waitForTimeout(300);
  assert.equal((await state()).title, 'Edited title.docx');
  assert.equal(await page.getByRole('button', { name: 'Edit with Albatross' }).count(), 1);
  const body = () => page.frameLocator('iframe[title="Document editor"]').getByRole('textbox');
  await body().fill('Unsaved typing must survive');
  await page.request.post(`${base}/fixture-word-edit`, { data: {} });
  await page.getByText('Applying Albatross edit…', { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    async () => (await (await fetch('/fixture-word-state')).json()).sessions === 2,
    null,
    { timeout: 20_000 },
  );
  await body().waitFor();
  assert.equal(await body().inputValue(), 'Unsaved typing must survive\nAI edit preserved the draft.');
  assert.deepEqual((await state()).events, ['open', 'save', 'prepared', 'applied', 'open']);
  for (const width of [798, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `/tmp/albatross-word-editor-${width}.png` });
  }
  await open();
  await body().fill('Keep this draft if saving fails');
  await page.request.post(`${base}/fixture-word-edit`, { data: { failSave: true } });
  await page.getByRole('alert').filter({ hasText: 'Synthetic save failed' }).waitFor({ timeout: 15_000 });
  assert.equal(await body().inputValue(), 'Keep this draft if saving fails');
  assert.equal((await state()).sessions, 1);
  assert.equal((await state()).text, 'Original saved content');
  await page.request.post(`${base}/fixture-reset`);
  await page.goto(`${base}/?kind=doc`);
  await page.getByRole('button', { name: 'Word processor', exact: true }).click();
  await body().waitFor();
  assert((await body().inputValue()).includes('Make room for the work'));
  assert((await state()).events.includes('copy'));
  assert.deepEqual(errors, []);
  console.log(
    'Word editor browser acceptance passed: title, AI save/pause/reopen, failed-save draft retention, existing-document copy, 798/390 layouts.',
  );
} finally {
  await browser.close();
}
