/** Native corner geometry on real surfaces; synthetic data, no provider writes. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = process.env.CORNER_ORIGIN ?? 'http://127.0.0.1:18847';
const artifacts = await mkdtemp('/tmp/albatross-corner-system-');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const shape = 'superellipse(1.475)';
const control = '14px';
const card = control;
const panel = control;
const corner = '14px';

try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [390, 1046, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(`${origin}/?view=today`);
    const frame = page.locator('[data-brief-art-frame]');
    await frame.waitFor();
    await page.evaluate(() => document.fonts.ready);
    // Decorative picture mouldings are owned by the parallel frame work.
    for (const surface of [page.locator('[data-workspace-panel]')]) {
      assert.deepEqual(
        await surface.evaluate((el) => {
          const css = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            radius: css.borderRadius,
            shape: css.cornerShape,
            // The restored profile keeps each edge midpoint usable.
            top: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 1)),
            right: el.contains(document.elementFromPoint(r.right - 1, r.top + r.height / 2)),
          };
        }),
        { radius: panel, shape, top: true, right: true },
      );
    }
    if (width >= 768) {
      const search = page.getByRole('button', { name: /^Search everything/ });
      const selected = page.locator('[data-sidebar="menu-button"][data-active="true"]');
      for (const item of [search, selected]) {
        const geometry = await item.evaluate((el) => {
          const css = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            radius: css.borderRadius,
            shape: css.cornerShape,
            mask: css.maskImage,
            clip: css.clipPath,
            // Check the midpoint of the restored continuous shoulder.
            shoulder: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 1)),
          };
        });
        assert.deepEqual(geometry, { radius: control, shape, mask: 'none', clip: 'none', shoulder: true });
      }
    }
    await page.screenshot({ path: `${artifacts}/today-${width}.png` });
    if (width >= 768) {
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      const chat = page.locator('[data-assistant-chat]');
      const editor = chat.locator('textarea');
      await editor.fill('Keep the draft while inspecting the corners.');
      const send = chat.getByRole('button', { name: 'Send', exact: true });
      const geometry = await send.evaluate((el) => {
        const css = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, radius: css.borderRadius, shape: css.cornerShape };
      });
      assert.equal(geometry.width, geometry.height, 'Send remains a square');
      assert.equal(geometry.radius, control, 'Send is a soft square, never a circle');
      assert.equal(geometry.shape, shape);
      const composer = await editor.locator('..').evaluate((el) => {
        const css = getComputedStyle(el);
        return { radius: css.borderRadius, shape: css.cornerShape };
      });
      assert.deepEqual(composer, { radius: card, shape });
      await page.screenshot({ path: `${artifacts}/chat-${width}.png` });
      await page.evaluate(() => {
        document.documentElement.classList.remove('light');
        document.documentElement.classList.add('dark');
      });
      await page.waitForTimeout(500); // Finish control color transitions before visual review.
      assert.equal(await send.evaluate((el) => getComputedStyle(el).cornerShape), shape);
      await page.screenshot({ path: `${artifacts}/chat-${width}-dark.png` });
    }
  }
  // Verify compiled generic/arbitrary utilities, exposed corners, and overrides.
  // These classes already occur in production; no test-only CSS is injected.
  await page.evaluate(() => {
    const container = document.createElement('section');
    container.id = 'corner-compilation-probe';
    container.style.cssText =
      'position:fixed;inset:16px;z-index:9999;background:white;padding:24px;display:flex;gap:24px;align-items:start';
    for (const className of [
      'rounded-md',
      'rounded-2xl',
      'rounded-3xl',
      'rounded-[var(--radius-panel)]',
      'rounded-[10px]',
      'corner-smooth rounded-l-[var(--radius-ui-corner)]',
      'rounded-full',
      'rounded-none',
    ]) {
      const item = document.createElement('div');
      item.className = className;
      item.textContent = className;
      item.style.cssText =
        'width:120px;height:72px;border:1px solid #c0ccc7;background:#eef4f1;padding:8px;font:10px sans-serif';
      container.append(item);
    }
    document.body.append(container);
  });
  const results = await page.locator('#corner-compilation-probe > div').evaluateAll((elements) =>
    elements.map((el) => {
      const css = getComputedStyle(el);
      return { shape: css.cornerShape, left: css.borderTopLeftRadius, right: css.borderTopRightRadius };
    }),
  );
  assert.deepEqual(results[0], { shape, left: corner, right: corner }, 'rounded-md is a control');
  assert.deepEqual(results[1], { shape, left: corner, right: corner }, 'rounded-2xl is a card');
  assert.deepEqual(results[2], { shape, left: corner, right: corner }, 'rounded-3xl is a panel');
  assert.deepEqual(
    results[3],
    { shape, left: corner, right: corner },
    'arbitrary token radius keeps the curve',
  );
  assert.deepEqual(
    results[4],
    { shape, left: '10px', right: '10px' },
    'arbitrary pixel radius keeps the curve',
  );
  assert.deepEqual(results[5], { shape, left: corner, right: '0px' }, 'joined control has a square seam');
  assert.equal(results[6].shape, 'round', 'avatars and explicit circles remain circles');
  assert.deepEqual([results[7].left, results[7].right], ['0px', '0px']);
  await page.screenshot({ path: `${artifacts}/compiled-utilities.png` });
  assert.deepEqual(errors, []);
  console.log(`Corner system passed. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
