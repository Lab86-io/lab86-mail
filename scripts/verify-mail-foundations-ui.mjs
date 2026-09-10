/** Real Mail row / mailbox controls against synthetic data, desktop and narrow web. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-mail-foundations-ui-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
const evidence = [];
try {
  const page = await browser.newPage();
  const errors = [];
  const apiRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  const mailRows = page.locator('[data-mail-thread-row]');
  const rowFor = (name) => mailRows.filter({ hasText: name });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:18844/');
    await page.getByRole('heading', { name: 'Mail foundations' }).waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    assert.equal(
      await page.evaluate(() =>
        [...document.fonts].some((font) => font.family === 'Fraunces' && font.status === 'loaded'),
      ),
      true,
      'Visual acceptance uses the actual display font, not a system fallback',
    );
    await rowFor('River Studio').getByRole('img').waitFor();
    assert.equal(await rowFor('River Studio').locator('img').count(), 0, 'Failed image must become initials');
    assert.equal(
      await rowFor('Alex Morgan').locator('img').count(),
      0,
      'Unknown sender starts with initials',
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-mail-thread-row] img')].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `${width}/${theme}: no horizontal overflow`,
      );
      const geometry = await page
        .getByRole('button', { name: /^Which mailbox: (Work|Personal) mailbox$/ })
        .evaluateAll((triggers) =>
          triggers.map((trigger) => {
            const ring = trigger.firstElementChild;
            const content = ring.firstElementChild;
            const box = (element) => {
              const bounds = element.getBoundingClientRect();
              return {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                centerX: bounds.x + bounds.width / 2,
                centerY: bounds.y + bounds.height / 2,
              };
            };
            const ringStyle = getComputedStyle(ring);
            const contentStyle = getComputedStyle(content);
            return {
              trigger: box(trigger),
              ring: box(ring),
              content: box(content),
              border: [
                ringStyle.borderTopWidth,
                ringStyle.borderRightWidth,
                ringStyle.borderBottomWidth,
                ringStyle.borderLeftWidth,
              ].map(parseFloat),
              ringColor: ringStyle.borderColor,
              shadows: [getComputedStyle(trigger).boxShadow, ringStyle.boxShadow, contentStyle.boxShadow],
              shape: ringStyle.getPropertyValue('corner-shape'),
            };
          }),
        );
      assert.equal(geometry.length, 4);
      for (const avatar of geometry) {
        assert.equal(avatar.trigger.width, avatar.trigger.height, 'Mailbox hit target is square');
        assert.equal(avatar.ring.width, avatar.ring.height, 'Visible sender ring is square');
        assert.equal(avatar.ring.width, 28, 'Retain compact sender identity size');
        assert(avatar.trigger.width > avatar.ring.width, 'Larger hit target is separate from visible ring');
        for (const axis of ['centerX', 'centerY']) {
          assert(
            Math.abs(avatar.trigger[axis] - avatar.ring[axis]) < 0.1,
            'Visible ring is centered in target',
          );
          assert(
            Math.abs(avatar.ring[axis] - avatar.content[axis]) < 0.1,
            'Image/initials center exactly matches colored ring',
          );
        }
        assert(
          Math.abs(avatar.content.width + avatar.border[1] + avatar.border[3] - avatar.ring.width) < 0.1,
          'Image fills the ring content box',
        );
        assert(
          Math.abs(avatar.content.height + avatar.border[0] + avatar.border[2] - avatar.ring.height) < 0.1,
          'Image fills the ring content box vertically',
        );
        assert.deepEqual(
          avatar.shadows,
          ['none', 'none', 'none'],
          'No second border via inset or outer shadow',
        );
        assert.equal(avatar.shape, 'round', 'Sender identity remains circular with custom corner theme');
      }
      const separators = await page.evaluate(() => {
        const firstRow = document.querySelector('[data-mail-thread-row]');
        const rowStyle = getComputedStyle(firstRow);
        const group = document.querySelector('[data-mail-date-group]');
        const line = group.lastElementChild;
        const pixel = (color) => {
          const context = document.createElement('canvas').getContext('2d');
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        return {
          rowWidth: rowStyle.borderBottomWidth,
          rowColor: pixel(rowStyle.borderBottomColor),
          contentColor: pixel(
            getComputedStyle(document.querySelector('[aria-label="Mail workspace"]')).backgroundColor,
          ),
          lineHeight: line.getBoundingClientRect().height,
          lineWidth: line.getBoundingClientRect().width,
          lineColor: pixel(getComputedStyle(line).backgroundColor),
          groupFill: getComputedStyle(group).backgroundColor,
        };
      });
      assert.equal(separators.rowWidth, '1px', 'Rows have a restrained physical separator');
      assert.equal(separators.rowColor[3], 255, 'Divider is not weakened by a second opacity multiplier');
      assert.notDeepEqual(
        separators.rowColor,
        separators.contentColor,
        'Divider differs from content surface',
      );
      assert.equal(separators.lineHeight, 1, 'Date rule remains hairline');
      assert(separators.lineWidth > width / 3, 'Date group has a meaningful horizontal rule');
      assert.deepEqual(
        separators.lineColor,
        separators.rowColor,
        'Rows and date rules share the divider token',
      );
      assert.notEqual(separators.groupFill, 'rgba(0, 0, 0, 0)', 'Date grouping has its own surface');
      const encoded = await rowFor('Quinn Park').innerText();
      assert.match(encoded, /It's "ready"/);
      assert.match(encoded, /You're invited & welcome\./);
      assert.match(
        encoded,
        /<script>window\.__mailSnippetRan=true<\/script>/,
        'Decoded markup must remain plain text',
      );
      assert(!encoded.includes('&#39;') && !encoded.includes('&quot;'), 'No raw HTML entities in mail text');
      assert.equal(
        await page.evaluate(() => window.__mailSnippetRan),
        undefined,
        'Decoded markup never executes',
      );
      const filter = page.getByRole('button', { name: /Choose mailboxes:/ });
      assert.equal(
        await filter.evaluate((element) =>
          element.closest('header')?.getAttribute('data-mail-filter-header'),
        ),
        'Mail filters',
      );
      await page.screenshot({ path: join(artifacts, `mail-${width}-${theme}.png`) });
      evidence.push({
        width,
        theme,
        avatarCenters: geometry.map(({ trigger, ring, content }) => ({
          trigger: [trigger.centerX, trigger.centerY],
          ring: [ring.centerX, ring.centerY],
          content: [content.centerX, content.centerY],
        })),
        separators,
      });
    }

    // Keyboard row behavior survives nested mailbox controls.
    await rowFor('Studio North').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await rowFor('Alex Morgan').evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    assert.equal(
      await rowFor('Studio North').evaluate((element) => element === document.activeElement),
      true,
    );
    const mailbox = rowFor('Studio North').getByRole('button', {
      name: 'Which mailbox: Work mailbox',
      exact: true,
    });
    await mailbox.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Mailbox this thread arrived in', { exact: true }).waitFor();
    assert.equal(await page.getByRole('status').innerText(), 'Ready', 'Opening mailbox must not open thread');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('title') === 'Which mailbox');
    assert.equal(
      await mailbox.evaluate((element) => element === document.activeElement),
      true,
      'Popover returns keyboard focus to mailbox',
    );
    await rowFor('Studio North').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('status').innerText(), 'Opened: loaded');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-fixture-selection]').innerText(), 'Selected: loaded');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-fixture-selection]').innerText(), 'Selected: none');

    // Provider change after a failed request must retry successfully.
    await page.getByRole('button', { name: 'Recover failed image' }).click();
    await rowFor('River Studio').locator('img').waitFor();
    assert.equal(
      await rowFor('River Studio')
        .locator('img')
        .evaluate((image) => image.complete && image.naturalWidth > 0),
      true,
    );

    // Real mailbox control keeps at least one account selected and supports reset.
    await page.getByRole('button', { name: /Choose mailboxes:/ }).click();
    await page.getByRole('menuitemcheckbox', { name: /Personal/ }).click();
    assert.equal(await mailRows.count(), 2);
    await page.screenshot({ path: join(artifacts, `mail-${width}-account-filter.png`) });
    await page.getByRole('menuitemcheckbox', { name: /Work/ }).click();
    assert.equal(await mailRows.count(), 2, 'Cannot accidentally deselect the final mailbox');
    await page.getByRole('menuitem', { name: 'All accounts', exact: true }).click();
    assert.equal(await mailRows.count(), 4);
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Search synthetic mail' }).fill('Coffee');
    assert.equal(await mailRows.count(), 1);
    await page.getByRole('textbox', { name: 'Search synthetic mail' }).fill('');
    assert.equal(await mailRows.count(), 4);
  }
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.deepEqual(apiRequests, [], 'Synthetic acceptance never calls account APIs');
  const report = JSON.stringify({ status: 'passed', artifacts, evidence }, null, 2);
  await writeFile(join(artifacts, 'evidence.json'), report);
  console.log(report);
} finally {
  await browser.close();
}
