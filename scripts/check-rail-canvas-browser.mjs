import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromium } from 'playwright-core';

const origin = process.env.ALBATROSS_STYLE_PREVIEW_URL || 'http://127.0.0.1:18859';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin);
  await page.locator('.rail-wash').waitFor();
  for (const theme of ['light', 'dark']) {
    for (const expanded of [true, false]) {
      await page.evaluate(
        ({ theme, expanded }) => {
          document.documentElement.className = theme;
          document.documentElement.style.setProperty('--bg-wash-opacity', '1');
          document.documentElement.style.setProperty('--grain-opacity', '0');
          window.workspacePreview.state().setRailOpen(expanded);
        },
        { theme, expanded },
      );
      await page.waitForTimeout(350);
      const layers = await page.evaluate(() => {
        const root = document.querySelector('[data-slot="sidebar-wrapper"]');
        const rail = document.querySelector('.rail-wash');
        const main = root.querySelector('main');
        return {
          shared: root.matches('.app-paper') && root.contains(rail) && root.contains(main),
          canvases: root.querySelectorAll('.app-paper').length,
          rail: getComputedStyle(rail).backgroundColor,
          inner: getComputedStyle(rail.querySelector('[data-slot="sidebar-inner"]')).backgroundColor,
          main: getComputedStyle(main).backgroundColor,
          mainWash: getComputedStyle(main, '::before').content,
          wash: getComputedStyle(root, '::before').backgroundImage,
          washWidth: getComputedStyle(root, '::before').width,
          rootWidth: root.getBoundingClientRect().width,
          railRight: rail.getBoundingClientRect().right,
        };
      });
      assert.equal(layers.shared, true);
      assert.equal(layers.canvases, 0);
      for (const key of ['rail', 'inner', 'main']) assert.equal(layers[key], 'rgba(0, 0, 0, 0)');
      assert.equal(layers.mainWash, 'none');
      assert.ok(layers.wash.includes('radial-gradient'));
      assert.equal(parseFloat(layers.washWidth), layers.rootWidth);
      const screenshot = await loadImage(await page.screenshot());
      const canvas = createCanvas(screenshot.width, screenshot.height);
      const context = canvas.getContext('2d');
      context.drawImage(screenshot, 0, 0);
      const boundary = Math.round(layers.railRight);
      for (let height = 600; height < 700; height += 10) {
        const left = context.getImageData(boundary - 2, height, 1, 1).data;
        const right = context.getImageData(boundary + 1, height, 1, 1).data;
        for (let channel = 0; channel < 3; channel += 1) {
          assert.ok(
            Math.abs(left[channel] - right[channel]) <= 2,
            `${theme}: visible color seam at ${height}`,
          );
        }
      }
      await page.evaluate(() => document.documentElement.style.setProperty('--grain-opacity', '0.2'));
      assert.equal(
        await page
          .locator('.app-paper')
          .evaluate(
            (root) => getComputedStyle(root, '::after').width === `${root.getBoundingClientRect().width}px`,
          ),
        true,
      );
    }
  }
  console.log(
    'Passed: shared rail/page wash and grain, no painted seam, light/dark, and expanded/collapsed rail.',
  );
} finally {
  await browser.close();
}
