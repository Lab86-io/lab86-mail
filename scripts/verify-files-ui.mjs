/** Synthetic UI acceptance. Run the --files preview first; never targets an account. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-files-ui-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const open = async (scenario = '') => {
    await page.goto(`http://127.0.0.1:18839/?scenario=${scenario}`);
    await page
      .locator(
        'section[aria-label="Files"], section[aria-label="Document editor"], section[aria-label="Google file preview"]',
      )
      .waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => true));
  };
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await page.locator('button[title="Project material"]').waitFor();
    const overflow = await page
      .locator('[data-file-list]')
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false, `File list overflow at ${width}`);
    const actions = await page
      .getByRole('button', { name: 'Actions for Reference image.png', exact: true })
      .boundingBox();
    assert(actions && actions.x >= 0 && actions.x + actions.width <= width);
    await page.screenshot({ path: join(artifacts, `files-${width}-light.png`) });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(400); // Let the app's finite theme-color transition settle.
    await page.screenshot({ path: join(artifacts, `files-${width}-dark.png`) });
    if (width === 390) {
      const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
      const title = await page.getByRole('heading', { name: 'Files', exact: true }).boundingBox();
      assert(nav && title && nav.y + nav.height <= title.y);
      await page.getByRole('button', { name: 'Search Albatross', exact: true }).click();
      assert.equal(await page.evaluate(() => globalThis.__searchOpened), true);
      await page.getByRole('combobox', { name: 'File location' }).selectOption('drive');
    }
    await page.getByRole('button', { name: 'Load more files', exact: true }).click();
    await page.locator('button[title="Second-page source.pdf"]').waitFor();
    await page.locator('button[title="Project material"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('button[title="Inside the project.pdf"]').waitFor();
    await page.getByRole('button', { name: 'Back one folder' }).click();
    await page.locator('button[title="Project material"]').waitFor();
    await page.getByRole('combobox', { name: 'File type' }).selectOption('images');
    assert.equal(await page.locator('[data-file-list] > .group').count(), 1);
    await page.getByRole('combobox', { name: 'File type' }).selectOption('all');
    await page.getByRole('textbox', { name: 'Search files' }).filter({ visible: true }).fill('context');
    await page.locator('button[title="Matching research.pdf"]').waitFor();
    // A provider content match must survive even when its name does not match the query.
    await page.getByRole('textbox', { name: 'Search files' }).filter({ visible: true }).fill('absent');
    await page.getByRole('heading', { name: 'No files found', exact: true }).waitFor();
    await open('error');
    await page.locator('summary').waitFor();
    await page.locator('button[title="Release checklist"]').waitFor();
    await page.screenshot({ path: join(artifacts, `files-${width}-partial-error.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await page.locator('button[title="Reference image.png"] svg').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('img[src="/missing.png"]'));
  await page.screenshot({ path: join(artifacts, 'files-grid-phone.png') });
  await open('readonly');
  assert.equal(await page.locator('textarea').count(), 0);
  await page.getByRole('link', { name: 'Open original in Google' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'google-readonly-phone.png') });
  await open('conflict');
  const title = page.getByRole('textbox', { name: 'File name' });
  await title.fill('My local draft');
  await page.getByRole('alert').waitFor();
  await title.fill('My newer local draft');
  await page.waitForTimeout(1800);
  const patches = () =>
    page.evaluate(() => globalThis.__filesRequests.filter((request) => request.startsWith('PATCH')));
  assert.equal((await patches()).length, 1, 'Conflict must stop automatic retries');
  assert.equal(await title.inputValue(), 'My newer local draft');
  await page.screenshot({ path: join(artifacts, 'google-conflict-phone.png') });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload original' }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="File name"]')?.value === 'Project decision memo',
  );
  assert.equal(await page.getByRole('alert').count(), 0);
  await open('saved');
  await page.getByRole('textbox', { name: 'File name' }).fill('Saved draft');
  await page.waitForFunction(() => globalThis.__filesRequests.some((request) => request.startsWith('PATCH')));
  await page.getByText('Saved to Google Drive', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'File name' }).inputValue(), 'Saved draft');
  await page.screenshot({ path: join(artifacts, 'google-editor-phone.png') });
  console.log(`Files UI acceptance passed. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
