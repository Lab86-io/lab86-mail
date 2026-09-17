/** Run alongside `ALBATROSS_PREVIEW_PORT=18849 bun scripts/preview-app-workspace.mjs`. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const artifacts = await mkdtemp(join(tmpdir(), 'albatross-send-'));
const errors = [];
const url = process.env.SEND_PREVIEW_URL || 'http://127.0.0.1:18849/send';
async function setup(query = '', options = {}, noStorage = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  if (noStorage)
    await context.addInitScript(() =>
      Object.defineProperty(window, 'indexedDB', {
        get() {
          throw new Error('Storage blocked');
        },
      }),
    );
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}${query}`);
  await page.waitForFunction(() => window.sendPreview);
  return page;
}
const counts = (page) => page.evaluate(() => window.sendPreview.counts());
const register = (page, id, seconds, mode) =>
  page.evaluate(({ id, seconds, mode }) => window.sendPreview.register(id, seconds, mode), {
    id,
    seconds,
    mode,
  });
const configure = (page, status, failUndo = false) =>
  page.evaluate(({ status, failUndo }) => window.sendPreview.configure(status, failUndo), {
    status,
    failUndo,
  });
const notice = (page, subject) => page.getByRole('region', { name: `Send status: ${subject}` });
try {
  const page = await setup('?seconds=10');
  // Regression: the provider has been idle much longer than the undo window.
  await page.clock.install();
  await page.clock.fastForward(120_000);
  await page.getByRole('button', { name: 'New message', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const toast = notice(page, 'The launch is ready');
  await toast.waitFor();
  assert.match(await toast.innerText(), /10s/);
  assert.equal((await counts(page)).effectCount, 0);
  await page.screenshot({ path: join(artifacts, 'countdown-desktop.png') });
  await toast.getByRole('button', { name: 'Undo send' }).click();
  await toast.waitFor({ state: 'detached' });
  await page.clock.fastForward(15_000);
  assert.equal(await page.locator('textarea:not([aria-hidden])').inputValue(), 'Let’s make it happen.');
  assert.equal((await counts(page)).effectCount, 0);
  console.log(
    'PASS actual composer honors preference; idle clock; immediate Undo restores without a delayed wipe',
  );

  for (const mode of ['new', 'reply', 'reply_all', 'forward']) {
    await register(page, mode, 30, mode);
    await notice(page, mode).getByRole('button', { name: 'Undo send' }).click();
    await notice(page, mode).waitFor({ state: 'detached' });
    const state = await page.evaluate(() => window.sendPreview.state().compose);
    assert.equal(state.mode, mode);
    assert.equal(state.anchorAccount, 'other@example.test');
    assert.equal(state.prefill.cc, 'cc@example.test');
    assert.equal(state.prefill.bcc, 'bcc@example.test');
    assert.equal(await page.locator('textarea:not([aria-hidden])').inputValue(), 'Keep this draft');
    assert.ok((await page.locator('body').innerText()).includes('notes.txt'));
  }
  console.log('PASS Undo preserves all compose modes, recipients, account, anchors and attachments');

  const offline = await setup('', {}, true);
  await offline.clock.install();
  await configure(offline, 'unknown');
  await register(offline, 'Storage blocked', 5);
  await offline.clock.fastForward(6_000);
  await offline.waitForFunction(() => window.sendPreview.counts().statusCalls > 0);
  assert.match(await notice(offline, 'Storage blocked').innerText(), /Confirming send/);
  assert.equal((await counts(offline)).effectCount, 0);
  await configure(offline, 'offline');
  await offline.clock.fastForward(2_000);
  assert.equal(await notice(offline, 'Storage blocked').count(), 1);
  await configure(offline, 'sent');
  await offline.clock.fastForward(2_000);
  await notice(offline, 'Storage blocked').waitFor({ state: 'detached' });
  assert.equal((await counts(offline)).effectCount, 1);
  await offline.clock.fastForward(10_000);
  assert.equal((await counts(offline)).effectCount, 1);
  assert.equal(await offline.locator('[data-send-celebration]').count(), 0);
  assert.equal(await offline.locator('[data-send-stamp]').count(), 0);
  console.log(
    'PASS unavailable storage, unknown/offline status, confirmation-only effect exactly once, cleanup',
  );

  const recover = await setup();
  await recover.clock.install();
  await configure(recover, 'pending', true);
  await register(recover, 'Retry Undo', 30);
  await notice(recover, 'Retry Undo').getByRole('button', { name: 'Undo send' }).click();
  assert.equal(await notice(recover, 'Retry Undo').count(), 1);
  assert.equal((await counts(recover)).effectCount, 0);
  await configure(recover, 'pending');
  await notice(recover, 'Retry Undo').getByRole('button', { name: 'Undo send' }).click();
  await notice(recover, 'Retry Undo').waitFor({ state: 'detached' });
  await configure(recover, 'failed');
  await register(recover, 'Failed send', 5);
  await recover.clock.fastForward(6_000);
  await notice(recover, 'Failed send').getByRole('button', { name: 'Restore draft' }).click();
  assert.equal((await counts(recover)).effectCount, 0);
  console.log('PASS unconfirmed cancellation is retryable; failed send restores without celebrating');

  const reload = await setup();
  await configure(reload, 'pending');
  await register(reload, 'Survives reload', 30);
  await reload.waitForFunction(async () => {
    const request = indexedDB.open('albatross-compose', 1);
    const db = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const read = db.transaction('pending-sends').objectStore('pending-sends').getAll();
    const records = await new Promise((resolve) => {
      read.onsuccess = () => resolve(read.result);
    });
    db.close();
    return records.length === 1;
  });
  // Keep the simulated provider pending after reload.
  await reload.addInitScript(() => {
    sessionStorage.setItem('send-preview-status', 'pending');
  });
  await reload.reload();
  await notice(reload, 'Survives reload').waitFor();
  assert.ok(await notice(reload, 'Survives reload').getByRole('button', { name: 'Undo send' }).isEnabled());
  console.log('PASS durable receipt survives reload');

  const mobile = await setup('', { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await mobile.clock.install();
  await configure(mobile, 'pending');
  await register(mobile, 'Five-minute countdown', 300);
  await register(mobile, 'Second message', 30);
  assert.match(await notice(mobile, 'Five-minute countdown').innerText(), /5:00/);
  for (const theme of ['light', 'dark']) {
    await mobile.evaluate((theme) => (document.documentElement.className = theme), theme);
    await mobile.screenshot({ path: join(artifacts, `countdown-mobile-${theme}.png`) });
    const box = await notice(mobile, 'Five-minute countdown').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
  }
  await configure(mobile, 'sent');
  await mobile.clock.fastForward(301_000);
  await notice(mobile, 'Five-minute countdown').waitFor({ state: 'detached' });
  assert.equal((await counts(mobile)).effectCount, 0);
  assert.equal(await mobile.locator('[data-send-stamp]').count(), 0);
  console.log('PASS stacked sends, 5-minute setting, narrow light/dark layouts and reduced motion');

  const instant = await setup('?seconds=0');
  await instant.getByRole('button', { name: 'New message', exact: true }).click();
  await instant.getByRole('button', { name: 'Send', exact: true }).click();
  await instant.waitForFunction(() => window.sendPreview.counts().effectCount === 1);
  assert.equal(await instant.getByRole('button', { name: 'Undo send' }).count(), 0);
  await instant.locator('[data-send-stamp]').waitFor();
  assert.match(await instant.locator('[data-send-stamp]').innerText(), /SENT!/);
  assert.equal(
    await instant.locator('[data-send-stamp]').evaluate((node) => getComputedStyle(node).pointerEvents),
    'none',
  );
  await instant.waitForTimeout(650);
  await instant.screenshot({ path: join(artifacts, 'sent-stamp-desktop.png') });
  console.log('PASS instant setting skips countdown; big SENT stamp with fireworks permits interaction');

  const smallStamp = await setup('?seconds=0', { viewport: { width: 390, height: 844 } });
  await smallStamp.getByRole('button', { name: 'New message', exact: true }).click();
  await smallStamp.getByRole('button', { name: 'Send', exact: true }).click();
  await smallStamp.locator('[data-send-stamp]').waitFor();
  await smallStamp.waitForTimeout(650);
  await smallStamp.screenshot({ path: join(artifacts, 'sent-stamp-mobile.png') });
  const stampBox = await smallStamp.locator('[data-send-stamp] > div').boundingBox();
  assert.ok(stampBox.x >= 0 && stampBox.x + stampBox.width <= 390);
  await smallStamp.locator('[data-send-stamp]').waitFor({ state: 'detached' });
  assert.equal(await smallStamp.locator('[data-send-celebration]').count(), 0);
  console.log('PASS phone stamp fits viewport; stamp and fireworks fully clean up');
  assert.deepEqual(errors, []);
  console.log(`Evidence: ${artifacts}`);
} finally {
  await browser.close();
}
