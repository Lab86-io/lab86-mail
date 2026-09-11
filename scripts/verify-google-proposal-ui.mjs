/** Actual GoogleDocumentEditor; synthetic transport only. Never contacts Google. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp('/tmp/albatross-google-proposal-');
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:18839/?scenario=saved');
  const title = page.getByRole('textbox', { name: 'File name', exact: true });
  const body = page.getByRole('textbox', { name: 'Document text', exact: true });
  await body.waitFor();
  await page.evaluate(() => {
    const fixtureFetch = globalThis.fetch;
    globalThis.__googleAiWrites = [];
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/files/google/editor' && init?.method === 'POST') {
        const submitted = JSON.parse(init.body);
        return new Promise((resolve) => {
          globalThis.__releaseGoogleProposal = () => {
            globalThis.__releaseGoogleProposal = null;
            resolve(
              Response.json({
                ok: true,
                suggestion: {
                  suggestionId: crypto.randomUUID(),
                  title: 'Reviewed memo',
                  description: 'A synthetic proposal based on the requested snapshot.',
                  proposedModel: {
                    ...submitted.model,
                    blocks: [{ id: 'reviewed', type: 'paragraph', text: 'A reviewed synthetic decision.' }],
                  },
                },
              }),
            );
          };
        });
      }
      if (String(input) === '/api/files/google/editor' && init?.method === 'PATCH')
        globalThis.__googleAiWrites.push(JSON.parse(init.body));
      return fixtureFetch(input, init);
    };
  });
  const panel = page.getByRole('complementary', { name: 'Google document assistant', exact: true });
  const instruction = panel.getByRole('textbox');
  await instruction.fill('Clarify the initial decision');
  await panel.getByRole('button', { name: 'Propose changes' }).click();
  await page.waitForFunction(() => typeof globalThis.__releaseGoogleProposal === 'function');
  await title.fill('My newer title');
  await body.fill('My newer typing must survive.');
  await instruction.fill('Keep this next instruction');
  await page.evaluate(() => globalThis.__releaseGoogleProposal());
  await panel.getByText(/This file changed after the proposal started/).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
  assert.equal(await title.inputValue(), 'My newer title');
  assert.equal(await body.innerText(), 'My newer typing must survive.');
  assert.equal(await instruction.inputValue(), 'Keep this next instruction');
  await page.screenshot({ path: `${artifacts}/stale-proposal.png` });

  await page.getByText('Saved to Google Drive', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Propose changes' }).click();
  await page.waitForFunction(() => typeof globalThis.__releaseGoogleProposal === 'function');
  await page.evaluate(() => globalThis.__releaseGoogleProposal());
  await page.waitForFunction(
    () =>
      document.querySelectorAll('aside[aria-label="Google document assistant"] button').length > 0 &&
      Array.from(document.querySelectorAll('aside[aria-label="Google document assistant"] button')).some(
        (button) => button.textContent.trim() === 'Apply' && !button.disabled,
      ),
  );
  await panel.getByRole('button', { name: 'Apply', exact: true }).first().click();
  assert.equal(await title.inputValue(), 'Reviewed memo');
  assert.equal(await body.innerText(), 'A reviewed synthetic decision.');
  await page.getByText('Saved to Google Drive', { exact: true }).waitFor();
  const writes = await page.evaluate(() => globalThis.__googleAiWrites);
  assert.equal(writes.at(-1).title, 'Reviewed memo');
  assert.equal(writes.at(-1).model.blocks[0].text, 'A reviewed synthetic decision.');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      artifacts,
      checks: [
        'newer title and document typing invalidate an in-flight AI proposal',
        'completed generation preserves the next typed instruction',
        'fresh reviewable proposal applies and autosaves through the provider editor',
      ],
    }),
  );
} finally {
  await browser.close();
}
