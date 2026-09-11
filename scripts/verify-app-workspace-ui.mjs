/** Actual AppShell, AIBar, AskHoldComposer and Search. Synthetic transport only. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp('/tmp/albatross-app-workspace-');
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:18847/');
  await page.locator('[data-mail-thread-row]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const launcher = page.getByRole('button', { name: 'Ask Albatross or get this off my mind' });
  const chat = page.locator('[data-assistant-chat]');
  const textarea = chat.locator('textarea');
  const frame = page.locator('[data-assistant-workspace]');
  const snapshot = async (name) => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${artifacts}/${name}-${theme}.png` });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  };
  await snapshot('shell');
  const mailField = page.locator('[data-mail-search-input="true"]');
  await mailField.fill('from:alex');
  await mailField.evaluate((element) => {
    element.dataset.mountSentinel = 'same-mail-field';
  });
  await page.locator('[data-mail-results]').evaluate((element) => {
    element.scrollTop = 180;
  });
  await launcher.click();
  await textarea.waitFor();
  await textarea.press('Tab');
  assert.equal(
    await chat.locator('[data-route]').getAttribute('data-route'),
    'hold',
    'empty composer accepts Hold',
  );
  await textarea.fill('Keep this unfinished thought');
  await chat
    .locator('input[type="file"]')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await chat.getByRole('button', { name: 'Remove notes.txt' }).waitFor();
  await textarea.evaluate((element) => {
    element.dataset.mountSentinel = 'same-composer';
  });
  const assertDraft = async () => {
    assert.equal(await textarea.inputValue(), 'Keep this unfinished thought');
    assert.equal(await textarea.getAttribute('data-mount-sentinel'), 'same-composer');
    assert.equal(await chat.locator('[data-route]').getAttribute('data-route'), 'hold');
    assert.equal(
      await chat.getByRole('button', { name: 'Remove notes.txt', includeHidden: true }).count(),
      1,
    );
  };
  await snapshot('corner');
  await chat.getByRole('button', { name: 'Expand chat beside this page' }).click();
  assert.equal(await frame.getAttribute('data-layout'), 'split');
  await assertDraft();
  await snapshot('split');
  await chat.getByRole('button', { name: 'Focus on chat' }).click();
  await assertDraft();
  assert.equal(await page.locator('[data-assistant-page]').getAttribute('inert'), '');
  await snapshot('full');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-workspace]')?.dataset.mobile === 'true',
  );
  await assertDraft();
  assert.equal(await mailField.getAttribute('data-mount-sentinel'), 'same-mail-field');
  assert.equal(await mailField.inputValue(), 'from:alex');
  assert.ok(await page.locator('[data-mail-results]').evaluate((element) => element.scrollTop >= 100));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-workspace]')?.dataset.mobile === 'false',
  );
  await assertDraft();
  assert.equal(await mailField.getAttribute('data-mount-sentinel'), 'same-mail-field');

  // Opening Search from the real composer and choosing Chat retains the page
  // route, the actual textarea node, the preselected Hold route and attachments.
  await textarea.press('Control+p');
  await page.locator('[data-global-search-dialog]').waitFor();
  await page.locator('[cmdk-item][data-value="page:chat"]').click();
  assert.equal(await page.evaluate(() => window.workspacePreview.state().primaryView), 'mail');
  await assertDraft();
  assert.equal(await frame.getAttribute('data-layout'), 'full', 'Chat destination opens full screen');
  await textarea.press('Control+p');
  await page.locator('[cmdk-item][data-value="page:files"]').click();
  await page.waitForFunction(() => window.workspacePreview.state().primaryView === 'files');
  assert.equal(
    await chat.getAttribute('data-layout'),
    'closed',
    'leaving Chat reveals Files without a split',
  );
  await assertDraft();
  await launcher.click();
  await chat.getByRole('button', { name: 'Expand chat beside this page' }).click();
  assert.equal(await frame.getAttribute('data-layout'), 'split', 'splitting is an explicit action');

  // Resizing the actual AppShell must preserve the same chat/composer owners.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-workspace]')?.dataset.mobile === 'true',
  );
  await assertDraft();
  assert.equal(await frame.getAttribute('data-layout'), 'full');
  await snapshot('phone-chat');
  await chat.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await chat.getAttribute('inert'), '');
  assert.equal(await page.evaluate(() => window.workspacePreview.state().primaryView), 'files');
  await launcher.click();
  await assertDraft();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-workspace]')?.dataset.mobile === 'false',
  );
  await assertDraft();
  await chat.getByRole('button', { name: 'Focus on chat' }).click();
  await page.evaluate(() => window.workspacePreview.state().setSelectedThread('thread-0'));
  await chat.getByRole('button', { name: 'Chat history' }).focus();
  for (const key of ['e', '#', 't']) await page.keyboard.press(key);
  assert.equal(
    await page.evaluate(() =>
      window.workspacePreview.calls.some((call) => /archive_thread|trash_thread|triage_thread/.test(call)),
    ),
    false,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => window.workspacePreview.state().selectedThreadId), 'thread-0');

  // Keep the real useChat transport streaming while the frame moves. Feed the
  // same dynamic tool shape persisted by the native chat; no live AI or mail.
  await textarea.fill('Draft a synthetic note');
  await textarea.press('Control+Enter');
  await chat.getByText('The draft stays here.', { exact: true }).waitFor();
  await chat.getByRole('button', { name: 'Show current page' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-workspace]')?.dataset.mobile === 'true',
  );
  await chat.getByRole('button', { name: 'Close', exact: true }).click();
  await launcher.click();
  await page.evaluate(() => {
    const input = {
      to: ['reader@example.test'],
      from: 'alex@example.test',
      subject: 'Synthetic inline review',
      body: 'This draft has not been sent.',
    };
    window.workspacePreview.emitAgent({
      type: 'tool-input-start',
      toolCallId: 'native-shaped-draft',
      toolName: 'show_message_draft',
      dynamic: true,
    });
    window.workspacePreview.emitAgent({
      type: 'tool-input-available',
      toolCallId: 'native-shaped-draft',
      toolName: 'show_message_draft',
      input,
      dynamic: true,
    });
    window.workspacePreview.emitAgent({
      type: 'tool-output-available',
      toolCallId: 'native-shaped-draft',
      output: {
        ok: true,
        component: 'message-draft',
        payload: { ...input, id: 'synthetic-draft-card', channel: 'email' },
      },
    });
    window.workspacePreview.emitAgent({
      type: 'tool-input-available',
      toolCallId: 'file-edits',
      toolName: 'document_edit',
      dynamic: true,
      input: {
        documentId: 'fixture-document',
        expectedRevision: 2,
        mode: 'review',
        summary: 'Clarify the plan',
        operations: [],
      },
    });
    window.workspacePreview.emitAgent({
      type: 'tool-output-available',
      toolCallId: 'file-edits',
      output: {
        ok: true,
        status: 'proposed',
        title: 'Synthetic plan',
        kind: 'doc',
        documentId: 'fixture-document',
        revision: 2,
        summary: 'Not yet applied. Review the changes in Files.',
        openPath: '/?view=files&document=fixture-document',
      },
    });
    window.workspacePreview.finishAgent();
  });
  await chat.getByText('Synthetic inline review', { exact: true }).waitFor();
  await chat.getByText('This draft has not been sent.', { exact: true }).waitFor();
  assert.equal(await chat.getByText('The draft stays here.', { exact: true }).count(), 1);
  assert.equal(
    await page.evaluate(
      () => window.workspacePreview.calls.filter((call) => call === 'POST /api/agent').length,
    ),
    1,
  );
  assert.equal(await page.evaluate(() => window.workspacePreview.state().compose.mode), null);
  assert.equal(
    await page.evaluate(() => window.workspacePreview.calls.some((call) => call.includes('/api/compose'))),
    false,
  );
  await snapshot('phone-tool-card');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-workspace]')?.dataset.mobile === 'false',
  );
  await chat.getByRole('button', { name: 'Focus on chat' }).click();
  await textarea.fill('Keep this draft while opening a file');
  await page.evaluate(() => {
    window.fileLinkMountSentinel = 'same-shell';
  });
  await chat.getByRole('link', { name: /Synthetic plan/ }).click();
  assert.equal(await page.evaluate(() => window.fileLinkMountSentinel), 'same-shell');
  assert.equal(await page.evaluate(() => window.workspacePreview.state().primaryView), 'files');
  assert.equal(await frame.getAttribute('data-layout'), 'split');
  assert.equal(await textarea.inputValue(), 'Keep this draft while opening a file');
  assert.equal(await chat.getByText('Synthetic inline review', { exact: true }).count(), 1);
  assert.equal(await chat.getByText('Review the suggestion in the editor', { exact: true }).count(), 1);
  await page.getByRole('textbox', { name: 'File name', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'File name', exact: true }).inputValue(),
    'Synthetic plan',
  );
  const fileWorkspace = page.locator('[data-document-workspace]');
  const documentText = fileWorkspace.getByRole('textbox', { name: 'Document text', exact: true });
  await documentText.waitFor();
  const fileAssistant = fileWorkspace.getByRole('button', { name: 'Edit with Albatross' });
  assert.ok((await documentText.boundingBox()).width >= 350, 'split keeps a readable document canvas');
  await page.waitForTimeout(1000);
  assert.equal(
    await page.evaluate(() =>
      window.workspacePreview.calls.includes('PATCH /api/documents/fixture-document'),
    ),
    false,
    'opening a document must not create an unsolicited edit',
  );
  await fileAssistant.click();
  assert.equal(
    await fileWorkspace.getByRole('complementary', { name: 'Document assistant', exact: true }).count(),
    0,
  );
  assert.equal(await fileWorkspace.locator('fieldset').first().getAttribute('inert'), null);
  assert.equal(await frame.getAttribute('data-layout'), 'split');
  assert.equal(await chat.locator('[data-assistant-document-context]').innerText(), 'Synthetic plan');
  assert.equal(await textarea.inputValue(), 'Keep this draft while opening a file');
  await textarea.fill('Tighten this document introduction');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => window.workspacePreview.requests.length >= 2);
  const requestContext = await page.evaluate(() => window.workspacePreview.requests.at(-1).body.extraSystem);
  assert.ok(requestContext.includes('fixture-document'));
  assert.ok(requestContext.includes('document_get'));
  assert.ok(requestContext.includes('Current workspace page: files'));
  await page.evaluate(() => window.workspacePreview.finishAgent());
  await snapshot('file-edits-beside-chat');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      artifacts,
      checks: [
        'actual composer + attachment identity',
        'empty Ask/Hold',
        'corner/split/full',
        'Search page navigation',
        'responsive owner retention',
        'mail shortcut isolation',
        'live stream survives presentation/breakpoint/close changes',
        'native-shaped dynamic draft tool renders without navigation or sending',
        'file edit review card opens Files beside chat without losing the conversation or draft',
        'Files uses the main chat with document context and an editable canvas',
        'opening rich text does not silently save a revision',
      ],
    }),
  );
} finally {
  await browser.close();
}
