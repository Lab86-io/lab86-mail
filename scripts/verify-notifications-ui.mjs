/** Run preview-notifications.mjs first. Uses synthetic data and actual UI only. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp(join(tmpdir(), 'albatross-notifications-ui-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const row = (name) =>
    page.locator('[data-notifications-list]').getByRole('button', { name: new RegExp(name) });
  const detail = page.getByRole('region', { name: 'Notification details' });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:18843/');
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[data-notifications-list]').evaluate((element) => {
      element.scrollTop = 0;
    });
    assert.equal(await page.locator('[data-preview-badge]').textContent(), 'Notifications · 5');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: join(artifacts, `notifications-list-${width}-${theme}.png`) });
    }
    // Arrow navigation moves focus only; Enter opens and marks read, not acted.
    await row('Which direction').focus();
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Review the launch email/);
    assert.equal((await page.evaluate(() => window.notificationPreview.reads)).length, 0);
    await page.keyboard.press('Enter');
    await detail.getByRole('heading', { name: 'Review the launch email' }).waitFor();
    assert.equal(
      await page.locator('[data-preview-badge]').textContent(),
      'Notifications · 5',
      'Read approval stays outstanding',
    );
    assert.deepEqual(await page.evaluate(() => window.notificationPreview.reads), ['approval-notice']);
    assert.equal(await detail.getByRole('button', { name: 'Dismiss update' }).count(), 0);
    await detail.getByRole('button', { name: 'Review approval' }).click();
    assert.deepEqual(await page.evaluate(() => window.notificationPreview.actions), [
      { kind: 'work', workId: 'w1' },
    ]);
    await page.screenshot({ path: join(artifacts, `notifications-detail-${width}.png`) });
    if (width < 1024) {
      assert.equal(await page.locator('[data-notifications-list]').isVisible(), false);
      await detail.getByRole('button', { name: 'Back to notifications' }).click();
    } else {
      // Opening from a keyboard-focused row leaves focus in the list on desktop.
      await row('Review the launch email').focus();
      await page.keyboard.press('Escape');
      assert.equal(await detail.getByRole('heading', { name: 'Review the launch email' }).count(), 0);
    }
    assert.equal(
      await row('Review the launch email').evaluate((element) => document.activeElement === element),
      true,
    );

    // A failed read is visible and retryable; it cannot silently clear the badge.
    await page.evaluate(() => {
      window.notificationPreview.failNextRead = true;
    });
    await row('Your brief is ready').click();
    await detail.getByRole('alert').waitFor();
    assert.equal(await page.locator('[data-preview-badge]').textContent(), 'Notifications · 5');
    await detail.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => window.notificationPreview.reads.includes('n0'));
    assert.equal(await page.locator('[data-preview-badge]').textContent(), 'Notifications · 4');
    await page.evaluate(() => {
      window.notificationPreview.failNextDismiss = true;
    });
    await detail.getByRole('button', { name: 'Dismiss update' }).click();
    await detail.getByRole('alert').waitFor();
    assert.equal((await page.evaluate(() => window.notificationPreview.dismissed)).length, 0);
    await detail.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => window.notificationPreview.dismissed.includes('n0'));
    assert.equal(await row('Your brief is ready').count(), 0);

    // Selecting another item during a delayed dismissal keeps the new detail.
    await page.evaluate(() => {
      window.notificationPreview.holdNextDismiss = true;
    });
    await page
      .locator('[data-notifications-list] button')
      .filter({ has: page.getByText('Project update 1', { exact: true }) })
      .click();
    await detail.getByRole('button', { name: 'Dismiss update' }).click();
    if (width < 1024) await detail.getByRole('button', { name: 'Back to notifications' }).click();
    await row('Review the launch email').click();
    await page.evaluate(() => window.notificationPreview.releaseDismiss());
    await page.waitForFunction(() => window.notificationPreview.dismissed.includes('n1'));
    await detail.getByRole('heading', { name: 'Review the launch email' }).waitFor();
    if (width < 1024) await detail.getByRole('button', { name: 'Back to notifications' }).click();

    // Per-account view state survives leaving the destination and returning.
    await page.getByRole('combobox', { name: 'Filter notifications' }).selectOption('approval');
    await row('Review the launch email').click();
    await page.getByRole('button', { name: 'Leave notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Return to notifications', exact: true }).click();
    await detail.getByRole('heading', { name: 'Review the launch email' }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Filter notifications' }).inputValue(), 'approval');
    if (width < 1024) await detail.getByRole('button', { name: 'Back to notifications' }).click();
    await page.getByRole('combobox', { name: 'Filter notifications' }).selectOption('all');
    await page.locator('[data-notifications-list]').evaluate((element) => {
      element.scrollTop = 700;
    });
    await page.waitForTimeout(50);
    const previousScroll = await page
      .locator('[data-notifications-list]')
      .evaluate((element) => element.scrollTop);
    await page.getByRole('button', { name: 'Leave notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Return to notifications', exact: true }).click();
    await page.waitForTimeout(80);
    assert.equal(
      await page.locator('[data-notifications-list]').evaluate((element) => element.scrollTop),
      previousScroll,
    );
    await page.evaluate(() =>
      sessionStorage.setItem(
        'notifications-synthetic-view',
        JSON.stringify({ filter: 'all', selectedId: null, scrollTop: 700 }),
      ),
    );
    await page.goto('http://127.0.0.1:18843/?loading=1');
    await page.getByRole('status').waitFor();
    await page.getByRole('status').waitFor({ state: 'hidden' });
    await page.waitForTimeout(80);
    assert.equal(
      await page.locator('[data-notifications-list]').evaluate((element) => element.scrollTop),
      700,
      'Restore against loaded rows, not the shorter skeleton',
    );
    // A resolved or dismissed selection must not strand the saved scroll.
    await page.evaluate(() =>
      sessionStorage.setItem(
        'notifications-synthetic-view',
        JSON.stringify({ filter: 'all', selectedId: 'approval:no-longer-pending', scrollTop: 700 }),
      ),
    );
    await page.goto('http://127.0.0.1:18843/?loading=1');
    await page.getByRole('status').waitFor();
    await page.getByRole('status').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('[data-notifications-list]').scrollTop === 700);
    if (width < 1024) {
      await page.evaluate(() =>
        sessionStorage.setItem(
          'notifications-synthetic-view',
          JSON.stringify({ filter: 'all', selectedId: 'approval:a1', scrollTop: 700 }),
        ),
      );
      await page.goto('http://127.0.0.1:18843/?loading=1');
      await detail.getByRole('heading', { name: 'Review the launch email' }).waitFor();
      assert.equal(await page.locator('[data-notifications-list]').isVisible(), false);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => document.querySelector('[data-notifications-list]').scrollTop === 700);
      await page.setViewportSize({ width, height: 900 });
      await detail.getByRole('button', { name: 'Back to notifications' }).click();
      assert.equal(
        await page.locator('[data-notifications-list]').evaluate((element) => element.scrollTop),
        700,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        widths: [390, 768, 1440],
        checks: [
          'read-not-resolved',
          'deduped-counts',
          'arrow-enter-escape',
          'phone-back',
          'retry-read-dismiss',
          'slow-dismiss-preserves-new-selection',
          'retained-filter-selection-scroll',
          'async-rows-stale-selection-and-responsive-scroll-restoration',
          'light-dark-no-overflow',
        ],
        artifacts,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
