/** Real shell/composer/theme provider, synthetic transport only. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp('/tmp/albatross-shell-edges-');
const url = process.env.ALBATROSS_PREVIEW_URL || 'http://127.0.0.1:18847/';
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 860 }, colorScheme: 'light' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Explicit dark app preference on a light OS must still tint dark.
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto(url);
    await page.locator('[data-mail-thread-row]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const colorMatches = () =>
      page.waitForFunction(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = getComputedStyle(document.querySelector('.app-paper')).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const expected = `#${[...ctx.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')}`;
        return document.querySelector('meta[name="theme-color"]')?.content === expected;
      });
    await colorMatches();
    assert.equal(await page.locator('html').evaluate((root) => root.classList.contains('dark')), true);
    const initialColor = await page.locator('[data-app-theme-color]').getAttribute('content');
    assert.equal(initialColor, '#19211c');

    if (width > 767) {
      for (const open of [true, false]) {
        await page.evaluate((value) => window.workspacePreview.state().setRailOpen(value), open);
        await page.waitForTimeout(350);
        const geometry = await page.evaluate(() => {
          const rail = document.querySelector('[data-slot="sidebar-container"]').getBoundingClientRect();
          const panel = document.querySelector('[data-workspace-panel]').getBoundingClientRect();
          const icon = document.querySelector('[data-sidebar="menu-button"]').getBoundingClientRect();
          const handle = document
            .querySelector('[aria-label="Resize navigation rail"]')
            ?.getBoundingClientRect();
          return {
            railRight: rail.right,
            panelLeft: panel.left,
            top: panel.top,
            right: innerWidth - panel.right,
            bottom: innerHeight - panel.bottom,
            iconLeft: icon.left,
            iconRightGap: panel.left - icon.right,
            handleCenter: handle ? handle.left + handle.width / 2 : null,
          };
        });
        assert.equal(geometry.panelLeft, geometry.railRight, 'no extra gutter after the rail');
        assert.equal(geometry.top, geometry.right);
        assert.equal(geometry.bottom, geometry.right);
        if (open)
          assert.equal(geometry.handleCenter, geometry.panelLeft, 'handle sits on the workspace edge');
        else assert.equal(geometry.iconLeft, geometry.iconRightGap, 'collapsed icons have symmetric insets');
        await page.screenshot({ path: `${artifacts}/${width}-${open ? 'expanded' : 'collapsed'}.png` });
      }
      // Dragging still changes both the rail and panel edge together.
      await page.evaluate(() => window.workspacePreview.state().setRailOpen(true));
      await page.waitForTimeout(350);
      const handle = await page.getByRole('button', { name: 'Resize navigation rail' }).boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, 400);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 40, 400, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(350);
      const edges = await page.evaluate(() => [
        document.querySelector('[data-slot="sidebar-container"]').getBoundingClientRect().right,
        document.querySelector('[data-workspace-panel]').getBoundingClientRect().left,
      ]);
      assert.equal(edges[0], edges[1]);
      assert.equal(edges[0], 280);
    } else {
      const margins = await page.locator('[data-workspace-panel]').evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return [rect.left, innerWidth - rect.right, rect.top, innerHeight - rect.bottom];
      });
      assert.deepEqual(margins, [6, 6, 6, 6]);
    }

    await page.getByRole('button', { name: 'Ask Albatross or get this off my mind' }).click();
    const chat = page.locator('[data-assistant-chat]');
    const textarea = chat.locator('textarea');
    await textarea.fill('Keep this draft through layout changes');
    const assertComposer = async () => {
      const geometry = await textarea.evaluate((field) => {
        const prompt = field.closest('[data-slot="prompt-input"]');
        const borders = [];
        for (let node = field.parentElement; node; node = node.parentElement) {
          if (parseFloat(getComputedStyle(node).borderTopWidth) > 0) borders.push(node);
          if (node === prompt) break;
        }
        return {
          count: borders.length,
          owner: borders[0] === prompt,
          corner: getComputedStyle(prompt).getPropertyValue('corner-shape'),
          expectedCorner: getComputedStyle(document.documentElement)
            .getPropertyValue('--corner-shape-ui')
            .trim(),
        };
      });
      assert.equal(geometry.count, 1, 'one composer frame');
      assert.equal(geometry.owner, true);
      if (geometry.corner) assert.equal(geometry.corner, geometry.expectedCorner);
      assert.equal(await textarea.inputValue(), 'Keep this draft through layout changes');
    };
    await assertComposer();
    await page.screenshot({ path: `${artifacts}/${width}-chat-dark.png` });
    if (width > 767) {
      await chat.getByRole('button', { name: 'Expand chat beside this page' }).click();
      await assertComposer();
      await chat.getByRole('button', { name: 'Focus on chat' }).click();
      await assertComposer();
    }
    await page.evaluate(() => {
      const state = window.workspacePreview.state();
      state.setAccent(285, 0.16);
      state.setBgHue(285);
      state.setSurfaceTint(0.8);
    });
    await page.waitForFunction(
      (before) => document.querySelector('[data-app-theme-color]')?.content !== before,
      initialColor,
    );
    await colorMatches();
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await colorMatches();
    await assertComposer();
    await page.screenshot({ path: `${artifacts}/${width}-chat-light-palette.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.close();
  }
  const page = await browser.newPage({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('theme', 'system'));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('[data-app-theme-color]')?.content === '#d2e0d6');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.querySelector('[data-app-theme-color]')?.content === '#19211c');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.querySelector('[data-app-theme-color]')?.content === '#d2e0d6');
  await page.close();
  console.log(
    JSON.stringify({
      ok: true,
      artifacts,
      checked: [
        'rail expanded/collapsed/drag',
        'mobile gutters',
        'single composer frame and corners',
        'draft retention',
        'explicit theme vs OS',
        'live palette',
        'system light/dark changes',
        'overflow',
      ],
    }),
  );
} finally {
  await browser.close();
}
