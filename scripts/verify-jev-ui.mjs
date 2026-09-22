import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = 'http://127.0.0.1:18848';
const artifacts = await mkdtemp('/tmp/albatross-jev-ui-');
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
    await page.getByRole('heading', { name: 'Jev', exact: true }).waitFor();
    assert.equal(await page.getByRole('switch').count(), 6);
    assert.equal(await page.getByRole('combobox', { name: /model/i }).count(), 0);
    assert.equal(
      await page
        .getByRole('switch', { name: 'Promotions in the Brief', exact: true })
        .getAttribute('aria-checked'),
      'false',
    );
    const promo = page.getByRole('switch', { name: 'Promotions in the Brief', exact: true });
    await promo.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => document.querySelector('#jev-briefPromotions')?.getAttribute('aria-checked') === 'true',
    );
    await page.getByRole('combobox', { name: 'Surface waiting conversations after' }).selectOption('7');
    await page.waitForFunction(() => document.querySelector('#jev-follow-up')?.value === '7');
    await page.getByRole('textbox', { name: 'Correction value' }).fill('athletics@university.test');
    await page.getByRole('button', { name: 'Add correction' }).click();
    await page.getByRole('button', { name: 'Remove correction for athletics@university.test' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Correction value' }).inputValue(), '');
    let state = await (await fetch(`${origin}/__preview/state`)).json();
    assert.equal(state.state.preferences.followUpDays, 7);
    assert.equal(state.state.preferences.briefPromotions, true);
    assert.equal(state.state.corrections[0].scope, 'sender');
    await page.getByRole('textbox', { name: 'Correction value' }).fill('athletics@university.test');
    await page.getByRole('button', { name: 'Add correction' }).click();
    await page.waitForFunction(() => document.querySelector('#jev-correction-value')?.value === '');
    state = await (await fetch(`${origin}/__preview/state`)).json();
    assert.equal(state.state.corrections.length, 1);
    await page.reload();
    await page.getByRole('button', { name: 'Remove correction for athletics@university.test' }).waitFor();
    assert.equal(
      await page
        .getByRole('switch', { name: 'Promotions in the Brief', exact: true })
        .getAttribute('aria-checked'),
      'true',
    );
    await page.getByRole('button', { name: 'Recheck existing mail' }).click();
    await page.getByText('Existing mail is queued for a background recheck.').waitFor();
    await page.locator('summary').filter({ hasText: 'An unresolved request needs your reply.' }).click();
    await page.getByText('Please confirm the budget by Friday.', { exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: '1 more conversation' }).click();
    await page.getByRole('button', { name: /Older request still needs a reply/ }).click();
    assert.equal(await page.locator('#opened-thread').innerText(), 'account-a:older-request');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
        theme,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${width}/${theme}: no horizontal overflow`,
      );
      await page.screenshot({ path: `${artifacts}/jev-${width}-${theme}.png`, fullPage: true });
    }
    await page.getByRole('switch', { name: 'Show why mail needs attention' }).click();
    await page.waitForFunction(
      () => document.querySelector('#jev-showExplanations')?.getAttribute('aria-checked') === 'false',
    );
    assert.equal(
      await page.locator('summary').filter({ hasText: 'An unresolved request needs your reply.' }).count(),
      0,
    );
    await page.getByRole('button', { name: 'Remove correction for athletics@university.test' }).click();
    await page.getByText('No corrections yet.').waitFor();
    state = await (await fetch(`${origin}/__preview/state`)).json();
    assert(state.calls.some((c) => c.action === 'reprocess'));
    assert.equal(state.state.corrections.length, 0);
    await page.goto(`${origin}/?setup=true`);
    await page.getByText('Setup needed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Recheck existing mail' }).isDisabled(), true);
    assert.deepEqual(errors, []);
    evidence.push({
      width,
      keyboardToggle: true,
      preferencesSurviveReload: true,
      corrections: true,
      recheck: true,
      evidence: true,
      backlogNavigation: true,
      modelPicker: false,
      horizontalOverflow: false,
    });
    await page.close();
  }
  await writeFile(`${artifacts}/evidence.json`, JSON.stringify({ passed: true, evidence }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts, evidence }, null, 2));
} finally {
  await browser.close();
}
