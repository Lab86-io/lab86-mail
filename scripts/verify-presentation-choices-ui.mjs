/** Browser acceptance against the actual tool cards, using synthetic source data. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const output = '/tmp/presentation-choice-qa';
await mkdir(output, { recursive: true });
try {
  for (const [name, width, dark] of [
    ['desktop', 1200, false],
    ['mobile-dark', 390, true],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.PRESENTATION_PREVIEW_URL || 'http://127.0.0.1:18852');
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.match(await page.getByRole('alert').innerText(), /audience/);
    await page.getByRole('button', { name: 'Leadership team', exact: true }).click();
    await page.getByLabel('What should they understand or do?').fill('Choose the next quarter’s priorities');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page
      .getByLabel('Anything to include or leave out?')
      .fill('Use only the attached, synthetic report.');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Content slides', { exact: true }).fill('2');
    await page.getByLabel('In-between section breaks', { exact: true }).fill('1');
    await page.screenshot({ path: `${output}/${name}-pacing.png`, fullPage: true });
    await page.getByRole('button', { name: 'Gather the content', exact: true }).click();
    await page.reload();
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    assert.equal(await page.locator('.presentation-choice-option').count(), 8);
    await page.getByRole('button', { name: /lagoon/i }).click();
    await page.screenshot({ path: `${output}/${name}-themes.png`, fullPage: true });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await page.locator('.presentation-choice-option').count(), 6);
    await page.getByRole('button', { name: /Space Grotesk/ }).focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('16px "Space Grotesk"')), true);
    assert.equal(await page.evaluate(() => document.fonts.check('16px "Manrope"')), true);
    await page.screenshot({ path: `${output}/${name}-fonts.png`, fullPage: true });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Any other design direction?').fill('Calm, with a clear hierarchy.');
    await page.getByRole('button', { name: 'Plan my slides', exact: true }).click();
    await page.reload();
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Line chart', exact: true }).click();
    await page.getByText('View chart data (users)', { exact: true }).click();
    assert.match(await page.locator('.presentation-choice-data').innerText(), /240/);
    await page.screenshot({ path: `${output}/${name}-charts.png`, fullPage: true });
    while (await page.getByRole('button', { name: 'Next', exact: true }).count())
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.match(await page.locator('.presentation-choice-outline').innerText(), /Line chart/);
    assert.equal(await page.locator('.presentation-choice-outline li').count(), 5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Build this presentation', exact: true }).click();
    await page.reload();
    assert.equal(await page.getByRole('button', { name: 'Build this presentation', exact: true }).count(), 0);
    const answers = await page.evaluate(() => JSON.parse(localStorage.getItem('presentation-preview')));
    assert.equal(answers.length, 3);
    assert.equal(answers[1].output.design.theme, 'lagoon');
    assert.equal(answers[1].output.design.fontPair, 'grotesk');
    assert.equal(answers[2].output.visuals.find((entry) => entry.slideId === 'slide-0').visual, 'line');
    assert.deepEqual(errors, []);
    console.log(
      `${name}: pacing, eight themes, six fonts, keyboard selection, real chart values, confirmation and reload passed`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
