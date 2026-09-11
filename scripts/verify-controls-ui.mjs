/** Run the --controls synthetic preview first. No real account or messages. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-controls-ui-'));
const origin = process.env.CONTROL_ORIGIN || 'http://127.0.0.1:18840';
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
    await page.goto(origin);
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
              shape: css.getPropertyValue('corner-shape'),
              border: css.borderColor,
              shadow: css.boxShadow,
            };
          }),
        );
      assert.equal(surfaces.length, 3);
      assert.deepEqual(surfaces[0], surfaces[1], 'Input and textarea should share a surface');
      assert.deepEqual(surfaces[0], surfaces[2], 'Select should share the field surface');
      assert.equal(surfaces[0].shadow, 'none');
      assert.equal(surfaces[0].shape, 'superellipse(1.475)');
      assert.equal(surfaces[0].radius, '14px');
      for (const control of [
        page.getByRole('button', { name: 'New document', exact: true }),
        page.getByRole('button', { name: 'Ask Albatross or get this off my mind', exact: true }),
        page.locator('[data-slot="card"]').first(),
      ]) {
        const geometry = await control.evaluate((el) => {
          const css = getComputedStyle(el);
          return { shape: css.getPropertyValue('corner-shape'), clip: css.clipPath, mask: css.maskImage };
        });
        assert.deepEqual(geometry, { shape: 'superellipse(1.475)', clip: 'none', mask: 'none' });
      }
      assert.equal(
        await page
          .getByRole('button', { name: 'Ask Albatross or get this off my mind', exact: true })
          .evaluate((el) => getComputedStyle(el).borderRadius),
        '14px',
      );
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
    assert.equal(
      await page
        .locator('[data-slot="select-content"]')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('corner-shape')),
      'superellipse(1.475)',
    );
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
    await page.getByRole('button', { name: 'Ask Albatross or get this off my mind', exact: true }).click();
    assert.equal(await page.getByRole('status').textContent(), 'Assistant opened');
    if (width >= 768) {
      assert.equal(await page.getByRole('button', { name: 'Get this off my mind', exact: true }).count(), 0);
      await page.getByRole('button', { name: /Search everything/ }).click();
      assert.equal(await page.getByRole('status').textContent(), 'Search opened');
      const avatar = await page.locator('.cl-userButtonAvatarBox').boundingBox();
      const image = await page.locator('.cl-userButtonAvatarImage').boundingBox();
      assert.deepEqual(avatar, image, 'Avatar mask and image bounds must match');
      assert.deepEqual(
        await page.locator('.cl-userButtonAvatarBox, .cl-userButtonAvatarImage').evaluateAll((els) =>
          els.map((el) => ({
            radius: getComputedStyle(el).borderRadius,
            shape: getComputedStyle(el).getPropertyValue('corner-shape'),
          })),
        ),
        [
          { radius: '50%', shape: 'round' },
          { radius: '50%', shape: 'round' },
        ],
      );
      await page.getByTitle('Toggle navigation rail').click();
      await page.waitForTimeout(500);
      const selected = page.locator('[data-sidebar="menu-button"][data-active="true"]');
      assert.notEqual(
        await selected.evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgba(0, 0, 0, 0)',
      );
      await selected.hover();
      await page.waitForTimeout(600);
      assert.equal(await page.locator('[data-slot="dock-tile-glow"]').count(), 0);
      assert.equal(await selected.evaluate((el) => getComputedStyle(el).boxShadow), 'none');
      for (const name of ['Search everything (⌘F or slash)', 'Files']) {
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.deepEqual(
      await dialog.evaluate((el) => ({
        radius: getComputedStyle(el).borderRadius,
        shape: getComputedStyle(el).getPropertyValue('corner-shape'),
      })),
      { radius: '14px', shape: 'superellipse(1.475)' },
    );
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('Still editable');
    await page.waitForTimeout(250); // Let the Radix enter animation finish before visual evidence.
    await page.screenshot({ path: join(artifacts, `controls-${width}-dialog.png`) });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(
      await page
        .getByRole('button', { name: 'Settings', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
  }
  await page.goto(`${origin}/?corners=compare`);
  await page.getByRole('region', { name: 'Corner comparison' }).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  assert.equal(
    await page
      .getByRole('button', { name: 'Circular control' })
      .evaluate((el) => getComputedStyle(el).getPropertyValue('corner-shape')),
    'round',
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Square override' })
      .evaluate((el) => getComputedStyle(el).borderRadius),
    '0px',
  );
  await page.screenshot({ path: join(artifacts, 'corner-comparison.png') });

  // Exercise the actual CSS fallback by removing the enhancement @supports
  // block. This is fallback simulation in Chromium, not a Safari acceptance run.
  const removed = await page.evaluate(() => {
    let removed = 0;
    function stripEnhancement(sheet) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const rule = sheet.cssRules[i];
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('corner-shape')) {
          sheet.deleteRule(i);
          removed++;
        } else if ('cssRules' in rule) stripEnhancement(rule);
      }
    }
    for (const sheet of document.styleSheets) stripEnhancement(sheet);
    return removed;
  });
  assert(removed > 0, 'Fallback test must remove the real enhancement block');
  await page.waitForTimeout(500); // Settle the launcher's radius transition.
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const field = page.getByRole('textbox', { name: 'Name', exact: true });
    await field.fill('Fallback stays usable');
    assert.deepEqual(
      await field.evaluate((el) => ({
        radius: getComputedStyle(el).borderRadius,
        shape: getComputedStyle(el).getPropertyValue('corner-shape'),
        focus: getComputedStyle(el).outlineWidth,
      })),
      { radius: '9.5px', shape: 'round', focus: '2px' },
    );
    await page.getByRole('button', { name: 'Ask Albatross or get this off my mind', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('status').textContent(), 'Assistant opened');
    assert.equal(
      await page
        .getByRole('button', { name: 'Ask Albatross or get this off my mind', exact: true })
        .evaluate((el) => getComputedStyle(el).borderRadius),
      '9.5px',
    );
    await page.screenshot({ path: join(artifacts, `controls-${width}-fallback.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(`Control UI acceptance passed. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
