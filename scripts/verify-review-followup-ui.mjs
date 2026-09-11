/** Follow-up review: real surfaces and synthetic requests; no provider writes. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp('/tmp/albatross-review-followup-');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = 'http://127.0.0.1:18847';
  for (const width of [390, 768, 1046, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?view=calendar`);
    await page.locator('[data-calendar-color-bar]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[data-sync-status][data-state=idle]').waitFor();
    const status = page.locator('[data-sync-status]');
    assert.equal(await status.innerText(), '');
    assert.ok((await status.getAttribute('aria-label')).includes('Synced'));
    assert.equal(await status.locator('svg').count(), 1);
    assert.equal(
      await page
        .locator('[data-calendar-color-bar]')
        .getByRole('button', { name: 'Change colour for Studio calendar' })
        .count(),
      1,
    );
    assert.ok(
      await page.locator('[data-calendar-toolbar]').evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.ok(
      await page.locator('[data-calendar-date-controls] > div').evaluate((el) => {
        const [label, arrows] = el.children;
        return arrows.getBoundingClientRect().left - label.getBoundingClientRect().right <= 9;
      }),
      'arrows stay beside the date',
    );
    await status.hover();
    await page.getByRole('tooltip').waitFor();
    assert.ok((await page.getByRole('tooltip').innerText()).includes('Sync now'));
    const before = await page.evaluate(
      () => window.workspacePreview.calls.filter((c) => c === 'POST /api/calendar/resync').length,
    );
    await status.evaluate((el) => {
      window.syncTransitions = [];
      const observer = new MutationObserver(() => {
        window.syncTransitions.push(el.dataset.state);
        if (el.dataset.state === 'syncing') el.click();
        else if (window.syncTransitions.includes('syncing')) observer.disconnect();
      });
      observer.observe(el, { attributes: true, attributeFilter: ['data-state'] });
    });
    await status.click();
    await page.waitForFunction(
      () => window.syncTransitions.includes('syncing') && window.syncTransitions.at(-1) === 'idle',
    );
    assert.equal(
      await page.evaluate(
        () => window.workspacePreview.calls.filter((c) => c === 'POST /api/calendar/resync').length,
      ),
      before + 1,
    );
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${artifacts}/calendar-${width}.png` });
    await page.goto(`${origin}/?view=today`);
    const frame = page.locator('[data-brief-art-frame]');
    await frame.waitFor();
    await page.locator('[data-brief-header-weather]').waitFor();
    assert.ok(
      await frame.evaluate((el) => {
        const page = document.querySelector('[data-brief-document-version]');
        page.scrollTop = 0;
        const r = el.getBoundingClientRect(),
          p = page.getBoundingClientRect();
        return (
          Math.abs(r.left - p.left - 12) < 1 &&
          Math.abs(r.top - p.top - 12) < 1 &&
          Math.abs(page.clientWidth - (r.right - p.left) - 12) < 1 &&
          getComputedStyle(el).padding === '0px'
        );
      }),
      'flush artwork and equal gutters',
    );
    const weather = await page.locator('[data-brief-header-weather]').boundingBox();
    const title = await frame.locator('h1').boundingBox();
    const artwork = await frame.boundingBox();
    const narrative = await page.locator('[data-brief-column=narrative]').boundingBox();
    assert.ok(weather.y >= title.y + title.height, 'weather sits below the edition title');
    assert.ok(
      weather.x >= artwork.x && weather.x + weather.width <= artwork.x + artwork.width,
      'weather fits its artwork',
    );
    assert.ok(weather.y + weather.height < artwork.y + artwork.height, 'weather stays inside the header');
    assert.equal(
      await page.locator('[data-slot=weather-widget]').count(),
      0,
      'the standalone weather card is gone',
    );
    assert.ok((await page.locator('[data-brief-header-weather]').innerText()).includes('Precip. 15%'));
    assert.ok(Math.abs(narrative.x - artwork.x - 12) < 1, 'the text retains its original 24px reading inset');
    assert.ok(
      Math.abs(narrative.width - artwork.width + 24) < 1,
      'both text margins retain their former size',
    );
    assert.equal(
      await page
        .locator('[data-today-thread] [data-slot=card-content]')
        .first()
        .evaluate((el) => getComputedStyle(el).paddingLeft),
      width < 640 ? '8px' : '10px',
      'working card padding is halved',
    );
    assert.ok(
      await page
        .locator('[data-narrative-body] p')
        .evaluateAll(
          (paragraphs) =>
            paragraphs.length > 0 && paragraphs.every((p) => parseFloat(getComputedStyle(p).textIndent) > 0),
        ),
      'supporting narrative paragraphs have a first-line indent',
    );
    await page.screenshot({ path: `${artifacts}/today-${width}.png` });
  }
  await page.setViewportSize({ width: 1046, height: 841 });
  await page.goto(`${origin}/?view=files`);
  await page.getByRole('textbox', { name: 'Search files' }).waitFor();
  assert.equal((await page.getByRole('textbox', { name: 'Search files' }).boundingBox()).height, 32);
  assert.equal(await page.getByText('One place for the work behind your work').count(), 0);
  await page.goto(`${origin}/?view=files&document=preview-document-2`);
  await page.getByRole('textbox', { name: 'File name', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit with Albatross' }).click();
  const workspace = page.locator('[data-assistant-workspace]');
  assert.equal(await workspace.getAttribute('data-layout'), 'split');
  assert.equal(await page.getByRole('complementary', { name: 'Document assistant', exact: true }).count(), 0);
  await page.locator('[data-assistant-document-context]').waitFor();
  assert.equal(await page.locator('[data-document-workspace] fieldset[inert]').count(), 0);
  const background = await page
    .locator('[data-workspace-panel]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(
    await page
      .getByRole('toolbar', { name: 'Document formatting' })
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    background,
  );
  await page.screenshot({ path: `${artifacts}/document-chat.png` });

  // A clicked invitation, including one reached by rotation, becomes the
  // personalized heading. The chat remains one owner while navigation closes it.
  await page.goto(`${origin}/?view=today`);
  const launcher = page.locator('[data-assistant-launcher]');
  const chat = page.locator('[data-assistant-chat]');
  const textarea = chat.locator('textarea');
  await launcher.waitFor();
  await page.mouse.move(500, 200);
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-launcher]')?.dataset.phrase === '1',
  );
  await launcher.hover();
  const phrase = await launcher.locator('[data-active=true]').innerText();
  await launcher.click();
  const expected = `${phrase.replace(/[.!?]$/, '')}, Alex${phrase.match(/[.!?]$/)?.[0] || ''}`;
  assert.equal(await chat.locator('[data-assistant-greeting]').innerText(), expected);
  await textarea.press('Control+k');
  await launcher.hover();
  const keyboardPhrase = await launcher.locator('[data-active=true]').innerText();
  await page.keyboard.press('Control+k');
  assert.equal(
    await chat.locator('[data-assistant-greeting]').innerText(),
    `${keyboardPhrase.replace(/[.!?]$/, '')}, Alex${keyboardPhrase.match(/[.!?]$/)?.[0] || ''}`,
  );
  assert.equal(await chat.getByText('How can I help?', { exact: true }).count(), 0);
  assert.equal(
    await chat.getByText('Bring a question, a draft, or something on your mind.', { exact: false }).count(),
    0,
  );
  await textarea.fill('Keep my draft while I change pages');
  await textarea.evaluate((el) => {
    el.dataset.owner = 'original';
  });
  for (const destination of ['Today', 'Albatrosses', 'Files', 'Calendar', 'Mail', 'Activity']) {
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.equal(await chat.getAttribute('data-layout'), 'full');
    await page.getByRole('button', { name: destination, exact: true }).click();
    assert.equal(await chat.getAttribute('data-layout'), 'closed', `Chat → ${destination} does not split`);
    assert.equal(await textarea.inputValue(), 'Keep my draft while I change pages');
    assert.equal(await textarea.getAttribute('data-owner'), 'original');
  }
  await launcher.click();
  await chat.getByRole('button', { name: 'Expand chat beside this page' }).click();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  assert.equal(await chat.getAttribute('data-layout'), 'split', 'a deliberate split survives navigation');
  const shape = (locator) =>
    locator.evaluate((el) => ({
      radius: getComputedStyle(el).borderTopLeftRadius,
      corner: getComputedStyle(el).cornerShape,
    }));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
      theme,
    );
    const reference = await shape(chat.getByRole('button', { name: 'Close', exact: true }));
    for (const control of [
      page.getByRole('button', { name: /^Search everything/ }),
      chat.locator('[data-assistant-header]'),
    ]) {
      assert.deepEqual(await shape(control), reference);
      assert.ok((await control.getAttribute('class')).includes('rounded-ui'));
    }
    assert.deepEqual(
      await shape(chat.locator('.control-field.cursor-text')),
      {
        radius: '14px',
        corner: reference.corner,
      },
      'the composer uses the card size of the shared curve',
    );
    const header = await chat.locator('[data-assistant-header]').boundingBox();
    const pane = await chat.boundingBox();
    assert.ok(header.x > pane.x && header.x + header.width < pane.x + pane.width, 'soft header is inset');
    await page.screenshot({ path: `${artifacts}/chat-invitation-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, artifacts }));
} finally {
  await browser.close();
}
