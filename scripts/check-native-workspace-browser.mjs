/** Run against dev:preview. Uses synthetic fixtures and the actual editor components. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = process.env.ALBATROSS_NATIVE_PREVIEW_URL || 'http://127.0.0.1:18849';
const output = process.env.ALBATROSS_NATIVE_SCREENSHOTS || '/tmp/lab86-native-workspace';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
});
try {
  for (const [name, viewport] of Object.entries({
    phone: { width: 390, height: 844 },
    desktop: { width: 1440, height: 1000 },
  })) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.nativeEditorMessages = [];
      window.webkit = {
        messageHandlers: {
          albatrossEditor: { postMessage: (message) => window.nativeEditorMessages.push(message) },
        },
      };
    });
    await page.goto(`${origin}/?review=native-files&view=files`);
    await page.getByText('North House proposal', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.workspacePreview.state().primaryView), 'files');
    await page.screenshot({ path: `${output}/${name}-library.png` });
    await page.getByText('North House proposal', { exact: true }).click();
    const title = page.getByRole('textbox', { name: 'File name', exact: true });
    await title.waitFor();
    await page.getByRole('button', { name: 'Version history', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Download Document', exact: true }).waitFor();
    await title.fill('Edited native document');
    await page.waitForFunction(() =>
      window.nativeEditorMessages.some((message) => message.type === 'editorState' && message.dirty),
    );
    await page.screenshot({ path: `${output}/${name}-document.png` });
    await page.getByRole('button', { name: 'Edit with Albatross', exact: true }).click();
    await page.locator('[data-assistant-document-context]').waitFor({ state: 'visible' });
    assert.match(
      await page.locator('[data-assistant-document-context]').innerText(),
      /Edited native document/,
    );
    await page.screenshot({ path: `${output}/${name}-assistant.png` });
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    for (const [id, label] of [
      ['style-sheet', 'Spreadsheet editor'],
      ['style-deck', 'Presentation editor'],
    ]) {
      await page.goto(`${origin}/?review=native-files&view=files&document=${id}`);
      await page.getByRole('region', { name: label, exact: true }).waitFor();
      if (id === 'style-sheet') {
        await page.locator('.o-spreadsheet canvas').first().waitFor({ state: 'visible' });
        assert.equal(
          await page.getByText('The spreadsheet engine did not open.', { exact: true }).count(),
          0,
        );
      }
      await page.getByRole('button', { name: 'Edit with Albatross', exact: true }).waitFor();
      await page.screenshot({ path: `${output}/${name}-${id}.png` });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    `Native workspace layouts, editors, assistant context and dirty-state bridge passed. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
