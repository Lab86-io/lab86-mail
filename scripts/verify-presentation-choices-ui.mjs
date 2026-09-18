/** Browser acceptance against the actual tool cards, using synthetic source data. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { renderDeckHtml } from '../lib/documents/deck-render.ts';
import { composePresentationV2 } from '../lib/documents/presentation-design.ts';
import { retroBrief } from '../tests/fixtures/presentation-briefs.ts';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const output = '/tmp/presentation-choice-qa';
await mkdir(output, { recursive: true });
try {
  const fontCheck = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await fontCheck.setContent(
    await renderDeckHtml(composePresentationV2({ ...retroBrief(), fontPair: 'mono' })),
  );
  await fontCheck.evaluate(() => document.fonts.ready);
  const comparisonTitle = fontCheck
    .locator('.deck-text')
    .filter({ hasText: /^What we planned against what we got$/ });
  assert.equal(
    await comparisonTitle.evaluate((node) => {
      const box = node.parentElement.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      return text.bottom <= box.bottom + 2 && text.right <= box.right + 2;
    }),
    true,
    'The actual monospace title must fit without clipping',
  );
  await fontCheck.close();
  console.log('Monospace comparison title: actual font bounds fit');
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
    await page.locator('.presentation-option-gallery [role="option"]').first().waitFor();
    assert.equal(await page.locator('.presentation-option-gallery [role="option"]').count(), 8);
    const previewCards = page.locator('.presentation-option-gallery [role="option"]');
    const firstCard = await previewCards.nth(0).boundingBox();
    const secondCard = await previewCards.nth(1).boundingBox();
    assert.equal(firstCard.y, secondCard.y, 'Preview cards occupy both gallery columns');
    assert.ok(secondCard.x > firstCard.x);
    await page.getByRole('option', { name: /lagoon/i }).click();
    await page.screenshot({ path: `${output}/${name}-themes.png`, fullPage: true });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await page.locator('.presentation-option-gallery [role="option"]').count(), 6);
    await page.getByRole('option', { name: /Space Grotesk/ }).focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('16px "Space Grotesk"')), true);
    assert.equal(await page.evaluate(() => document.fonts.check('16px "Manrope"')), true);
    await page.screenshot({ path: `${output}/${name}-fonts.png`, fullPage: true });
    await page.getByLabel('Any other design direction?').fill('Calm, with a clear hierarchy.');
    await page.getByRole('button', { name: 'Plan my slides', exact: true }).click();
    await page.reload();
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('option', { name: 'Line chart', exact: true }).click();
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
    // Reproduce a saved malformed storyboard, then repair without resubmitting
    // the brief or design. New malformed calls are tested through the real SDK.
    await page.evaluate(() => {
      const history = JSON.parse(localStorage.getItem('presentation-preview'));
      localStorage.setItem('presentation-preview', JSON.stringify(history.slice(0, 2)));
    });
    await page.goto(`${process.env.PRESENTATION_PREVIEW_URL || 'http://127.0.0.1:18852'}?recovery=1`);
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('button', { name: 'Repair these choices', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${name}-recovery.png`, fullPage: true });
    await page.getByRole('button', { name: 'Repair these choices', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).waitFor();
    await page.reload();
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    assert.equal(await page.getByRole('button', { name: 'Repair these choices', exact: true }).count(), 0);
    const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem('presentation-preview')));
    assert.equal(recovered.length, 3);
    assert.equal(recovered[1].output.design.theme, 'lagoon');
    assert.equal(recovered[1].output.design.fontPair, 'grotesk');
    assert.equal(recovered[2].output.status, 'invalid_presentation_choices');
    assert.equal(recovered[2].output.decision, undefined);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('option', { name: 'Line chart', exact: true }).click();
    await page.getByText('View chart data (users)', { exact: true }).click();
    assert.match(await page.locator('.presentation-choice-data').innerText(), /240/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: `${output}/${name}-recovered.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      `${name}: choices, confirmation, reload, malformed-preview repair and preserved preferences/data passed`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
