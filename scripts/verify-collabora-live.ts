import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { getOfficeFile } from '../lib/documents/office-service';

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
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const file of fixture.files.filter(
    (item: any) => !process.env.OFFICE_VERIFY_KIND || item.kind === process.env.OFFICE_VERIFY_KIND,
  )) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.route(`${appOrigin}/__office-verification`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}.hidden{display:none}iframe{height:100%;width:100%;border:0}</style></head><body><div id="root"></div><script>window.__session=${JSON.stringify(file.session)}</script><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`,
      }),
    );
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
    try {
      await page.waitForFunction(
        () => ['Ready', 'Modified'].includes(document.getElementById('state')?.textContent || ''),
        undefined,
        { timeout: 90000 },
      );
      console.log(`${file.kind}: real embedded editor loaded.`);
      const frame = page.frames().find((frame) => frame.url().startsWith(file.session.serverUrl))!;
      writeFileSync(`/tmp/chat-doc-${file.kind}-editor-dom.txt`, await frame.locator('body').innerText());
      await page.screenshot({ path: `/tmp/chat-doc-${file.kind}-open.png` });
      const welcome = frame.frameLocator('iframe[title="Welcome Dialog"]');
      await welcome.locator('#welcome-close').waitFor({ state: 'attached', timeout: 10000 });
      await welcome.locator('#welcome-close').evaluate((element: HTMLElement) => element.click());
      await frame.locator('.iframe-welcome-wrap').waitFor({ state: 'hidden', timeout: 10000 });
      const marker = `ALBATROSS-LIVE-${Date.now()}`;
      if (file.kind === 'doc') {
        await frame.locator('#clipboard-area').click({ force: true });
        await page.keyboard.press('Control+Home');
        await page.keyboard.type(marker);
      } else if (file.kind === 'sheet') {
        await frame.locator('#clipboard-area').click({ force: true });
        await page.keyboard.type(marker);
        await page.keyboard.press('Enter');
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
      const zip = await JSZip.loadAsync(await (await fetch(record.version.url)).arrayBuffer());
      const text = (
        await Promise.all(
          Object.values(zip.files)
            .filter((f) => f.name.endsWith('.xml'))
            .map((f) => f.async('string')),
        )
      ).join('\n');
      if (file.kind !== 'deck' && !text.replace(/<[^>]+>/g, '').includes(marker))
        throw new Error('Saved file did not contain the typed marker');
      if (
        file.kind === 'deck' &&
        Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+.xml$/.test(name)).length < 2
      )
        throw new Error('New slide missing from saved presentation');
      console.log(
        `${file.kind}: edited in browser, saved through WOPI, verified revision ${record.currentRevision} from storage.`,
      );
      await page.screenshot({ path: `/tmp/chat-doc-${file.kind}-saved.png` });
    } catch (error) {
      console.log('Editor state:', await page.locator('#state').textContent());
      console.log('Browser errors:', failures);
      for (const frame of page.frames())
        if (frame.url().startsWith(file.session.serverUrl))
          writeFileSync(`/tmp/chat-doc-${file.kind}-editor-dom.txt`, await frame.locator('body').innerText());
      await page.screenshot({ path: `/tmp/chat-doc-${file.kind}-failed.png` });
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
