/**
 * Milestone A proof: what the pinned Collabora build lets a host change, in a
 * real editing session against the staging document server. Run
 * `bun scripts/prepare-collabora-verification.ts` first (it writes the
 * sessions file), then `bun scripts/spike-collabora-customization.ts`.
 * Output: /tmp/collabora-spike/{findings.md, *.png}.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { chromium, type Frame, type Page } from 'playwright-core';
import { getOfficeFile } from '../lib/documents/office-service';

const OUT = '/tmp/collabora-spike';
mkdirSync(OUT, { recursive: true });
const fixture = JSON.parse(readFileSync('/tmp/chat-doc-collabora-sessions.json', 'utf8'));
const file = fixture.files.find((item: any) => item.kind === 'doc');
if (!file) throw new Error('No doc session in the fixture; run prepare-collabora-verification first.');
const appOrigin = new URL(new URL(file.session.editorUrl).searchParams.get('WOPISrc')!).origin;
execFileSync(
  process.execPath,
  [
    'build',
    './scripts/fixtures/collabora-spike-preview.ts',
    '--target=browser',
    '--outfile=/tmp/collabora-spike/preview.js',
  ],
  { stdio: 'ignore' },
);
const js = readFileSync('/tmp/collabora-spike/preview.js', 'utf8');

/* Albatross light tokens, mapped onto the variables the 26.04 stylesheet defines. */
const ALBATROSS_CSS_VARIABLES = {
  '--color-primary': '#3B5BDB',
  '--color-primary-dark': '#2F4AB8',
  '--color-primary-darker': '#243A94',
  '--color-primary-lighter': '#E8EDFB',
  '--color-primary-text': '#FFFFFF',
  '--color-main-text': '#1E2A38',
  '--color-main-background': '#F6F8FB',
  '--color-background-lighter': '#FFFFFF',
  '--color-border': '#DDE3EA',
  '--color-toolbar-border': '#DDE3EA',
  '--cool-font': 'Geist, Helvetica Neue, Arial, sans-serif',
  '--border-radius': '8px',
};
const cssVariables = Object.entries(ALBATROSS_CSS_VARIABLES)
  .map(([key, value]) => `${key}=${value}`)
  .join(';');

const findings: string[] = [];
const note = (line: string) => {
  findings.push(line);
  console.log(line);
};

async function openEditor(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  params: Record<string, string>,
  label: string,
) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(`${appOrigin}/__office-spike`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}#state{height:24px;padding:4px 8px;font-size:12px}</style></head><body><script>window.__session=${JSON.stringify(file.session)};window.__extraParams=${JSON.stringify(params)}</script><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`,
    }),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on('requestfailed', (request) =>
    errors.push(`request failed: ${request.url().slice(0, 120)} ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`http ${response.status()} ${response.url().slice(0, 120)}`);
  });
  await page.goto(`${appOrigin}/__office-spike`);
  try {
    await page.waitForFunction(() => ['Ready', 'Modified'].includes((window as any).__state), undefined, {
      timeout: 90_000,
    });
  } catch (error) {
    const inboxNow = await page.evaluate(() => (window as any).__inbox).catch(() => 'unavailable');
    const state = await page.evaluate(() => (window as any).__state).catch(() => 'unavailable');
    note(
      `- Session "${label}" did not reach Ready. state=${state}; inbox=${JSON.stringify(inboxNow).slice(0, 800)}; errors=${errors.join(' | ') || 'none'}; frames=${page
        .frames()
        .map((f) => f.url().slice(0, 80))
        .join(', ')}`,
    );
    await page.screenshot({ path: `${OUT}/${label}-failed.png` }).catch(() => undefined);
    for (const candidate of page.frames())
      if (candidate.url().startsWith(file.session.serverUrl))
        await candidate
          .locator('body')
          .innerText({ timeout: 5_000 })
          .then((text) => writeFileSync(`${OUT}/${label}-editor-dom.txt`, text))
          .catch(() => undefined);
    throw error;
  }
  const frame = page.frames().find((candidate) => candidate.url().startsWith(file.session.serverUrl))!;
  // The free edition may still show a welcome dialog; close it if present.
  const welcome = frame.frameLocator('iframe[title="Welcome Dialog"]');
  await welcome
    .locator('#welcome-close')
    .waitFor({ state: 'attached', timeout: 4_000 })
    .then(() => welcome.locator('#welcome-close').evaluate((element: HTMLElement) => element.click()))
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${OUT}/${label}.png` });
  note(
    `- Session "${label}" loaded with params ${JSON.stringify(params)}; page errors: ${errors.length ? errors.join(' | ') : 'none'}.`,
  );
  return { page, frame };
}

async function inbox(page: Page) {
  return page.evaluate(() => (window as any).__inbox as Array<{ MessageId: string; Values: any }>);
}

async function post(page: Page, MessageId: string, Values: Record<string, unknown> = {}) {
  await page.evaluate(([id, values]) => (window as any).__post(id, values), [MessageId, Values] as const);
}

async function computed(frame: Frame, selector: string, property: string) {
  return frame.evaluate(
    ([sel, prop]) => {
      const element = document.querySelector(sel as string) as HTMLElement | null;
      return element
        ? getComputedStyle(element)
            .getPropertyValue(prop as string)
            .trim()
        : null;
    },
    [selector, property] as const,
  );
}

async function visible(frame: Frame, selector: string) {
  return frame.evaluate((sel) => {
    const element = document.querySelector(sel as string) as HTMLElement | null;
    if (!element) return 'missing';
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      ? 'visible'
      : 'hidden';
  }, selector);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  note(`# Collabora customization spike · ${new Date().toISOString()}`);
  note(`Server: ${file.session.serverUrl}. Document: synthetic DOCX under an isolated owner.`);

  // 1. Baseline: what the current integration shows.
  const base = await openEditor(browser, {}, '01-baseline');
  note(
    `  - Baseline --color-primary in editor root: ${await computed(base.frame, ':root', '--color-primary')}`,
  );
  note(
    `  - Baseline has menubar: ${await visible(base.frame, '.main-nav')}, notebookbar tabs: ${await visible(base.frame, '#toolbar-row, .notebookbar-tabs-container')}, sidebar: ${await visible(base.frame, '#sidebar-dock-wrapper')}, ruler: ${await visible(base.frame, '.cool-ruler')}, statusbar: ${await visible(base.frame, '#toolbar-down')}.`,
  );
  await base.page.close();

  // 2. Themed compact mode with defaults that beat saved UI state.
  const themed = await openEditor(
    browser,
    {
      ui_defaults: 'UIMode=classic;SavedUIState=false;TextRuler=false;TextSidebar=false;TextStatusbar=true',
      css_variables: cssVariables,
    },
    '02-themed-classic',
  );
  const primary = await computed(themed.frame, ':root', '--color-primary');
  const mainText = await computed(themed.frame, ':root', '--color-main-text');
  const font = await computed(themed.frame, ':root', '--cool-font');
  note(
    `  - css_variables applied: --color-primary=${primary} (expected #3B5BDB), --color-main-text=${mainText}, --cool-font=${font}.`,
  );
  note(
    `  - Classic mode: menubar ${await visible(themed.frame, '.main-nav')}, top toolbar ${await visible(themed.frame, '#toolbar-up')}, sidebar ${await visible(themed.frame, '#sidebar-dock-wrapper')}, ruler ${await visible(themed.frame, '.cool-ruler')}, statusbar ${await visible(themed.frame, '#toolbar-down')}.`,
  );
  const docBg = await themed.frame.evaluate(() => {
    const canvas = document.querySelector('#document-canvas') as HTMLCanvasElement | null;
    if (!canvas) return 'no canvas';
    const context = canvas.getContext('2d');
    if (!context) return 'no context';
    const sample = context.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1,
    ).data;
    return `rgb(${sample[0]},${sample[1]},${sample[2]})`;
  });
  note(`  - Document page pixel at canvas center (light UI): ${docBg}.`);

  // 3. Hide duplicates and add an Albatross button.
  await post(themed.page, 'Hide_Menubar');
  await post(themed.page, 'Hide_Button', { id: 'save' });
  await post(themed.page, 'Hide_Button', { id: 'print' });
  await post(themed.page, 'Insert_Button', {
    id: 'albatross',
    imgurl: `${appOrigin}/favicon.svg`,
    hint: 'Ask Albatross',
    label: 'Albatross',
    insertBefore: 'undo',
  });
  await themed.page.waitForTimeout(1_000);
  await themed.page.screenshot({ path: `${OUT}/03-hidden-and-inserted.png` });
  const toolbarIds = await themed.frame.evaluate(() =>
    Array.from(document.querySelectorAll('#toolbar-up [id]'))
      .map((node) => node.id)
      .filter(Boolean)
      .slice(0, 40)
      .join(' '),
  );
  note(`  - Classic top toolbar item ids: ${toolbarIds}.`);
  note(
    `  - After Hide_Menubar/Hide_Button: menubar ${await visible(themed.frame, '.main-nav')}, save button ${await visible(themed.frame, '#save')}, print button ${await visible(themed.frame, '#print')}, inserted button ${await visible(themed.frame, '#albatross')}.`,
  );
  const clicked = await themed.frame
    .locator('#albatross')
    .click({ timeout: 3_000 })
    .then(async () => {
      await themed.page.waitForTimeout(500);
      return (await inbox(themed.page)).some(
        (message) => message.MessageId === 'Clicked_Button' && message.Values?.Id === 'albatross',
      );
    })
    .catch(() => false);
  note(`  - Clicking the inserted button produced Clicked_Button {Id:'albatross'}: ${clicked}.`);
  await post(themed.page, 'Show_Menubar');

  // 4. Execute formatting from the host and check for any state feedback.
  await themed.frame.locator('#clipboard-area').click({ force: true });
  await themed.page.keyboard.press('Control+Home');
  const marker = `Albatross spike ${Date.now()}`;
  await themed.page.keyboard.type(marker);
  await themed.page.keyboard.press('Shift+Home');
  const before = (await inbox(themed.page)).length;
  await post(themed.page, 'Send_UNO_Command', { Command: '.uno:Bold' });
  await post(themed.page, 'Send_UNO_Command', {
    Command: '.uno:StyleApply',
    Args: {
      Style: { type: 'string', value: 'Heading 1' },
      FamilyName: { type: 'string', value: 'ParagraphStyles' },
    },
  });
  await themed.page.waitForTimeout(1_500);
  const after = (await inbox(themed.page)).slice(before);
  note(
    `  - Messages received after Send_UNO_Command Bold + StyleApply: ${after.map((m) => m.MessageId).join(', ') || 'none'}.`,
  );
  note(
    `  - Any message carrying formatting state (Bold/Style/Font/Undo): ${after.some((m) => /Bold|Style|Font|Undo/i.test(JSON.stringify(m))) ? 'YES' : 'none'}.`,
  );
  const boldState = await themed.frame.evaluate(() => {
    const map = (window as any).app?.map;
    const items = map?.stateChangeHandler?._items;
    return items
      ? { bold: items['.uno:Bold'], style: items['.uno:StyleApply'], undo: items['.uno:Undo'] }
      : 'no state handler';
  });
  note(`  - Internal editor state after the commands (not exposed to hosts): ${JSON.stringify(boldState)}.`);
  // Second attempt with an editor-side selection: select all, then bold.
  await post(themed.page, 'Send_UNO_Command', { Command: '.uno:SelectAll' });
  await themed.page.waitForTimeout(400);
  await post(themed.page, 'Send_UNO_Command', { Command: '.uno:Bold' });
  await themed.page.waitForTimeout(1_200);
  const boldState2 = await themed.frame.evaluate(() => {
    const items = (window as any).app?.map?.stateChangeHandler?._items;
    return items ? { bold: items['.uno:Bold'], undo: items['.uno:Undo'] } : 'no state handler';
  });
  note(
    `  - After .uno:SelectAll then .uno:Bold from the host: internal state ${JSON.stringify(boldState2)}.`,
  );
  await themed.page.keyboard.press('End');
  await themed.page.screenshot({ path: `${OUT}/04-formatted.png` });

  // 5. Live UI mode switch without reload.
  await post(themed.page, 'Action_ChangeUIMode', { Mode: 'notebookbar' });
  await themed.page.waitForTimeout(2_500);
  const modeResp = (await inbox(themed.page)).find((m) => m.MessageId === 'Action_ChangeUIMode_Resp');
  note(
    `  - Action_ChangeUIMode notebookbar: response ${JSON.stringify(modeResp?.Values) ?? 'none'}; tabs now ${await visible(themed.frame, '#toolbar-row, .notebookbar-tabs-container')}; inserted button still present: ${await visible(themed.frame, '#albatross, .integrator-shortcut')}.`,
  );
  await post(themed.page, 'Hide_NotebookTab', { id: 'File' });
  await post(themed.page, 'Hide_NotebookTab', { id: 'Help' });
  await post(themed.page, 'Hide_Command', { id: '.uno:Save' });
  await post(themed.page, 'Hide_Command', { id: '.uno:Print' });
  await themed.page.waitForTimeout(2_500);
  const tabIds = await themed.frame.evaluate(() =>
    Array.from(document.querySelectorAll('[id$="-tab-label"]')).map(
      (node) => `${node.id}:${(node as HTMLElement).offsetParent ? 'shown' : 'hidden'}`,
    ),
  );
  note(`  - Notebookbar tab ids and visibility after Hide_NotebookTab File/Help: ${tabIds.join(', ')}.`);
  note(
    `  - Hide_Command .uno:Save/.uno:Print in notebookbar: save ${await visible(themed.frame, '.unoSave, #save')}, print ${await visible(themed.frame, '.unoPrint, #print')}.`,
  );
  await post(themed.page, 'Collapse_Notebookbar');
  await themed.page.waitForTimeout(1_000);
  await themed.page.screenshot({ path: `${OUT}/05-notebookbar-collapsed.png` });
  note(`  - Collapse_Notebookbar: toolbar row ${await visible(themed.frame, '#toolbar-row')}.`);
  await post(themed.page, 'Extend_Notebookbar');
  await post(themed.page, 'Action_ChangeUIMode', { Mode: 'classic' });
  await themed.page.waitForTimeout(2_000);

  // 6. Save through the acknowledged flow and verify the formatting persisted.
  await post(themed.page, 'Action_Save', {
    DontTerminateEdit: true,
    DontSaveIfUnmodified: false,
    Notify: true,
    ExtendedData: 'spike',
  });
  await themed.page.waitForFunction(
    () => (window as any).__inbox.some((m: any) => m.MessageId === 'Action_Save_Resp'),
    undefined,
    { timeout: 60_000 },
  );
  const saveResp = (await inbox(themed.page)).find((m) => m.MessageId === 'Action_Save_Resp');
  note(`  - Action_Save_Resp: ${JSON.stringify(saveResp?.Values)}.`);
  let record = await getOfficeFile(fixture.userId, file.documentId);
  const deadline = Date.now() + 60_000;
  while ((!record?.version?.url || record.currentRevision < 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    record = await getOfficeFile(fixture.userId, file.documentId);
  }
  if (!record?.version?.url) throw new Error('No stored revision after save.');
  const zip = await JSZip.loadAsync(await (await fetch(record.version.url)).arrayBuffer());
  const documentXml = await zip.file('word/document.xml')!.async('string');
  const hasMarker = documentXml.replace(/<[^>]+>/g, '').includes(marker);
  const boldRun =
    /<w:r>(?:(?!<\/w:r>).)*<w:b\/>(?:(?!<\/w:r>).)*Albatross spike/s.test(documentXml) ||
    /<w:b\/>/.test(documentXml);
  const heading = /w:pStyle w:val="Heading1"/.test(documentXml);
  note(
    `  - Stored revision ${record.currentRevision}: marker present ${hasMarker}; bold run present ${boldRun}; Heading 1 style present ${heading}.`,
  );
  await themed.page.close();

  // 7. Dark UI: does the document page stay paper-white?
  const dark = await openEditor(
    browser,
    {
      ui_defaults: 'UIMode=classic;SavedUIState=false;UITheme=dark;TextRuler=false;TextSidebar=false',
      css_variables: cssVariables,
    },
    '06-dark-ui',
  );
  const darkAttr = await dark.frame.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const darkDocBg = await dark.frame.evaluate(() => {
    const canvas = document.querySelector('#document-canvas') as HTMLCanvasElement | null;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return 'no canvas';
    const sample = context.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1,
    ).data;
    return `rgb(${sample[0]},${sample[1]},${sample[2]})`;
  });
  note(
    `  - UITheme=dark: data-theme=${darkAttr}; document page pixel at canvas center: ${darkDocBg} (light UI was ${docBg}).`,
  );
  await post(dark.page, 'Send_UNO_Command', {
    Command: '.uno:ChangeTheme',
    Args: { NewTheme: { type: 'string', value: 'Light' } },
  });
  await dark.page.waitForTimeout(2_500);
  const relit = await dark.frame.evaluate(() => {
    const canvas = document.querySelector('#document-canvas') as HTMLCanvasElement | null;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return 'no canvas';
    const sample = context.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1,
    ).data;
    return `rgb(${sample[0]},${sample[1]},${sample[2]})`;
  });
  await dark.page.screenshot({ path: `${OUT}/07-dark-ui-light-page.png` });
  note(
    `  - Dark chrome with .uno:ChangeTheme Light sent by the host: page pixel ${relit}; chrome data-theme still ${await dark.frame.evaluate(() => document.documentElement.getAttribute('data-theme'))}.`,
  );
  const afterDark = await getOfficeFile(fixture.userId, file.documentId);
  note(
    `  - Stored revision after the dark session: ${afterDark?.currentRevision} (unchanged from ${record.currentRevision}: ${afterDark?.currentRevision === record.currentRevision}); the dark chrome saved nothing and the file keeps its light colors.`,
  );
  await dark.page.close();
} catch (error) {
  note(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
} finally {
  writeFileSync(`${OUT}/findings.md`, `${findings.join('\n')}\n`);
  await browser.close();
}
