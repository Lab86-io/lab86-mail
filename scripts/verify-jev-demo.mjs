import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = 'http://127.0.0.1:18848';
const artifacts = '/tmp/albatross-jev-demo-ui';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
const evidence = [];
try {
  for (const width of [390, 768, 1440]) {
    await fetch(`${origin}/__preview/reset`);
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    const nav = page.getByRole('navigation', { name: 'Mail views' });
    await nav.waitFor();
    const primary = ['Main', 'Needs reply', 'Noise'];
    for (const name of primary) {
      const button = nav.getByRole('button', { name: new RegExp(`^${name}`) });
      await button.click();
      assert.equal(await button.getAttribute('aria-current'), 'page');
    }
    // Every detailed view, custom category and folder remains usable from one menu.
    for (const [label, value] of [
      ['Needs action', 'needs_action'],
      ['Waiting for', 'waiting_for'],
      ['Changes', 'important_changes'],
      ['Codes', 'codes'],
      ['Orders', 'orders'],
      ['Finance / admin', 'finance_admin'],
      ['Review', 'review'],
      ['Budget', 'custom:budget'],
      ['Sent', 'in:sent newer_than:365d'],
    ]) {
      await nav.getByRole('button', { name: /^More mail views/ }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      assert.equal(await page.locator('[data-mail-preview-state]').innerText(), value);
      assert(
        (await nav.getByRole('button', { name: /^More mail views/ }).getAttribute('aria-label')).includes(
          label,
        ),
      );
    }
    await nav.getByRole('button', { name: /^Main/ }).click();
    assert.equal(await nav.getByRole('button', { name: /^More mail views/ }).innerText(), 'More');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // The primary strip fits even at mobile width (no hidden categories to scroll to).
    assert.equal(
      await nav.locator('.overflow-x-auto').evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await nav.screenshot({ path: `${artifacts}/mail-${width}.png` });
    const demo = page.locator('#jev-demo-heading').locator('..');
    if (width === 1440) {
      for (const [example, eligible, obligation] of [
        ['promotion', false, null],
        ['approval', true, 'reply'],
        ['resolved', false, null],
        ['cancellation', true, null],
      ]) {
        await page.getByLabel('Example', { exact: true }).selectOption(example);
        const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/jev/demo'));
        await page.getByRole('button', { name: 'Classify live', exact: true }).click();
        const response = await responsePromise;
        const result = await response.json();
        assert.equal(response.status(), 200);
        assert.equal(result.briefEligible, eligible);
        assert.deepEqual(result.obligations, obligation ? [obligation] : []);
        await page.locator('[data-jev-demo-result]').waitFor();
        evidence.push({ example, result });
        await demo.screenshot({ path: `${artifacts}/demo-${example}.png` });
      }
    }
    // Controlled failure/recovery checks are separate from the live provider checks.
    await page.route('**/api/jev/demo', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Jev is temporarily unavailable. Try again.' }),
      }),
    );
    await page.getByRole('button', { name: 'Classify live', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Classify live', exact: true }).isDisabled(), false);
    await page.getByLabel('Example', { exact: true }).selectOption('approval');
    assert.equal(await page.getByRole('alert').count(), 0);
    await demo.screenshot({ path: `${artifacts}/form-${width}.png` });
    await page.goto(`${origin}/?setup=true`);
    assert.equal(await page.getByRole('button', { name: 'Classify live', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    evidence.push({
      width,
      allViewsReachable: true,
      primaryStripFits: true,
      failureRecovery: true,
      setupState: true,
      pageErrors: errors,
    });
    await page.close();
  }
  await writeFile(
    `${artifacts}/evidence.json`,
    `${JSON.stringify({ at: new Date().toISOString(), passed: true, evidence }, null, 2)}\n`,
  );
  console.log(artifacts);
} finally {
  await browser.close();
}
