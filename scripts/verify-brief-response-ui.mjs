/** Real React surfaces, deterministic agent streams, no provider mutations. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const artifacts = await mkdtemp('/tmp/albatross-brief-response-');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Allows the agent handoff to be checked while another session iterates on
  // the masthead; default acceptance still checks every presentation assertion.
  for (const width of process.env.BRIEF_RESPONSE_ONLY ? [] : [320, 390, 768, 1046, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('http://127.0.0.1:18847/?view=today');
    await page.locator('[data-brief-header-weather]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.locator('[data-brief-art-frame]').evaluate((frame) => {
      const title = frame.querySelector('h1').getBoundingClientRect();
      const weather = frame.querySelector('[data-brief-header-weather]');
      const f = (frame.querySelector('.brief-masthead__painting') ?? frame).getBoundingClientRect(),
        w = weather.getBoundingClientRect(),
        s = getComputedStyle(weather);
      const credit = frame.querySelector('[data-brief-art-credit], figcaption').getBoundingClientRect();
      return {
        centered: Math.abs(title.y + title.height / 2 - f.y - f.height / 2),
        below: w.top >= title.bottom,
        border: s.borderTopWidth,
        fill: s.backgroundColor,
        height: w.height,
        overflow: weather.scrollWidth > weather.clientWidth,
        creditGap: credit.top - w.bottom,
        creditInside: credit.bottom <= frame.getBoundingClientRect().bottom,
        margin: getComputedStyle(document.querySelector('[data-workspace-panel]')).margin,
      };
    });
    assert.ok(geometry.centered < 1, `title independently centered at ${width}`);
    assert.ok(geometry.below);
    assert.ok(geometry.creditGap >= 11, `weather and art credit do not overlap at ${width}`);
    assert.ok(geometry.creditInside);
    assert.equal(geometry.border, '0px');
    assert.equal(geometry.fill, 'rgba(0, 0, 0, 0)');
    assert.equal(geometry.margin, '6px');
    assert.equal(geometry.overflow, false);
    if (width >= 1046) assert.ok(geometry.height < 27, 'weather fits one line');
    await page.screenshot({ path: `${artifacts}/today-${width}.png` });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  if (process.env.BRIEF_RESPONSE_ONLY) {
    await page.goto('http://127.0.0.1:18847/?view=today');
    await page.locator('[data-today-thread]').first().waitFor();
  }
  await page.evaluate(() =>
    window.workspacePreview
      .state()
      .setChatScope({ kind: 'work', workId: 'other-work', label: 'Previous work' }),
  );
  await page.evaluate(() => {
    window.workspacePreview.manualAgent = true;
  });
  await page.locator('[data-assistant-launcher]').click();
  const chat = page.locator('[data-assistant-chat]');
  const composer = chat.locator('textarea');
  await composer.fill('Finish the current request first.');
  await composer.press('Control+Enter');
  await chat.getByText('The draft stays here.', { exact: true }).waitFor();
  await composer.fill('Preserve this separate composer draft.');
  await chat.locator('input[type=file]').setInputFiles({
    name: 'separate-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('separate notes'),
  });
  await chat.getByRole('button', { name: 'Close', exact: true }).click();
  const card = page.locator('[data-today-thread]').first();
  await card.getByRole('button', { name: 'Respond & act' }).click();
  await card
    .getByRole('textbox', { name: 'What would you like Albatross to do?' })
    .fill('Draft the reply and a proposal, then create an Albatross to track this.');
  await page.evaluate(() => {
    for (const [key, data] of window.__previewQueryClient.getQueriesData({
      queryKey: ['narrative', 'workspace'],
    })) {
      if (!data?.threads?.length) continue;
      window.__previewQueryClient.setQueryData(key, {
        ...data,
        threads: data.threads.map((thread, i) =>
          i ? thread : { ...thread, nextStep: 'Prepare the revised proposal before replying.' },
        ),
      });
    }
  });
  await card.getByText('The recommendation changed.', { exact: false }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Take it forward' }).isDisabled(), true);
  assert.ok((await card.getByRole('textbox').inputValue()).includes('Draft the reply'));
  await card.getByRole('button', { name: 'Use updated recommendation' }).click();
  await card.getByRole('button', { name: 'Take it forward' }).click();
  await chat.getByText('Up next ·', { exact: false }).waitFor();
  assert.equal(await chat.getAttribute('data-layout'), 'split');
  assert.equal(
    await page.evaluate(() => window.workspacePreview.requests.filter((r) => r.path === '/api/agent').length),
    1,
  );
  assert.equal(await composer.inputValue(), 'Preserve this separate composer draft.');
  await page.evaluate(() => window.workspacePreview.finishAgent());
  await page.waitForFunction(
    () => window.workspacePreview.requests.filter((r) => r.path === '/api/agent').length === 2,
  );
  await chat.getByText('From your brief ·', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.workspacePreview.state().chatScopeKind), 'global');
  assert.ok(
    await page.evaluate(() =>
      window.workspacePreview.requests.some(
        (r) =>
          r.path === '/api/chats' &&
          r.body.workId === 'other-work' &&
          r.body.messages.some((m) => m.role === 'assistant'),
      ),
    ),
  );
  const request = await page.evaluate(
    () => window.workspacePreview.requests.filter((r) => r.path === '/api/agent').at(-1).body,
  );
  assert.equal(request.briefResponse.stamp.length, 64);
  assert.ok(request.briefResponse.recommendation.length > 0);
  assert.equal(
    request.messages.at(-1).parts.some((p) => p.type === 'file'),
    false,
    'a brief response never consumes separate attachments',
  );
  assert.ok(request.messages.at(-1).parts.some((p) => p.text?.includes('Draft the reply and a proposal')));
  assert.equal(await composer.inputValue(), 'Preserve this separate composer draft.');
  assert.ok(await chat.getByText('separate-notes.txt', { exact: false }).count());

  await page.evaluate(() => {
    const payload = {
      id: 'brief-draft',
      channel: 'email',
      to: ['maya@example.test'],
      subject: 'North House · proposed schedule',
      body: 'Here is the draft for your review.',
    };
    window.workspacePreview.emitAgent({
      type: 'tool-input-available',
      toolCallId: 'brief-draft',
      toolName: 'show_message_draft',
      input: payload,
      dynamic: true,
    });
    window.workspacePreview.emitAgent({
      type: 'tool-output-available',
      toolCallId: 'brief-draft',
      output: { ok: true, component: 'message-draft', payload },
    });
    window.workspacePreview.finishAgent();
  });
  await chat.getByText('North House · proposed schedule', { exact: true }).waitFor();
  await page.waitForTimeout(700);
  assert.equal(
    await page.evaluate(() => window.workspacePreview.requests.filter((r) => r.path === '/api/agent').length),
    2,
    'no duplicate/automatic loop',
  );
  const shapes = await page.evaluate(() => {
    const elements = [
      document.querySelector('[data-sidebar="menu-button"][aria-keyshortcuts]'),
      document.querySelector('[data-sidebar="menu-button"][data-active="true"]'),
      document.querySelector('[data-assistant-chat] button[aria-label="Send"]'),
    ];
    return elements.map((el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return [s.borderRadius, s.cornerShape];
    });
  });
  assert.ok(shapes.every(Boolean));
  assert.ok(shapes.every((shape) => JSON.stringify(shape) === JSON.stringify(shapes[0])));
  assert.ok(shapes[0][1].startsWith('superellipse('));
  await page.screenshot({ path: `${artifacts}/response-draft-and-corners.png` });
  // The review server supplies completed sample artifacts without test-driver input.
  await page.goto('http://127.0.0.1:18847/?view=today');
  await page.locator('[data-today-thread]').first().getByRole('button', { name: 'Respond & act' }).click();
  await page
    .getByRole('textbox', { name: 'What would you like Albatross to do?' })
    .fill('Draft a reply and proposal.');
  await page.getByRole('button', { name: 'Take it forward' }).click();
  await chat.getByText('North House · photography and review', { exact: true }).waitFor();
  const proposal = chat.getByRole('link', { name: /North House proposal/ });
  await proposal.click();
  await page.getByRole('textbox', { name: 'File name', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'File name', exact: true }).inputValue(),
    'North House proposal',
  );
  assert.equal(
    await page.evaluate(() => window.workspacePreview.calls.some((c) => /send_email|schedule_send/.test(c))),
    false,
  );
  await page.screenshot({ path: `${artifacts}/sample-proposal-review.png` });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${process.env.BRIEF_RESPONSE_ONLY ? 'agent handoff only' : 'centered masthead, weather, shared margins and corners'}, queued brief response, retained composer/files, inline draft. ${artifacts}`,
  );
} finally {
  await browser.close();
}
