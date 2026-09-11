/** Actual DocumentEditor + actual exports, synthetic loopback server18848 only. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-document-editors-'));
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    '/home/jjalangtry/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  let patches = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH') patches++;
  });
  const open = async (kind) => {
    await page.goto(`http://127.0.0.1:18848/?kind=${kind}`);
    await page.getByRole('textbox', { name: 'File name', exact: true }).waitFor();
    await page
      .getByRole('toolbar', {
        name: kind === 'deck' ? 'Presentation tools' : 'Document formatting',
        exact: true,
      })
      .waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const saved = async (kind) =>
    (await (await page.request.get(`http://127.0.0.1:18848/api/documents/${kind}`)).json()).document;
  const settle = async () => {
    await page.waitForFunction(
      () =>
        !document.querySelector('section[aria-label$=" editor"]')?.textContent.includes('Unsaved changes'),
    );
    await page.waitForTimeout(1200);
  };
  await page.request.post('http://127.0.0.1:18848/fixture-reset');
  await open('doc');
  await page.waitForTimeout(1200);
  assert.equal(patches, 0, 'Opening a document must not submit an edit');
  assert.equal(await page.locator('.ProseMirror ul li').count(), 1);
  assert.equal(await page.locator('.ProseMirror ol li').count(), 1);
  const body = page.locator('.ProseMirror [data-block-id="body"]');
  await body.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 8);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.closest('[contenteditable]').focus();
  });
  await page.keyboard.press('Control+b');
  assert.equal(await body.locator('strong').textContent(), 'A useful');
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Added note.');
  await settle();
  const afterTyping = await saved('doc');
  assert(afterTyping.model.blocks.find((block) => block.id === 'body').runs.some((run) => run.bold));
  assert(afterTyping.model.blocks.find((block) => block.id === 'body').text.includes('Added note.'));
  assert.deepEqual(
    afterTyping.model.blocks.map((block) => block.id),
    ['heading', 'body', 'bullet', 'number'],
  );
  await page.getByRole('combobox', { name: 'Paragraph style' }).selectOption('numbered');
  await page.waitForTimeout(100);
  assert.equal(await body.evaluate((element) => element.closest('ol') !== null), true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await body.evaluate((element) => element.closest('ol') !== null), false);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal(await body.evaluate((element) => element.closest('ol') !== null), true);
  await page.getByRole('button', { name: 'Move block up', exact: true }).click();
  await settle();
  const reordered = await saved('doc');
  assert.equal(reordered.model.blocks[0].id, 'body');
  await page.getByRole('button', { name: 'Back to Files', exact: true }).click();
  await page.getByRole('button', { name: 'Open document', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document text', exact: true }).waitFor();
  assert.equal(await page.locator('.ProseMirror [data-block-id="body"] strong').count(), 1);
  await page.locator('.ProseMirror [data-block-id="body"]').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.closest('[contenteditable]').focus();
  });
  await page.keyboard.insertText(' Export this edit.');
  // Deliberately do not wait for autosave. Download must flush the current draft.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Document', exact: true }).click();
  const download = await downloadPromise;
  const docx = await JSZip.loadAsync(await readFile(await download.path()));
  const docXml = await docx.file('word/document.xml').async('string');
  assert(docXml.includes('Added note.'));
  assert(docXml.includes('Export this edit.'));
  assert(docXml.includes('<w:b/>'));
  console.log('PASS: rich formatting, real lists, keyboard, reorder, undo/redo, save/reopen, DOCX export');

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await open('doc');
    // A long unbroken paragraph must grow vertically, never clip to textarea rows or overflow horizontally.
    const editor = page.getByRole('textbox', { name: 'Document text', exact: true });
    const longText = 'Readable text '.repeat(150) + 'unbroken'.repeat(80);
    await editor.fill(longText);
    await settle();
    const wrapped = await editor.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.scrollHeight,
      text: element.textContent,
      overflow: getComputedStyle(element).overflowY,
    }));
    assert.equal(wrapped.text, longText);
    assert(wrapped.scrollWidth <= wrapped.width + 1, `Long text overflow at ${width}`);
    assert(wrapped.height > 400, `Long paragraph should grow at ${width}`);
    assert.notEqual(wrapped.overflow, 'hidden');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifacts, `document-${width}-${theme}.png`) });
    }
  }
  await page.getByRole('textbox', { name: 'Document text', exact: true }).fill('');
  assert.equal(
    await page.locator('.ProseMirror').evaluate((element) => getComputedStyle(element, '::before').content),
    '"Start writing…"',
  );
  console.log('PASS: intrinsic long-text wrapping at390/1440 light/dark and empty prompt');

  await page.request.post('http://127.0.0.1:18848/fixture-reset');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await open('deck');
    await page.getByRole('button', { name: 'title object 2', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Object text', exact: true })
      .fill(`A beautiful working loop ${width}`);
    await page.getByRole('spinbutton', { name: 'Object font size', exact: true }).fill('36');
    await page.getByRole('button', { name: 'Shape', exact: true }).click();
    const shape = page.locator('button[data-element-id][data-selected="true"]');
    await shape.focus();
    const xBefore = Number(
      await page.getByRole('spinbutton', { name: 'Object x', exact: true }).inputValue(),
    );
    await page.keyboard.press('ArrowRight');
    assert.equal(
      Number(await page.getByRole('spinbutton', { name: 'Object x', exact: true }).inputValue()),
      xBefore + 1,
    );
    await page.getByRole('spinbutton', { name: 'Object width', exact: true }).fill('28');
    await page.locator('summary').filter({ hasText: 'Speaker notes' }).click();
    await page
      .getByRole('textbox', { name: 'Speaker notes', exact: true })
      .fill('Explain the narrative connection.');
    await page.getByRole('button', { name: 'Duplicate slide', exact: true }).click();
    await page.getByRole('button', { name: 'Move slide earlier', exact: true }).click();
    await settle();
    const deck = await saved('deck');
    assert.equal(deck.model.slides[0].id, deck.model.activeSlideId);
    assert.equal(
      new Set(deck.model.slides.flatMap((slide) => slide.elements.map((element) => element.id))).size,
      deck.model.slides.reduce((count, slide) => count + slide.elements.length, 0),
    );
    assert.equal(
      await page
        .locator('[aria-label="Presentation editing workspace"]')
        .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      false,
    );
    await page.getByRole('button', { name: 'Present', exact: true }).click();
    const player = page.getByRole('dialog', { name: 'Presentation', exact: true });
    await player.waitFor();
    await page.keyboard.press('End');
    assert.equal(
      await player.getByRole('status').textContent(),
      `Slide ${deck.model.slides.length} of ${deck.model.slides.length}`,
    );
    await page.keyboard.press('Home');
    assert.equal(await player.getByRole('status').textContent(), `Slide 1 of ${deck.model.slides.length}`);
    await page.screenshot({ path: join(artifacts, `present-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await player.count(), 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'Present', exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifacts, `presentation-${width}-${theme}.png`) });
    }
    const pptxDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Presentation', exact: true }).click();
    const output = await pptxDownload;
    const archive = await JSZip.loadAsync(await readFile(await output.path()));
    assert(
      (await archive.file('ppt/slides/slide1.xml').async('string')).includes(
        `A beautiful working loop ${width}`,
      ),
    );
    assert(
      (await archive.file('ppt/notesSlides/notesSlide1.xml').async('string')).includes(
        'Explain the narrative connection.',
      ),
    );
    await page.getByRole('button', { name: 'Back to Files', exact: true }).click();
    await page.getByRole('button', { name: 'Open presentation', exact: true }).click();
    await page.getByRole('navigation', { name: 'Slides', exact: true }).waitFor();
    assert.equal((await saved('deck')).model.slides[0].title, `A beautiful working loop ${width}`);
  }
  console.log(
    'PASS: slides/objects/geometry/keyboard/notes/duplicate/reorder/present/Escape/save/reopen/PPTX at390/1440',
  );
  await page.request.post('http://127.0.0.1:18848/fixture-reset');
  await open('google');
  assert.equal(await page.getByRole('button', { name: 'Bold', exact: true }).count(), 0);
  await page.getByRole('textbox', { name: 'Document text', exact: true }).fill('Google stays plain.');
  await page.keyboard.press('Control+b');
  await page.keyboard.insertText(' Still plain.');
  await page.getByRole('textbox', { name: 'Document text', exact: true }).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/html', '<b>Copied formatting</b>');
    data.setData('text/plain', 'Copied formatting');
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await settle();
  assert((await saved('doc')).model.blocks.every((block) => !block.runs));
  assert(
    (await page.getByRole('status').allTextContents()).some((text) => text.includes('Pasted as plain text')),
  );
  console.log('PASS: direct Google provider-safe editing cannot introduce unsupported rich marks');
  await open('doc');
  await page.getByRole('textbox', { name: 'Document text', exact: true }).focus();
  await page.getByRole('textbox', { name: 'Document text', exact: true }).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/html', '<table><tr><td>Table content</td></tr></table>');
    data.setData('text/plain', 'Table content');
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await settle();
  assert((await saved('doc')).model.blocks.some((block) => block.text.includes('Table content')));
  assert(
    (await page.getByRole('status').allTextContents()).some((text) => text.includes('Pasted text only')),
  );
  assert.equal(await page.locator('.ProseMirror table').count(), 0);
  console.log('PASS: unsupported Office paste retains text with an explicit limitation notice');
  // Settled editorial screenshots are separate from the stress-test captures.
  await page.request.post('http://127.0.0.1:18848/fixture-reset');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const kind of ['doc', 'deck']) {
      await open(kind);
      if (kind === 'deck') await page.getByRole('button', { name: 'title object 2', exact: true }).click();
      for (const theme of ['light', 'dark']) {
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle('dark', dark);
          document.activeElement?.blur();
        }, theme === 'dark');
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(artifacts, `${kind}-editor-${width}-${theme}.png`) });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Document editor UI acceptance passed. Screenshots: ${artifacts}`);
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(artifacts, 'failure.png') });
  console.error(`Failure artifacts: ${artifacts}; page errors: ${JSON.stringify(errors)}`);
  throw error;
} finally {
  await browser.close();
}
