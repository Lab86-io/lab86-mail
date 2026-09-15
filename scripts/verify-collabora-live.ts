/**
 * Live verification of the real CollaboraFrame against the staging document
 * server. Run `bun scripts/prepare-collabora-verification.ts` first. With
 * `OFFICE_THEMED_CHROME=true` the run also proves the themed chrome: the css
 * variables inside the frame, the hidden menubar, the hidden save and print
 * commands, the Albatross button and its click, the live mode switch, and
 * the white page under a dark chrome. Screenshots go to /tmp/collabora-chrome.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { chromium, type Frame, type Page } from 'playwright-core';
import { collaboraCssVariableMap, type EditorExtension } from '../lib/documents/collabora-chrome';
import { getOfficeFile } from '../lib/documents/office-service';
import { envFlag } from '../lib/hosted/controls';

const THEMED = envFlag('OFFICE_THEMED_CHROME');
const SHOTS = '/tmp/collabora-chrome';
const EXTENSIONS: Record<string, EditorExtension> = { doc: 'docx', sheet: 'xlsx', deck: 'pptx' };
const ICON = readFileSync(new URL('../public/office/albatross-toolbar.svg', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const fixture = JSON.parse(readFileSync('/tmp/chat-doc-collabora-sessions.json', 'utf8'));
const appOrigin = new URL(new URL(fixture.files[0].session.editorUrl).searchParams.get('WOPISrc')!).origin;
execFileSync(
  process.execPath,
  [
    'build',
    './scripts/fixtures/collabora-live-preview.tsx',
    '--target=browser',
    '--outfile=/tmp/chat-doc-collabora-preview.js',
  ],
  { stdio: 'ignore' },
);
const js = readFileSync('/tmp/chat-doc-collabora-preview.js', 'utf8');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

/** 'missing', 'visible' when any match is shown, else 'hidden'. */
async function visibility(frame: Frame, selector: string) {
  return frame.evaluate((sel) => {
    const elements = Array.from(document.querySelectorAll(sel as string)) as HTMLElement[];
    if (!elements.length) return 'missing';
    const shown = elements.some((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    return shown ? 'visible' : 'hidden';
  }, selector);
}

async function pagePixel(frame: Frame) {
  return frame.evaluate(() => {
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
}

async function waitForText(page: Page, selector: string, text: string, timeout = 15_000) {
  await page.waitForFunction(
    ([sel, expected]) => document.querySelector(sel as string)?.textContent === expected,
    [selector, text] as const,
    { timeout },
  );
}

async function openEditor(file: any, theme: 'light' | 'dark', label: string) {
  const session = {
    ...file.session,
    extension: file.session.extension ?? EXTENSIONS[file.kind],
    chrome: { enabled: THEMED },
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.route(`${appOrigin}/__office-verification`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}.hidden{display:none}iframe{height:100%;width:100%;border:0}</style></head><body><div id="root"></div><script>window.__session=${JSON.stringify(session)};window.__theme=${JSON.stringify(theme)}</script><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`,
    }),
  );
  const iconRequests: string[] = [];
  await page.route(`${appOrigin}/office/albatross-toolbar.svg`, (route) => {
    iconRequests.push(route.request().frame().url().slice(0, 60));
    return route.fulfill({ contentType: 'image/svg+xml', body: ICON });
  });
  await page.route(`${appOrigin}/api/office/${file.documentId}`, async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ document: await getOfficeFile(fixture.userId, file.documentId) }),
    }),
  );
  const failures: string[] = [];
  page.on('websocket', (ws) => {
    console.log('Websocket opened', new URL(ws.url()).origin);
    ws.on('socketerror', (error) => console.log('Websocket error', error));
  });
  page.on('requestfailed', (req) =>
    console.log('Request failed', new URL(req.url()).origin, req.failure()?.errorText),
  );
  page.on('response', (response) => {
    if (response.status() >= 400)
      console.log(
        'HTTP failure',
        response.status(),
        new URL(response.url()).origin,
        new URL(response.url()).pathname.slice(0, 70),
      );
  });
  page.on('pageerror', (e) => failures.push(e.message));
  await page.goto(`${appOrigin}/__office-verification`);
  const diagnose = async (error: unknown) => {
    console.log(
      'Editor state:',
      await page
        .locator('#state')
        .textContent({ timeout: 5000 })
        .catch(() => '<unavailable>'),
    );
    console.log('Browser errors:', failures);
    console.log(
      'Editor inbox:',
      JSON.stringify(await page.evaluate(() => (window as any).__inbox).catch(() => 'unavailable')).slice(
        0,
        1200,
      ),
    );
    for (const frame of page.frames())
      if (frame.url().startsWith(file.session.serverUrl))
        await frame
          .locator('body')
          .innerText({ timeout: 5000 })
          .then((body) => writeFileSync(`/tmp/chat-doc-${label}-editor-dom.txt`, body))
          .catch(() => {});
    await page.screenshot({ path: `/tmp/chat-doc-${label}-failed.png`, timeout: 5000 }).catch(() => {});
    throw error;
  };
  try {
    await page.waitForFunction(
      () => ['Ready', 'Modified'].includes(document.getElementById('state')?.textContent || ''),
      undefined,
      { timeout: 90000 },
    );
  } catch (error) {
    await diagnose(error);
  }
  console.log(`${label}: real embedded editor loaded.`);
  const frame = page.frames().find((frame) => frame.url().startsWith(file.session.serverUrl))!;
  writeFileSync(`/tmp/chat-doc-${label}-editor-dom.txt`, await frame.locator('body').innerText());
  await page.screenshot({ path: `/tmp/chat-doc-${label}-open.png` });
  // The free edition may still show a welcome dialog; close it when present.
  const welcome = frame.frameLocator('iframe[title="Welcome Dialog"]');
  await welcome
    .locator('#welcome-close')
    .waitFor({ state: 'attached', timeout: 4000 })
    .then(async () => {
      await welcome.locator('#welcome-close').evaluate((element: HTMLElement) => element.click());
      await frame.locator('.iframe-welcome-wrap').waitFor({ state: 'hidden', timeout: 10000 });
    })
    .catch(() => undefined);
  return { page, frame, diagnose, iconRequests };
}

/** The themed-chrome proofs shared by the light and the dark pass. */
async function verifyChrome(
  page: Page,
  frame: Frame,
  theme: 'light' | 'dark',
  label: string,
  iconRequests: string[],
) {
  const expected = collaboraCssVariableMap(theme);
  const primary = await computed(frame, ':root', '--color-primary');
  const font = await computed(frame, ':root', '--cool-font');
  const mainText = await computed(frame, ':root', '--color-main-text');
  console.log(
    `${label}: css variables in the frame: --color-primary=${primary} --color-main-text=${mainText} --cool-font=${font}.`,
  );
  assert(font === expected['--cool-font'], `css_variables not applied: --cool-font=${font}`);
  assert(
    primary?.toLowerCase() === expected['--color-primary'],
    `css_variables not applied: --color-primary=${primary}, expected ${expected['--color-primary']}`,
  );
  const menubar = await visibility(frame, '.main-nav');
  assert(menubar !== 'visible', `menubar still visible (${menubar})`);
  console.log(`${label}: menubar ${menubar}.`);
  assert((await visibility(frame, '#albatross')) === 'visible', 'Albatross button missing from the toolbar');
  const markup = await frame.evaluate(
    () => document.querySelector('#albatross')?.outerHTML.replace(/\s+/g, ' ').slice(0, 400) ?? '',
  );
  console.log(`${label}: Albatross button markup: ${markup}`);
  const iconDeadline = Date.now() + 5000;
  while (!iconRequests.length && Date.now() < iconDeadline) await page.waitForTimeout(250);
  assert(iconRequests.length > 0, 'the editor never requested the Albatross icon from the app origin');
  const iconShown = await frame.evaluate(() => {
    const button = document.querySelector('#albatross') as HTMLElement | null;
    if (!button) return 'missing';
    const image = button.querySelector('img') as HTMLImageElement | null;
    if (image) return image.naturalWidth > 0 ? 'img loaded' : `img pending (${image.src.slice(0, 80)})`;
    const painted = Array.from(button.querySelectorAll('*'))
      .concat(button)
      .map((node) => getComputedStyle(node as Element).backgroundImage)
      .find((value) => value.includes('albatross-toolbar'));
    return painted ? 'background-image' : 'no icon';
  });
  console.log(`${label}: Albatross icon requested by ${iconRequests[0]}; rendered as ${iconShown}.`);
  assert(iconShown !== 'no icon' && iconShown !== 'missing', `Albatross icon not rendered (${iconShown})`);
  await frame.locator('#albatross').click();
  await waitForText(page, '#albatross-clicks', '1', 5000);
  console.log(`${label}: Albatross button present with its icon; its click reached the host.`);
  const classicSave = await visibility(frame, '#save');
  console.log(
    `${label}: classic toolbar save button ${classicSave} (Hide_Button is unsupported on this build).`,
  );
  await page.screenshot({ path: `${SHOTS}/${label}-${theme}-compact.png` });
  // All tools: the notebookbar comes back live and the hides survive.
  await page.locator('#all-tools').click();
  await waitForText(page, '#uimode', 'notebookbar');
  await page.waitForTimeout(2000);
  const tabs = await visibility(frame, '.notebookbar-tabs-container, #toolbar-row');
  assert(tabs === 'visible', `notebookbar tabs ${tabs} after Action_ChangeUIMode`);
  const save = await visibility(frame, '.unoSave');
  const print = await visibility(frame, '.unoPrint');
  assert(save !== 'visible', `save command visible in the notebookbar (${save})`);
  assert(print !== 'visible', `print command visible in the notebookbar (${print})`);
  assert(
    (await visibility(frame, '#albatross, .integrator-shortcut')) === 'visible',
    'Albatross button lost after the mode switch',
  );
  console.log(
    `${label}: All tools switched to the notebookbar; save ${save}, print ${print}, menubar ${await visibility(frame, '.main-nav')}.`,
  );
  await page.screenshot({ path: `${SHOTS}/${label}-${theme}-all-tools.png` });
  await page.locator('#all-tools').click();
  await waitForText(page, '#uimode', 'classic');
  await page.waitForTimeout(1500);
  assert((await visibility(frame, '#toolbar-up')) === 'visible', 'classic toolbar did not return');
  console.log(`${label}: Compact tools switched back to the classic toolbar.`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const files = fixture.files.filter(
    (item: any) => !process.env.OFFICE_VERIFY_KIND || item.kind === process.env.OFFICE_VERIFY_KIND,
  );
  for (const file of files) {
    const label = file.rich ? `${file.kind}-rich` : file.kind;
    const extension: EditorExtension = file.session.extension ?? EXTENSIONS[file.kind];
    const { page, frame, diagnose, iconRequests } = await openEditor(file, 'light', label);
    try {
      if (THEMED) await verifyChrome(page, frame, 'light', label, iconRequests);
      const marker = `ALBATROSS-LIVE-${Date.now()}`;
      if (extension === 'docx') {
        await frame.locator('#clipboard-area').click({ force: true });
        await page.keyboard.press('Control+Home');
        await page.keyboard.type(marker);
      } else if (extension === 'xlsx') {
        await frame.locator('#clipboard-area').click({ force: true });
        await page.keyboard.type(marker);
        await page.keyboard.press('Enter');
      } else if (THEMED) {
        // The compact toolbar has no New Slide button; All tools brings it back.
        await page.locator('#all-tools').click();
        await waitForText(page, '#uimode', 'notebookbar');
        await frame.locator('[id^="home-create-slide"][id$="-button"]:visible').first().click();
        await page.locator('#all-tools').click();
        await waitForText(page, '#uimode', 'classic');
      } else {
        await frame.locator('[id^="home-create-slide"][id$="-button"]:visible').first().click();
      }
      await page.waitForFunction(
        () => document.getElementById('state')?.textContent === 'Modified',
        undefined,
        { timeout: 15000 },
      );
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('saved')?.textContent === 'Saved', undefined, {
        timeout: 90000,
      });
      const record = await getOfficeFile(fixture.userId, file.documentId);
      if (!record?.version?.url || record.currentRevision < 2)
        throw new Error('Editor save did not create a durable revision');
      const zip = await JSZip.loadAsync(
        await (await fetch(record.version.url, { signal: AbortSignal.timeout(45_000) })).arrayBuffer(),
      );
      const text = (
        await Promise.all(
          Object.values(zip.files)
            .filter((f) => f.name.endsWith('.xml'))
            .map((f) => f.async('string')),
        )
      ).join('\n');
      if (extension !== 'pptx' && !text.replace(/<[^>]+>/g, '').includes(marker))
        throw new Error('Saved file did not contain the typed marker');
      if (
        extension === 'pptx' &&
        Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+.xml$/.test(name)).length < 2
      )
        throw new Error('New slide missing from saved presentation');
      console.log(
        `${label}: edited in browser, saved through WOPI, verified revision ${record.currentRevision} from storage.`,
      );
      await page.screenshot({ path: `/tmp/chat-doc-${label}-saved.png` });
      await page.getByRole('button', { name: 'Close editor', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('iframe[title="Document editor"]'));
      const deadline = Date.now() + 15000;
      while ((await getOfficeFile(fixture.userId, file.documentId))?.wopiLock && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 250));
      if ((await getOfficeFile(fixture.userId, file.documentId))?.wopiLock)
        throw new Error('Closing the editor did not release the document lock');
      console.log(`${label}: closing the editor released its document lock.`);
    } catch (error) {
      await diagnose(error);
    } finally {
      await page.close();
    }
  }
  // Dark application theme: dark chrome, white page. One document is enough.
  const darkFile = files.find((item: any) => item.kind === 'doc' && !item.rich);
  if (THEMED && darkFile) {
    const { page, frame, diagnose, iconRequests } = await openEditor(darkFile, 'dark', 'doc-dark');
    try {
      const attribute = await frame.evaluate(() => document.documentElement.getAttribute('data-theme'));
      assert(attribute === 'dark', `UITheme=dark did not set data-theme (${attribute})`);
      let pixel = await pagePixel(frame);
      const deadline = Date.now() + 15000;
      while (pixel !== 'rgb(255,255,255)' && Date.now() < deadline) {
        await page.waitForTimeout(500);
        pixel = await pagePixel(frame);
      }
      assert(pixel === 'rgb(255,255,255)', `page render under the dark chrome is ${pixel}, not white`);
      console.log(`doc-dark: data-theme=dark and the page pixel at the canvas center is ${pixel}.`);
      await verifyChrome(page, frame, 'dark', 'doc-dark', iconRequests);
      await page.getByRole('button', { name: 'Close editor', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('iframe[title="Document editor"]'));
      console.log('doc-dark: dark chrome verified and the editor closed.');
    } catch (error) {
      await diagnose(error);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
