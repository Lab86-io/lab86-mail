/** Real frame assets and museum images in the shared synthetic app preview. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = process.env.ART_PREVIEW_URL || 'http://127.0.0.1:18848';
const artifacts = '/tmp/albatross-art-review';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${origin}/?review=frames`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '21 picture frames' }).waitFor();
  assert.equal(await page.locator('[data-frame-gallery-item]').count(), 21);
  const assets = await page
    .locator('[data-brief-frame]')
    .evaluateAll((frames) =>
      frames.map((frame) => frame.style.getPropertyValue('--brief-frame-src').match(/url\("?(.*?)"?\)/)[1]),
    );
  for (const asset of assets) {
    const response = await page.request.get(`${origin}${asset}`);
    assert.equal(response.status(), 200, asset);
  }
  // Use one real painting to compare mouldings at the same scale, then change
  // the work to verify that its palette, rather than the theme, controls ink.
  const urls = await page
    .getByLabel('Artwork', { exact: true })
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => option.value).filter((url) => url.includes('images.metmuseum.org')),
    );
  await page.getByLabel('Artwork', { exact: true }).selectOption(urls[0]);
  const waitForArt = () =>
    page.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('.brief-masthead__painting img')];
        return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
      },
      null,
      { timeout: 30000 },
    );
  await waitForArt();
  for (const [family, count] of [
    ['gothic', 6],
    ['modern', 5],
    ['art-deco', 5],
  ]) {
    await page.getByLabel('Frame collection').selectOption(family);
    assert.equal(await page.locator('[data-frame-gallery-item]').count(), count);
    await waitForArt();
    await page.screenshot({ path: `${artifacts}/${family}.png` });
  }
  const firstInk = await page
    .locator('[data-brief-frame]')
    .first()
    .evaluate((node) => node.style.getPropertyValue('--brief-art-ink'));
  let differentInk = false;
  for (const url of urls.slice(1, 6)) {
    await page.getByLabel('Artwork', { exact: true }).selectOption(url);
    const ink = await page
      .locator('[data-brief-frame]')
      .first()
      .evaluate((node) => node.style.getPropertyValue('--brief-art-ink'));
    if (ink !== firstInk) {
      differentInk = true;
      break;
    }
  }
  assert.ok(differentInk, 'a different painting changes the title ink');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('.brief-masthead').evaluateAll((frames) =>
      frames.map((frame) => {
        const painting = frame.querySelector('.brief-masthead__painting').getBoundingClientRect();
        const title = frame.querySelector('h1').getBoundingClientRect();
        const weather = frame.querySelector('[data-brief-header-weather]').getBoundingClientRect();
        const moulding = frame.querySelector('.brief-masthead__moulding').getBoundingClientRect();
        return {
          titleInside: title.left >= painting.left && title.right <= painting.right,
          weatherBelow: weather.top >= title.bottom - 1,
          frameInside: moulding.left >= 0 && moulding.right <= innerWidth,
        };
      }),
    );
    for (const item of geometry)
      assert.deepEqual(item, { titleInside: true, weatherBelow: true, frameInside: true });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `overflow at ${width}`,
    );
    if (width === 390) {
      await waitForArt();
      await page.screenshot({ path: `${artifacts}/phone.png` });
    }
  }
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `${artifacts}/dark.png` });
  await page.emulateMedia({ contrast: 'more' });
  assert.equal(
    await page
      .locator('.brief-masthead__ink')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundImage),
    'none',
  );
  await page.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' });
  assert.equal(
    await page
      .locator('.brief-masthead__ink')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundImage),
    'none',
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: 21 assets, collection/artwork controls, 4 viewport widths, dark and contrast modes. ${artifacts}`,
  );
} finally {
  await browser.close();
}
