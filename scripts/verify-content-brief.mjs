import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = 'http://127.0.0.1:18859';
const output = '/tmp/albatross-connected-content';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
const evidence = [];
try {
  for (const width of [390, 768, 1440]) {
    await fetch(`${origin}/__reset`);
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Review draft', exact: true }).click();
    await page.getByLabel('Your answers and notes').fill('Maya owns the handoff.');
    await page.getByRole('button', { name: 'Save edits', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh preparation', exact: true }).waitFor();
    assert.equal((await (await fetch(`${origin}/__state`)).json()).item.userFiles, undefined);
    await page.getByRole('button', { name: 'Refresh preparation', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('textarea[id^="draft-"]')?.value.includes('Updated suggested draft'),
    );
    await fetch(`${origin}/__reset`);
    await page.reload();
    await page.getByRole('button', { name: 'Review draft', exact: true }).click();

    const file = page.getByLabel('launch-plan.md', { exact: true });
    await file.fill('My unsaved launch plan');
    await fetch(`${origin}/__change`);
    await page.evaluate(() => window.__refreshPreparations());
    assert.equal(await file.inputValue(), 'My unsaved launch plan');
    assert.equal(await page.getByRole('button', { name: 'Adopt', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Save edits', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh preparation', exact: true }).click();
    await page.getByRole('button', { name: 'Adopt', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => ![...document.querySelectorAll('button')].find((b) => b.textContent === 'Adopt')?.disabled,
    );
    assert.equal(await file.inputValue(), 'My unsaved launch plan');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'launch-plan.md');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/brief-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Adopt', exact: true }).click();
    await page.getByRole('link', { name: /Saved to your work/ }).waitFor();
    assert.equal((await (await fetch(`${origin}/__state`)).json()).visible, false);
    await fetch(`${origin}/__reset`);
    await page.reload();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.reload();
    assert.equal(await page.getByRole('button', { name: 'Review draft', exact: true }).count(), 0);
    await page.getByRole('switch', { name: 'Prepare work in the Brief', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Saved. Background processing is queued.' }).waitFor();
    await fetch(`${origin}/__fail`);
    await page.evaluate(() => window.__refreshPreparations());
    await page.getByRole('alert').filter({ hasText: 'Source temporarily unavailable' }).first().waitFor();
    assert.deepEqual(errors, []);
    evidence.push({
      width,
      notesOnlyEditsAllowFileRegeneration: true,
      unsavedEditsSurviveRefresh: true,
      savedEditsSurviveRegeneration: true,
      download: true,
      adoptionLink: true,
      dismissalPersists: true,
      settingsPersist: true,
      errorVisible: true,
      noOverflow: true,
    });
    await page.close();
  }
  await writeFile(
    `${output}/evidence.json`,
    JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2),
  );
  console.log(output);
} finally {
  await browser.close();
}
