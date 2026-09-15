import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = process.env.ALBATROSS_STYLE_PREVIEW_URL || 'http://127.0.0.1:18859';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/?review=chat`);
  await page.waitForFunction(() => document.querySelectorAll('[data-preview-state="ready"]').length === 3);
  const files = page.locator('[data-file-result]');
  assert.equal(await files.count(), 3);
  const sizes = await files.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    }),
  );
  assert.ok(sizes.every((size) => size.height === 112));
  assert.ok(sizes.every((size) => Math.abs(size.width - sizes[0].width) < 2));
  const requests = await page.evaluate(() =>
    window.workspacePreview.calls.filter((call) => call.includes('/api/documents/style-')),
  );
  assert.equal(requests.length, 3);
  const firstPage = files.first().locator('[data-page="0"]');
  const resting = await firstPage.evaluate((element) => getComputedStyle(element).transform);
  await files.first().hover();
  await page.waitForTimeout(300);
  assert.notEqual(await firstPage.evaluate((element) => getComputedStyle(element).transform), resting);
  await page.keyboard.press('Tab');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await files.first().hover();
  assert.equal(await firstPage.evaluate((element) => getComputedStyle(element).transform), 'none');
  await page.mouse.move(0, 0);
  assert.equal(await firstPage.evaluate((element) => getComputedStyle(element).transform), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.className = theme;
      document.documentElement.style.setProperty('--radius-ui', '18px');
      document.documentElement.style.setProperty('--corner-shape-ui', 'squircle');
      document.querySelector('[data-message-role="user"]').scrollIntoView({ block: 'start' });
    }, theme);
    await page.waitForTimeout(300);
    const surfaces = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        rail: style('.rail-wash').backgroundColor,
        frame: style('.app-paper').backgroundColor,
        railLine: style('.rail-wash').borderRightWidth,
        curve: getComputedStyle(document.querySelector('.rail-wash'), '::after').content,
        user: style('.assistant-user-bubble').backgroundColor,
        page: style('.workspace-panel').backgroundColor,
        shape: style('.assistant-user-bubble').cornerShape,
        radius: style('[data-slot="work-log"]').borderRadius,
      };
    });
    assert.equal(surfaces.rail, surfaces.frame);
    assert.equal(surfaces.railLine, '0px');
    assert.equal(surfaces.curve, 'none');
    assert.notEqual(surfaces.user, surfaces.page);
    assert.ok(['squircle', 'superellipse(2)'].includes(surfaces.shape));
    assert.equal(surfaces.radius, '18px');
    await page.screenshot({ path: `/tmp/albatross-style-chat-results-${theme}.png` });
  }

  await page.evaluate(() => {
    window.__previewQueryClient.setQueryData(['document', 'style-doc'], (current) => ({
      ...current,
      document: {
        ...current.document,
        model: { kind: 'doc', blocks: [{ id: 'fresh', type: 'heading', text: 'Updated live content' }] },
      },
    }));
  });
  await page.getByText('Updated live content', { exact: true }).waitFor();
  await page.goto(`${origin}/?review=chat&previewError=style-doc`);
  await page.waitForFunction(() => document.querySelectorAll('[data-preview-state="ready"]').length === 2);
  assert.equal(await page.locator('[data-preview-state="unavailable"]').count(), 1);
  await page.goto(`${origin}/?review=chat`);
  await page.waitForFunction(() => document.querySelectorAll('[data-file-result]').length === 3);
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const overflow = await files.evaluateAll((elements) =>
      elements.map((element) => element.scrollWidth - element.clientWidth),
    );
    assert.ok(
      overflow.every((amount) => amount <= 1),
      `File overflow at ${width}: ${overflow}`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('a[href="/?view=files&document=style-deck"]').click();
  assert.ok(page.url().includes('document=style-deck'));
  assert.equal(await page.evaluate(() => window.workspacePreview.state().aiBarOpen), true);
  assert.equal(await page.evaluate(() => window.workspacePreview.state().assistantPresentation), 'split');
  assert.deepEqual(errors, []);
  console.log(
    'Passed: real previews, uniform cards, query reuse, live updates, hover, reduced motion, light/dark, custom corners, narrow layouts, and open-file navigation.',
  );
} finally {
  await browser.close();
}
