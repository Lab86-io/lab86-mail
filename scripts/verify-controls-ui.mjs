/** Run the --controls synthetic preview first. No real account or messages. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-controls-ui-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:18840/');
    await page.getByRole('heading', { name: 'A place for your work.' }).waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const surfaces = await page
        .locator('input[aria-label="Name"],textarea[aria-label="Notes"],[aria-label="Location"]')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const css = getComputedStyle(element);
            return {
              fill: css.backgroundColor,
              radius: css.borderRadius,
              border: css.borderColor,
              shadow: css.boxShadow,
            };
          }),
        );
      assert.equal(surfaces.length, 3);
      assert.deepEqual(surfaces[0], surfaces[1], 'Input and textarea should share a surface');
      assert.deepEqual(surfaces[0], surfaces[2], 'Select should share the field surface');
      assert.equal(surfaces[0].shadow, 'none');
      await page.getByRole('textbox', { name: 'Name', exact: true }).focus();
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Name', exact: true })
          .evaluate((el) => getComputedStyle(el).outlineWidth),
        '2px',
      );
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Release notes');
      await page.getByRole('button', { name: 'New document', exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.getByRole('status').textContent(), 'Create clicked');
      await page.getByRole('button', { name: 'New document', exact: true }).evaluate((el) => el.blur());
      await page.screenshot({ path: join(artifacts, `controls-${width}-${theme}.png`) });
    }
    await page.getByRole('combobox', { name: 'Location' }).click();
    await page.getByRole('option', { name: 'Google Drive' }).click();
    assert.match(await page.getByRole('combobox', { name: 'Location' }).innerText(), /Google Drive/);
    await page.getByRole('tab', { name: 'List', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('[role="tab"][data-state="active"]').filter({ hasText: 'Grid' }).waitFor();
    assert.equal(
      await page.getByRole('tab', { name: 'Grid', exact: true }).getAttribute('data-state'),
      'active',
    );
    await page.getByRole('button', { name: 'Show recent only' }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Show recent only' }).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(await page.getByRole('button', { name: 'Unavailable', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('status').textContent(), 'Draft opened for editing');
    assert.equal(await page.locator('[data-slot="message-draft"]').getAttribute('data-state'), 'review');
    assert.equal(await page.getByLabel('Message sent', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Ask Assistant', exact: true }).click();
    assert.equal(await page.getByRole('status').textContent(), 'Assistant opened');
    if (width >= 768) {
      await page.getByRole('button', { name: 'Get this off my mind', exact: true }).click();
      assert.equal(await page.getByRole('status').textContent(), 'Capture opened');
      await page.getByRole('button', { name: /Search everything/ }).click();
      assert.equal(await page.getByRole('status').textContent(), 'Search opened');
      const avatar = await page.locator('.cl-userButtonAvatarBox').boundingBox();
      const image = await page.locator('.cl-userButtonAvatarImage').boundingBox();
      assert.deepEqual(avatar, image, 'Avatar mask and image bounds must match');
      await page.getByTitle('Toggle navigation rail').click();
      await page.waitForTimeout(500);
      const selected = page.locator('[data-active="true"]');
      assert.notEqual(
        await selected.evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgba(0, 0, 0, 0)',
      );
      await selected.hover();
      await page.waitForTimeout(600);
      assert.equal(await page.locator('[data-slot="dock-tile-glow"]').count(), 0);
      assert.equal(await selected.evaluate((el) => getComputedStyle(el).boxShadow), 'none');
      for (const name of ['Get this off my mind', 'Search everything (⌘F or slash)', 'Files']) {
        const button = page.getByRole('button', { name, exact: true });
        const b = await button.boundingBox();
        const glyph = await button.locator('svg').first().boundingBox();
        assert(
          b && glyph && Math.abs(b.x + b.width / 2 - glyph.x - glyph.width / 2) < 1,
          `${name}: centered glyph`,
        );
      }
      await page.screenshot({ path: join(artifacts, `controls-${width}-collapsed.png`) });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Control UI acceptance passed. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
