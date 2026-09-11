/** Actual shell and calendar controls; synthetic transport, no account writes. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp('/tmp/albatross-staging-annotations-');
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
const origin = 'http://127.0.0.1:18847';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const styles = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return { radius: style.borderTopLeftRadius, corner: style.cornerShape, fill: style.backgroundColor };
    });
  const snapshot = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator('[data-slot="dropdown-menu-content"][data-state="closed"]')
      .waitFor({ state: 'detached' });
    await page.screenshot({ path: `${artifacts}/${name}.png` });
  };
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin);
      await page.locator('[data-mail-frame]').waitFor();
      await page.locator('[data-mail-thread-row]').first().waitFor();
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
        theme,
      );
      const button = await styles(page.getByRole('button', { name: 'Compose', exact: true }));
      const frame = await styles(page.locator('[data-workspace-panel]'));
      assert.equal(frame.radius, '14px', 'mail uses the shared panel radius');
      assert.equal(frame.corner, button.corner, 'mail uses the button corner shape');
      const group = await styles(page.locator('[data-mail-date-group]').first());
      assert.equal(group.fill, frame.fill, 'date groups sit on the inbox background');
      for (const name of ['Main', 'Codes', 'Orders', 'Noise', 'Folders']) {
        const filter = await styles(page.getByRole('button', { name, exact: true }));
        assert.equal(filter.radius, button.radius, name);
        assert.equal(filter.corner, button.corner, name);
      }
      const launcher = page.locator('[data-assistant-launcher]');
      assert.equal(await launcher.locator('svg').count(), 0);
      assert.equal(
        await launcher.locator('[data-active="true"]').evaluate((el) => getComputedStyle(el).fontWeight),
        '400',
      );
      await page.waitForTimeout(800);
      await snapshot(`mail-${width}-${theme}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width >= 768) {
        const utilities = page.locator('[data-rail-utilities]');
        const toggle = utilities.getByRole('button', { name: 'Toggle Sidebar' });
        const bell = utilities.getByRole('button', { name: 'Notifications' });
        let a = await toggle.boundingBox();
        let b = await bell.boundingBox();
        assert.ok(Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 1);
        assert.ok(a.x >= b.x + b.width, 'expanded notifications before collapse');
        assert.equal(
          await page
            .locator('[data-sidebar="footer"]')
            .getByRole('button', { name: 'Notifications' })
            .count(),
          0,
        );
        for (const name of ['New area', 'Activity']) {
          const control = await styles(page.getByRole('button', { name, exact: true }));
          assert.equal(control.radius, button.radius);
          assert.equal(control.corner, button.corner);
        }
        await toggle.click();
        await page.waitForTimeout(500);
        a = await toggle.boundingBox();
        b = await bell.boundingBox();
        assert.ok(Math.abs(a.x + a.width / 2 - b.x - b.width / 2) < 1);
        assert.ok(b.y >= a.y + a.height, 'collapsed notifications below expand');
        await snapshot(`collapsed-${width}-${theme}`);
        await bell.click();
        assert.equal(await bell.getAttribute('aria-current'), 'page');
        assert.equal(await page.evaluate(() => window.workspacePreview.state().primaryView), 'notifications');
        await page.getByRole('button', { name: 'Mail', exact: true }).click();
        await toggle.click();
      }
    }
  }

  // Observe different word opacities during a reveal, with stable total width.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  const launcher = page.locator('[data-assistant-launcher]');
  await launcher.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const before = await launcher.boundingBox();
  await page.mouse.move(500, 300);
  const phrase = await launcher.getAttribute('data-phrase');
  await page.waitForFunction(
    (phrase) => document.querySelector('[data-assistant-launcher]')?.dataset.phrase !== phrase,
    phrase,
  );
  await page.waitForTimeout(120);
  const opacities = await launcher
    .locator('[data-active="true"] [data-letter]')
    .evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)));
  assert.ok(
    opacities.length > 1 && Math.max(...opacities) > Math.min(...opacities),
    'words fade incrementally',
  );
  assert.ok(
    Math.abs((await launcher.boundingBox()).width - before.width) < 0.5,
    'phrases reserve stable width',
  );
  await launcher.hover();
  assert.equal(await launcher.getAttribute('data-rotating'), 'false');
  await page.mouse.move(500, 300);
  await launcher.focus();
  assert.equal(await launcher.getAttribute('data-rotating'), 'false');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('[data-assistant-launcher]')?.dataset.rotating === 'false',
  );
  assert.equal(
    await launcher.locator('[data-active="true"] [data-letter]').count(),
    0,
    'reduced motion renders plain text',
  );
  assert.ok(await launcher.locator('[data-active="true"]').isVisible());
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  for (const theme of ['light', 'dark']) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?review=controls`);
      await page.locator('[data-calendar-date-controls]').waitFor();
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
        theme,
      );
      await page.waitForTimeout(600);
      const date = page.locator('[data-calendar-date-controls]');
      const tablist = page.locator('[role=tablist]');
      const control = await styles(page.getByRole('button', { name: 'Add Event' }));
      assert.equal((await styles(tablist)).radius, control.radius);
      assert.equal(
        await page.locator('.calendar-toolbar__surface').evaluate((el) => getComputedStyle(el).boxShadow),
        'none',
      );
      for (const name of ['Go to today', 'Previous date range', 'Next date range']) {
        assert.equal(await date.getByRole('button', { name }).getAttribute('data-variant'), 'ghost');
      }
      const original = await date.innerText();
      await date.getByRole('button', { name: 'Next date range' }).click();
      assert.notEqual(await date.innerText(), original);
      await date.getByRole('button', { name: 'Go to today' }).click();
      assert.equal(await date.innerText(), original);
      if (width === 390) {
        await page.getByRole('button', { name: 'Calendar display options' }).click();
        await page.getByRole('menuitem', { name: 'Grow hours' }).click();
        await page.getByRole('button', { name: 'Calendar display options' }).click();
        await page.getByRole('menuitem', { name: 'Shrink hours' }).click();
      }
      assert.equal(await page.locator('[data-narrative-lede]').count(), 1);
      assert.equal(await page.locator('[data-narrative-body] p').count(), 2);
      await snapshot(`calendar-brief-${width}-${theme}`);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'controls fit viewport',
      );
    }
  }

  // Every destination and assistant presentation shares one mounted frame.
  await page.setViewportSize({ width: 1046, height: 841 });
  await page.goto(`${origin}/?view=today`);
  await page.locator('[data-narrative-lede]').waitFor();
  assert.equal(
    await page.getByText('Your brief is ready; its working surface couldn’t load. Retry').count(),
    0,
  );
  await page.getByText('Make room for the studio proposal', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-drop-cap]')?.style.height);
  const lede = page.locator('[data-narrative-lede]');
  assert.equal(
    await lede.textContent(),
    'Give the studio proposal your first clear hour. Everything else today can fit around it.',
  );
  assert.ok(
    await lede.locator('[data-drop-cap]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize) > 50),
    'the initial is enlarged by the drop-cap library',
  );
  assert.equal(
    (await styles(page.locator('[data-brief-document-version]'))).fill,
    (await styles(page.locator('[data-workspace-panel]'))).fill,
    'Today uses the same content fill',
  );
  assert.ok(
    await page
      .locator('[data-brief-art-frame]')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) === 0),
    'art fills its frame',
  );
  await lede.scrollIntoViewIfNeeded();
  await snapshot('today-drop-cap');
  const panel = page.locator('[data-workspace-panel]');
  await panel.evaluate((el) => {
    el.dataset.sentinel = 'same-frame';
  });
  assert.equal(await panel.evaluate((el) => getComputedStyle(el).margin), '6px');
  const resize = page.getByRole('button', { name: 'Resize navigation rail' });
  assert.equal(await resize.evaluate((el) => getComputedStyle(el).position), 'absolute');
  const checkGutter = async () => {
    // Reset animates the rail; compare the settled panel and resize boundary.
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-workspace-panel]').getBoundingClientRect();
      const resize = document.querySelector('[aria-label="Resize navigation rail"]').getBoundingClientRect();
      return Math.abs(panel.x - (resize.x + resize.width / 2) - 6) < 1;
    });
  };
  await checkGutter();
  const handle = await resize.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(handle.x + 43, 300);
  await page.mouse.up();
  await checkGutter();
  await resize.dblclick();
  await checkGutter();
  for (const name of ['Calendar', 'Mail', 'Files', 'Activity', 'Albatrosses', 'Today']) {
    await page.getByRole('button', { name, exact: true }).click();
    assert.equal(await panel.getAttribute('data-sentinel'), 'same-frame');
    assert.equal(await panel.count(), 1);
  }
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  assert.equal(await page.getByRole('navigation', { name: 'File locations' }).count(), 0);
  assert.equal((await styles(page.locator('section[aria-label="Files"]'))).fill, (await styles(panel)).fill);
  await page.getByRole('button', { name: 'File location', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Albatross', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'File location', exact: true }).innerText(),
    'Albatross',
  );
  await page.getByRole('button', { name: 'File location', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'All files', exact: true }).click();
  await page.getByText('North House proposal', { exact: true }).waitFor();
  assert.equal(await page.getByText('Files could not refresh', { exact: true }).count(), 0);
  await page.getByRole('textbox', { name: 'Search files', exact: true }).fill('Cabin');
  await page.waitForFunction(() => !document.body.innerText.includes('North House proposal'));
  await page.getByText('Cabin weekend', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search files', exact: true }).fill('');
  await page.getByText('North House proposal', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await snapshot('files-location-picker');
  await page.getByText('North House proposal', { exact: true }).click();
  await page.getByRole('textbox', { name: 'File name', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'File name', exact: true }).inputValue(),
    'North House proposal',
  );
  await page.getByRole('textbox', { name: 'Document text', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to Files', exact: true }).click();
  await page.getByRole('button', { name: 'File location', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const chat = page.locator('[data-assistant-chat]');
  const workspace = page.locator('[data-assistant-workspace]');
  assert.equal(await workspace.getAttribute('data-layout'), 'full', 'sidebar Chat opens a full page');
  const draft = chat.locator('textarea');
  await draft.fill('Keep this draft through layout changes');
  await chat.getByRole('button', { name: 'Show current page' }).click();
  assert.equal(await workspace.getAttribute('data-layout'), 'split');
  assert.equal(await draft.inputValue(), 'Keep this draft through layout changes');
  const splitBounds = await panel.boundingBox();
  const chatBounds = await chat.boundingBox();
  assert.ok(Math.abs(splitBounds.y + 1 - chatBounds.y) < 1, 'split reaches the outer panel top');
  assert.equal(await chat.evaluate((el) => getComputedStyle(el).borderRadius), '0px');
  assert.ok(
    await page.locator('[data-calendar-toolbar]').evaluate((el) => el.scrollWidth <= el.clientWidth),
    'narrow calendar toolbar fits within split',
  );
  await page.getByRole('button', { name: 'Calendar view', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Week', exact: true }).click();
  await page.locator('[data-calendar-week-day]').first().waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-calendar-week-day]')].every(
      (day) => getComputedStyle(day).opacity === '1',
    ),
  );
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-calendar-week-day]').count(), 7);
  assert.ok(
    await page
      .locator('[data-calendar-week-day]')
      .evaluateAll((days) => days.every((day) => day.scrollWidth <= day.clientWidth)),
    'weekday labels fit their narrow columns',
  );
  await snapshot('calendar-split-1046');
  const shape = await styles(chat.getByRole('button', { name: 'Send', exact: true }));
  assert.equal(shape.radius, '14px');
  assert.equal(shape.corner, 'superellipse(1.475)');
  for (const [selector, radius] of [
    ['[data-route]', '14px'],
    ['.control-field:has(textarea)', '14px'],
    ['button:has-text("Triage my newest")', '14px'],
  ]) {
    const target = chat.locator(selector);
    const style = await styles(target);
    assert.equal(style.radius, radius, selector);
    assert.equal(style.corner, shape.corner, selector);
  }
  await chat.getByRole('button', { name: 'Return to corner chat' }).click();
  await chat.getByRole('button', { name: 'Focus on chat' }).click();
  assert.equal(await workspace.getAttribute('data-layout'), 'full', 'corner can go directly to full');
  assert.equal(await draft.inputValue(), 'Keep this draft through layout changes');
  await snapshot('chat-full-1046');
  assert.deepEqual(errors, []);
  console.log(`Staging annotation acceptance passed: ${artifacts}`);
} finally {
  await browser.close();
}
