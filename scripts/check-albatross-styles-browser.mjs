import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = process.env.ALBATROSS_STYLE_PREVIEW_URL || 'http://127.0.0.1:18859';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ['--no-sandbox'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin);
  await page.locator('[data-mail-thread-row]').first().waitFor();
  await page.evaluate(() => window.workspacePreview.state().setRailOpen(false));
  const mailStyles = await page
    .locator('[data-mail-thread-row]')
    .first()
    .evaluate((row) => {
      const style = getComputedStyle(row);
      const divider = getComputedStyle(row, '::after');
      const frame = document.querySelector('[data-mail-frame]');
      return {
        border: style.borderBottomWidth,
        dividerHeight: divider.height,
        dividerRadius: divider.borderRadius,
        searchPadding: getComputedStyle(frame.children[1]).paddingLeft,
        pageBackground: getComputedStyle(document.querySelector('.workspace-panel')).backgroundColor,
        mailBackground: getComputedStyle(frame).backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        dateBackground: getComputedStyle(document.querySelector('[data-mail-date-group]')).backgroundColor,
      };
    });
  assert.equal(mailStyles.border, '0px');
  assert.equal(mailStyles.dividerHeight, '1px');
  assert.equal(mailStyles.dividerRadius, '0px');
  assert.equal(mailStyles.searchPadding, '12px');
  assert.equal(mailStyles.mailBackground, mailStyles.pageBackground);
  assert.equal(mailStyles.pageBackground, mailStyles.bodyBackground);
  assert.equal(mailStyles.dateBackground, mailStyles.pageBackground);
  await page.locator('[data-assistant-launcher]').click();
  const header = page.locator('[data-assistant-header]:visible');
  await header.waitFor();
  assert.equal(await header.evaluate((element) => getComputedStyle(element).borderTopWidth), '0px');
  assert.equal(
    await header.evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.equal(await header.locator('button[data-variant="outline"]').count(), 5);
  const controls = header.getByRole('group', { name: 'Chat controls' });
  const controlBounds = await controls.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => ({
      left: button.getBoundingClientRect().left,
      right: button.getBoundingClientRect().right,
    })),
  );
  for (let index = 1; index < controlBounds.length; index += 1) {
    assert.equal(controlBounds[index].left, controlBounds[index - 1].right);
  }
  assert.equal(
    await header.locator('.siri-orb').evaluate((element) => getComputedStyle(element).overflow),
    'visible',
  );
  assert.equal(
    await page
      .locator('.assistant-workspace__halo')
      .evaluate((element) => getComputedStyle(element).backdropFilter),
    'none',
  );
  await page.screenshot({ path: '/tmp/albatross-style-mail-chat-light.png' });
  await page.evaluate(() => {
    document.documentElement.classList.replace('light', 'dark');
    document.documentElement.style.setProperty('--surface-tint', '0.25');
    document.documentElement.style.setProperty('--depth-spread', '1.6');
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/albatross-style-mail-chat-dark.png' });
  await page.evaluate(() => {
    window.workspacePreview.state().setAiBarOpen(false);
    window.workspacePreview.state().setRailOpen(true);
    document.documentElement.style.setProperty('--radius-ui', '18px');
    document.documentElement.style.setProperty('--corner-shape-ui', 'squircle');
  });
  await page.getByRole('button', { name: 'Resize navigation rail' }).waitFor();
  const rail = await page.locator('.rail-wash').evaluate((element) => {
    return {
      curve: getComputedStyle(element, '::after').content,
      background: getComputedStyle(element).backgroundColor,
      canvas: getComputedStyle(document.querySelector('.app-paper')).backgroundColor,
      border: getComputedStyle(element).borderRightWidth,
    };
  });
  assert.equal(rail.curve, 'none');
  assert.equal(rail.border, '0px');
  assert.equal(rail.background, rail.canvas);
  await page.screenshot({ path: '/tmp/albatross-style-frame-dark.png' });
  await page.evaluate(() => document.documentElement.classList.replace('dark', 'light'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/albatross-style-frame-light.png' });
  await page.evaluate(() => {
    document.documentElement.classList.replace('light', 'dark');
    window.workspacePreview.state().setRailOpen(false);
  });
  await page.evaluate(() => {
    window.workspacePreview.state().setAiBarOpen(false);
    window.workspacePreview.state().setPrimaryView('files');
  });
  await page.getByRole('textbox', { name: 'Search files' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Files', exact: true }).count(), 0);
  const filesSearch = await page.getByRole('textbox', { name: 'Search files' }).boundingBox();
  assert.ok(filesSearch.width > 700);
  await page.screenshot({ path: '/tmp/albatross-style-files-dark.png' });
  await page.goto(`${origin}/?review=styles`);
  await page.getByRole('button', { name: 'Brief preview', exact: true }).click();
  await page.evaluate(() => document.documentElement.classList.replace('light', 'dark'));
  await page.waitForTimeout(250);
  await page.locator('[data-brief-letter-row]').first().waitFor();
  const briefLane = page.locator('.brief-letter-lane').first();
  assert.notEqual(await briefLane.evaluate((element) => getComputedStyle(element).boxShadow), 'none');
  await briefLane.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: '/tmp/albatross-style-brief-dark.png' });

  await page.getByRole('button', { name: 'Work preview', exact: true }).click();
  await page.getByRole('button', { name: 'Open check-in', exact: true }).waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const widths = new Set();
  for (let index = 0; index < 18; index += 1) {
    await page.waitForTimeout(180);
    const launcher = await page.locator('[data-assistant-launcher]').evaluate((element) => {
      const shortcut = element.querySelector('kbd').getBoundingClientRect();
      const copy = element.querySelector('.assistant-launcher__copy').getBoundingClientRect();
      const phrase = element.querySelector('.assistant-launcher__phrases');
      const lastLetter = element.querySelector(
        '.assistant-launcher__phrase[data-active="true"] [data-letter]:last-child',
      );
      return {
        width: Math.round(element.getBoundingClientRect().width),
        shortcutRight: shortcut.right,
        copyLeft: copy.left,
        overflow: phrase.scrollWidth - phrase.clientWidth,
        lastLetterOverflow: lastLetter
          ? lastLetter.getBoundingClientRect().right - phrase.getBoundingClientRect().right
          : 0,
      };
    });
    widths.add(launcher.width);
    assert.ok(launcher.shortcutRight <= launcher.copyLeft);
    assert.ok(launcher.overflow <= 1, `Launcher clips ${launcher.overflow}px`);
    assert.ok(
      launcher.lastLetterOverflow <= 1,
      `Launcher clips its last letter by ${launcher.lastLetterOverflow}px`,
    );
  }
  assert.ok(widths.size > 1, 'Launcher must morph with the current phrase');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mode of ['light', 'dark']) {
    for (const depth of [0.4, 1, 1.6]) {
      await page.evaluate(
        ({ mode, depth }) => {
          document.documentElement.classList.toggle('dark', mode === 'dark');
          document.documentElement.style.setProperty('--depth-spread', String(depth));
          document.documentElement.style.setProperty('--radius-ui', '18px');
          document.documentElement.style.setProperty('--corner-shape-ui', 'squircle');
        },
        { mode, depth },
      );
      const surface = await page.locator('.workspace-panel').evaluate((element) => ({
        page: getComputedStyle(element).backgroundColor,
        card: getComputedStyle(element.querySelector('ul')).backgroundColor,
        radius: getComputedStyle(element.querySelector('button')).borderRadius,
        chipRadius: getComputedStyle(element.querySelector('[data-state]')).borderRadius,
      }));
      assert.notEqual(surface.page, surface.card);
      assert.equal(surface.radius, '18px');
      assert.equal(surface.chipRadius, '18px');
    }
  }
  await page.screenshot({ path: '/tmp/albatross-style-work-dark.png' });
  await page.getByRole('button', { name: 'Notifications preview', exact: true }).click();
  const title = await page.getByRole('heading', { name: 'Notifications', exact: true }).boundingBox();
  const filters = await page.getByRole('group', { name: 'Filter notifications' }).boundingBox();
  assert.ok(Math.abs(title.y + title.height / 2 - filters.y - filters.height / 2) < 2);
  await page.getByRole('button', { name: 'Questions', exact: false }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Questions', exact: false }).getAttribute('aria-pressed'),
    'true',
  );
  await page.screenshot({ path: '/tmp/albatross-style-notifications-dark.png' });
  await page.getByRole('button', { name: 'Open check-in', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Review the studio proposal work', exact: false }).click();
  const selected = page.getByRole('dialog').locator('[aria-pressed="true"]');
  assert.equal(await selected.count(), 1);
  const modal = await page.getByRole('dialog').evaluate((element) => ({
    surface: getComputedStyle(element).backgroundColor,
    section: getComputedStyle(element.querySelector('section')).backgroundColor,
    input: getComputedStyle(element.querySelector('textarea')).backgroundColor,
  }));
  assert.equal(new Set(Object.values(modal)).size, 3);
  await page.screenshot({ path: '/tmp/albatross-style-checkin-dark.png' });
  await page.evaluate(() => document.documentElement.classList.replace('dark', 'light'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/albatross-style-checkin-light.png' });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.getByRole('dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(errors, []);
  console.log(
    'Passed: surface hierarchy, straight dividers, custom corners, toolbar spacing, launcher morph, notification filters, check-in states, and narrow layouts.',
  );
} finally {
  await browser.close();
}
