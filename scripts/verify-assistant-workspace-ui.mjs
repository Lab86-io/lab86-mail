/** Run preview-assistant-workspace.mjs first. Synthetic data, actual frame,
 * launcher and stylesheet. Writes screenshots to a temp directory. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:18845/';
const artifacts = await mkdtemp(join(tmpdir(), 'albatross-assistant-workspace-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
const box = async (locator) => {
  const rect = await locator.boundingBox();
  assert.ok(rect, 'element has a box');
  return rect;
};
const noOverflow = async (page) =>
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
// The frame clips, so document.scrollWidth cannot see a pane that runs past
// it. Read the child boxes and compare them to the frame's own box.
const panesInside = async (page, label) => {
  const boxes = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    return {
      frame: rect('[data-assistant-workspace]'),
      page: rect('[data-assistant-page]'),
      seam: rect('[data-assistant-seam]'),
      chat: rect('[data-assistant-chat]'),
    };
  });
  for (const name of ['page', 'seam', 'chat']) {
    const box = boxes[name];
    if (!box) continue;
    assert.ok(
      box.left >= boxes.frame.left - 0.5 && box.right <= boxes.frame.right + 0.5,
      `${label}: ${name} ${box.left}..${box.right} inside frame ${boxes.frame.left}..${boxes.frame.right}`,
    );
  }
  if (boxes.seam) {
    assert.ok(
      boxes.page.right <= boxes.seam.left + 0.5 && boxes.seam.right <= boxes.chat.left + 0.5,
      `${label}: page, seam, chat in order`,
    );
    assert.ok(boxes.page.width >= 279.5, `${label}: page ${boxes.page.width}px keeps its 280px floor`);
    assert.ok(boxes.chat.width >= 359.5, `${label}: chat ${boxes.chat.width}px keeps its 360px floor`);
  }
  return boxes;
};
const layout = (page) => page.locator('[data-assistant-workspace]').getAttribute('data-layout');
const alpha = (color) => {
  const match = color.match(/\/\s*([\d.]+)\)$/) || color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
  return match ? Number(match[1]) : 1;
};
const activeLabel = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName);
const step = (label) => console.log(`· ${label}`);

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const launcher = page.getByRole('button', { name: 'Ask Albatross or get this off my mind' });
  const chat = page.locator('[data-assistant-chat]');
  const pane = page.locator('[data-assistant-page]');

  /* ---- desktop: corner, split, full, focus, escape, resize ---- */
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}?rotate=400`);
    await page.getByRole('heading', { name: 'Mail' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await noOverflow(page);
    step(`${width}: launcher`);

    // The launcher rotates copy without changing width, and pauses on hover.
    const before = await box(launcher);
    assert.ok(before.height >= 44, `launcher ${before.height}px tall meets the 44px target`);
    const firstPhrase = await launcher.getAttribute('data-phrase');
    await page.waitForFunction(
      (phrase) => document.querySelector('[data-assistant-launcher]')?.dataset.phrase !== phrase,
      firstPhrase,
    );
    const after = await box(launcher);
    assert.ok(Math.abs(after.width - before.width) < 0.5, `launcher width ${before.width} -> ${after.width}`);
    assert.equal(await launcher.getAttribute('aria-label'), 'Ask Albatross or get this off my mind');
    await launcher.hover();
    assert.equal(await launcher.getAttribute('data-rotating'), 'false');
    await page.mouse.move(10, 10);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.screenshot({ path: join(artifacts, `launcher-${width}-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    // Page state set before opening must survive every presentation.
    await page.getByLabel('Draft reply').fill('half-written reply');
    // A filter every row matches keeps the list tall enough to scroll.
    await page.getByLabel('Filter threads').fill('thread');
    await page.locator('[data-page-list]').evaluate((element) => {
      element.scrollTop = 120;
    });

    // Closed: mounted, inert, hidden from the accessibility tree.
    step(`${width}: closed state`);
    assert.equal(await chat.count(), 1);
    assert.equal(await chat.getAttribute('inert'), '');
    assert.equal(await chat.getAttribute('aria-hidden'), 'true');
    assert.equal(await page.getByRole('region', { name: 'Albatross chat' }).count(), 0);

    // Open from the launcher: corner, non-modal, focus lands in the composer.
    step(`${width}: corner`);
    await launcher.click();
    await page.getByRole('dialog', { name: 'Albatross chat' }).waitFor();
    assert.equal(await layout(page), 'corner');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Message Albatross',
    );
    assert.equal(await launcher.count(), 0, 'the launcher hides while the chat is open');
    await noOverflow(page);
    const cornerBox = await box(chat);
    assert.ok(
      cornerBox.width <= 420 && cornerBox.height <= 660,
      `corner ${cornerBox.width}x${cornerBox.height}`,
    );
    assert.ok(cornerBox.x + cornerBox.width <= width - 20, 'corner panel keeps its inset');
    // The page is still live under the corner panel: no full-screen overlay.
    const hit = await page.evaluate(() => {
      const element = document.elementFromPoint(300, 400);
      return !!element?.closest('[data-assistant-page]');
    });
    assert.equal(hit, true, 'the page receives the pointer beside the corner panel');
    // A row already in view, so Playwright has no reason to scroll the list.
    await page.getByRole('button', { name: /Thread 8 ·/ }).click();
    assert.equal(await page.evaluate(() => window.assistantPreview.pageClicks), 1);
    // The halo is anchored to the corner and no wider than the panel plus
    // its 260px fade, so the page's left side is never softened.
    const halo = page.locator('.assistant-workspace__halo');
    const haloBox = await box(halo);
    assert.ok(haloBox.width <= 680.5, `halo width ${haloBox.width}`);
    assert.ok(
      haloBox.x + haloBox.width >= width - 1,
      `halo right edge ${haloBox.x + haloBox.width} of ${width}`,
    );
    assert.equal(await halo.evaluate((element) => getComputedStyle(element).pointerEvents), 'none');
    await page.getByLabel('Message Albatross').fill('half-typed question');
    // The panel is a lens, not a card: its own fill stays under 60% in both
    // themes, the blur does the legibility work, and the halo washes the
    // corner only. Both are read from computed style, not the stylesheet.
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      const glass = await chat.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, filter: style.backdropFilter };
      });
      assert.ok(alpha(glass.background) <= 0.6, `${theme} panel fill ${glass.background}`);
      assert.ok(
        alpha(glass.background) >= 0.4,
        `${theme} panel fill ${glass.background} keeps a contrast floor`,
      );
      assert.match(glass.filter, /blur\(2[0-9]px\)/, `${theme} panel blur ${glass.filter}`);
      assert.ok(
        alpha(await halo.evaluate((element) => getComputedStyle(element).backgroundImage.split(' 0%')[0])) <=
          0.45,
      );
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(artifacts, `corner-${width}-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    // Split: page left, chat right, both above their minimums, one seam.
    step(`${width}: split`);
    await page.getByRole('button', { name: 'Expand chat beside this page' }).click();
    await page.getByRole('region', { name: 'Albatross chat' }).waitFor();
    assert.equal(await layout(page), 'split');
    await noOverflow(page);
    const seam = page.getByRole('separator', { name: 'Resize page and chat' });
    assert.equal(await seam.count(), 1);
    const split = await panesInside(page, `${width} default split`);
    assert.ok(
      Math.abs(split.page.width - split.chat.width) <= 1,
      `default split ${split.page.width}/${split.chat.width}`,
    );
    await page.screenshot({ path: join(artifacts, `split-${width}.png`) });

    // Pointer resize honors both floors; keyboard resize nudges and resets.
    step(`${width}: resize`);
    const seamBox = await box(seam);
    const seamCentre = { x: seamBox.x + seamBox.width / 2, y: seamBox.y + seamBox.height / 2 };
    await page.mouse.move(seamCentre.x, seamCentre.y);
    await page.mouse.down();
    await page.mouse.move(seamCentre.x - 2000, seamCentre.y, { steps: 6 });
    await page.mouse.up();
    const narrowPage = await panesInside(page, `${width} page floor`);
    assert.ok(narrowPage.page.width <= 280.5, `page floor ${narrowPage.page.width}`);
    await page.mouse.move(seamCentre.x, seamCentre.y);
    const seamNow = await box(seam);
    await page.mouse.move(seamNow.x + 3, seamNow.y + 200);
    await page.mouse.down();
    await page.mouse.move(width + 500, seamNow.y + 200, { steps: 6 });
    await page.mouse.up();
    const narrowChat = await panesInside(page, `${width} chat floor`);
    assert.ok(narrowChat.chat.width <= 360.5, `chat floor ${narrowChat.chat.width}`);
    assert.equal(await page.getByLabel('Message Albatross').inputValue(), 'half-typed question');
    assert.equal(await page.locator('[data-assistant-workspace]').getAttribute('data-resizing'), 'false');
    await seam.focus();
    const valueBefore = Number(await seam.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowLeft');
    assert.equal(Number(await seam.getAttribute('aria-valuenow')), valueBefore - 2);
    await page.keyboard.press('Enter');
    assert.equal(await seam.getAttribute('aria-valuenow'), '50');
    assert.equal(await activeLabel(page), 'Resize page and chat', 'resizing never moves focus');
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await seam.getAttribute('aria-valuenow'), '60');
    await page.screenshot({ path: join(artifacts, `split-resized-${width}.png`) });
    // Home and End land exactly on the floors, with every pane inside the
    // frame: the share is a percent of the width after the seam, and the
    // stylesheet applies it to the same width.
    await page.keyboard.press('Home');
    const home = await panesInside(page, `${width} Home`);
    assert.ok(Math.abs(home.page.width - 280) <= 0.5, `Home page ${home.page.width}`);
    await page.keyboard.press('End');
    const end = await panesInside(page, `${width} End`);
    assert.ok(Math.abs(end.chat.width - 360) <= 0.5, `End chat ${end.chat.width}`);
    assert.equal(await activeLabel(page), 'Resize page and chat');
    await page.keyboard.press('Enter');
    assert.equal(await seam.getAttribute('aria-valuenow'), '50');

    // A drag that loses its seam (the layout leaves split under the pointer)
    // ends cleanly: nothing stays pointer-events: none, and the late pointer
    // up is ignored.
    step(`${width}: drag interrupted`);
    const seamMid = await box(seam);
    await page.mouse.move(seamMid.x + 3, seamMid.y + 300);
    await page.mouse.down();
    await page.mouse.move(seamMid.x + 60, seamMid.y + 300, { steps: 3 });
    assert.equal(await page.locator('[data-assistant-workspace]').getAttribute('data-resizing'), 'true');
    await page.evaluate(() => window.assistantPreview.setPresentation('full'));
    await page.waitForFunction(
      () => document.querySelector('[data-assistant-workspace]')?.dataset.layout === 'full',
    );
    assert.equal(await page.locator('[data-assistant-workspace]').getAttribute('data-resizing'), 'false');
    await page.mouse.up();
    assert.equal(await chat.evaluate((element) => getComputedStyle(element).pointerEvents), 'auto');
    await page.evaluate(() => window.assistantPreview.setPresentation('split'));
    await seam.waitFor();
    assert.equal(await page.locator('[data-assistant-workspace]').getAttribute('data-resizing'), 'false');
    await panesInside(page, `${width} after interrupted drag`);
    assert.equal(await pane.evaluate((element) => getComputedStyle(element).pointerEvents), 'auto');
    await seam.dblclick();
    assert.equal(await seam.getAttribute('aria-valuenow'), '50');

    // Full: the page is hidden and inert, but its state is untouched.
    step(`${width}: full`);
    await page.getByRole('button', { name: 'Focus on chat' }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-assistant-workspace]')?.dataset.layout === 'full',
    );
    assert.equal(await pane.getAttribute('inert'), '');
    assert.equal(await pane.getAttribute('aria-hidden'), 'true');
    assert.equal(await pane.evaluate((element) => getComputedStyle(element).visibility), 'hidden');
    assert.equal(await seam.count(), 0);
    await noOverflow(page);
    await page.screenshot({ path: join(artifacts, `full-${width}.png`) });

    await page.getByRole('button', { name: 'Show current page' }).click();
    await page.getByRole('button', { name: 'Return to corner chat' }).click();
    await page.getByRole('dialog', { name: 'Albatross chat' }).waitFor();
    assert.equal(await pane.getAttribute('inert'), null);

    // Nothing remounted, nothing lost, the stream kept ticking.
    step(`${width}: preservation`);
    const state = await page.evaluate(() => ({
      pageMounts: window.assistantPreview.pageMounts,
      chatMounts: window.assistantPreview.chatMounts,
      ticks: window.assistantPreview.ticks,
      scrollTop: document.querySelector('[data-page-list]').scrollTop,
    }));
    assert.equal(state.pageMounts, 1);
    assert.equal(state.chatMounts, 1);
    assert.ok(state.ticks > 2, `stream ticks kept running (${state.ticks})`);
    assert.equal(state.scrollTop, 120);
    assert.equal(await page.getByLabel('Draft reply').inputValue(), 'half-written reply');
    assert.equal(await page.getByLabel('Filter threads').inputValue(), 'thread');
    assert.equal(await page.getByLabel('Message Albatross').inputValue(), 'half-typed question');

    // Escape inside a popup menu closes the menu only; Escape in the chat
    // closes the chat and returns focus to the launcher.
    step(`${width}: escape`);
    await page.getByRole('button', { name: 'Chat history' }).click();
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    // The menu layer stays mounted through its exit animation and keeps
    // consuming Escape until it is gone; wait for the DOM, not the paint.
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.closest('[data-assistant-chat]'));
    assert.equal(await page.evaluate(() => window.assistantPreview.state().open), true);
    await page.getByLabel('Message Albatross').focus();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Message Albatross',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.assistantPreview.state().open);
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-assistant-launcher'));
    assert.equal(await chat.getAttribute('inert'), '');

    // Closing with the shortcut while working on the page leaves focus on
    // the page; closing from the chat's own Close button returns focus to
    // the element that had it when the chat opened (the filter input here),
    // because focus was inside the chat.
    step(`${width}: close from page`);
    await page.keyboard.press('Control+K');
    await page.getByRole('dialog', { name: 'Albatross chat' }).waitFor();
    await page.getByLabel('Filter threads').focus();
    await page.keyboard.press('Control+K');
    await page.waitForFunction(() => !window.assistantPreview.state().open);
    assert.equal(await activeLabel(page), 'Filter threads');
    await page.keyboard.press('Control+K');
    await page.getByRole('dialog', { name: 'Albatross chat' }).waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForFunction(() => !window.assistantPreview.state().open);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Filter threads');
    // Opened from the launcher (which unmounts in the opening commit), the
    // chat's own Close button hands focus to the freshly mounted launcher.
    step(`${width}: close from chat`);
    await launcher.click();
    await page.getByRole('dialog', { name: 'Albatross chat' }).waitFor();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Message Albatross',
    );
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForFunction(() => !window.assistantPreview.state().open);
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-assistant-launcher'));
    assert.equal(await page.evaluate(() => window.assistantPreview.chatMounts), 1);

    // Preference fallbacks: reduced motion stops the copy; more contrast and
    // reduced transparency remove the blur for an opaque panel.
    step(`${width}: preferences`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await launcher.waitFor();
    assert.equal(await launcher.getAttribute('data-rotating'), 'false');
    await page.emulateMedia({ reducedMotion: 'no-preference', contrast: 'more' });
    await page.reload();
    await launcher.click();
    await page.getByRole('dialog', { name: 'Albatross chat' }).waitFor();
    assert.equal(await chat.evaluate((element) => getComputedStyle(element).backdropFilter), 'none');
    assert.equal(alpha(await chat.evaluate((element) => getComputedStyle(element).backgroundColor)), 1);
    assert.equal(
      await page
        .locator('.assistant-workspace__halo')
        .evaluate((element) => getComputedStyle(element).display),
      'none',
    );
    await page.screenshot({ path: join(artifacts, `corner-contrast-${width}.png`) });
    await page.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' });
    await page.screenshot({ path: join(artifacts, `corner-forced-colors-${width}.png`) });
    await page.emulateMedia({ forcedColors: 'none' });
  }

  /* ---- the narrowest split: 280 + 6 + 360 exactly, nothing past the frame ---- */
  step('646: narrowest split');
  await page.setViewportSize({ width: 646, height: 800 });
  await page.goto(`${BASE}?open=1&presentation=split&mobile=0`);
  await page.getByRole('region', { name: 'Albatross chat' }).waitFor();
  assert.equal(await layout(page), 'split');
  const narrowest = await panesInside(page, '646 split');
  assert.ok(Math.abs(narrowest.page.width - 280) <= 0.5, `646 page ${narrowest.page.width}`);
  assert.ok(Math.abs(narrowest.chat.width - 360) <= 0.5, `646 chat ${narrowest.chat.width}`);
  const narrowSeam = page.getByRole('separator', { name: 'Resize page and chat' });
  await narrowSeam.focus();
  for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
    await page.keyboard.press(key);
    await panesInside(page, `646 ${key}`);
  }
  await page.screenshot({ path: join(artifacts, 'split-646.png') });

  /* ---- narrow desktop: a requested split paints full, never overflows ---- */
  step('640: narrow desktop');
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto(`${BASE}?open=1&presentation=split&mobile=0`);
  await page.getByRole('region', { name: 'Albatross chat' }).waitFor();
  assert.equal(await layout(page), 'full');
  await noOverflow(page);
  await page.screenshot({ path: join(artifacts, 'narrow-desktop-split-as-full.png') });

  /* ---- phone: always full-screen chat, page kept for the return ---- */
  step('390: phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}?rotate=400`);
  await page.getByRole('heading', { name: 'Mail' }).waitFor();
  await noOverflow(page);
  await page.getByLabel('Draft reply').fill('phone draft');
  await page.screenshot({ path: join(artifacts, 'launcher-390.png') });
  await launcher.click();
  await page.getByRole('region', { name: 'Albatross chat' }).waitFor();
  assert.equal(await layout(page), 'full');
  assert.equal(await pane.getAttribute('inert'), '');
  const phoneChat = await box(chat);
  assert.ok(
    phoneChat.width >= 389 && phoneChat.height >= 800,
    `phone chat ${phoneChat.width}x${phoneChat.height}`,
  );
  await noOverflow(page);
  await page.screenshot({ path: join(artifacts, 'full-390.png') });
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForFunction(() => !window.assistantPreview.state().open);
  assert.equal(await page.getByLabel('Draft reply').inputValue(), 'phone draft');
  assert.equal(await page.evaluate(() => window.assistantPreview.pageMounts), 1);

  assert.deepEqual(errors, []);
  console.log(`Assistant workspace UI verified. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
