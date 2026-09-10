/**
 * Synthetic spreadsheet acceptance against the REAL o-spreadsheet engine.
 * Run `bun scripts/preview-spreadsheet.mjs` first; never targets an account.
 * The fixture mocks only the authenticated storage transport (fetch); the
 * engine, its Excel reader/writer, formulas, and formatting are the real ones.
 *
 * Evidence: every step appends to <artifacts>/evidence.json as it completes,
 * and a failure leaves failure-<step>.png beside it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';

const artifacts =
  process.env.SPREADSHEET_UI_ARTIFACTS || (await mkdtemp(join(tmpdir(), 'albatross-spreadsheet-ui-')));
const base = 'http://127.0.0.1:18846';
const evidence = {
  startedAt: new Date().toISOString(),
  chromium: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'bundled',
  engine: null,
  steps: [],
  httpErrors: [],
  consoleErrors: [],
  pageErrors: [],
};
const saveEvidence = () => writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));

// A real workbook with a formula, a number format, bold, and two sheets.
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Forecast');
sheet.getCell('A1').value = 'Quarter';
sheet.getCell('B1').value = 'Revenue';
sheet.getCell('A2').value = 'Q1';
sheet.getCell('B2').value = 125000;
sheet.getCell('A3').value = 'Q2';
sheet.getCell('B3').value = 150500;
sheet.getCell('A4').value = 'Total';
sheet.getCell('B4').value = { formula: 'SUM(B2:B3)' };
sheet.getCell('B2').numFmt = '#,##0';
sheet.getCell('B3').numFmt = '#,##0';
sheet.getCell('B4').numFmt = '#,##0';
sheet.getCell('A1').font = { bold: true };
workbook.addWorksheet('Assumptions').getCell('A1').value = 'Growth 20%';
const xlsxPath = join(artifacts, 'forecast.xlsx');
const xlsxBytes = Buffer.from(await workbook.xlsx.writeBuffer());
await writeFile(xlsxPath, xlsxBytes);
const xlsxSha256 = createHash('sha256').update(xlsxBytes).digest('hex');

// A macro-enabled workbook renamed to .xlsx must be refused before the engine touches it.
const macroZip = new JSZip();
macroZip.file('[Content_Types].xml', '<Types/>');
macroZip.file('xl/workbook.xml', '<workbook/>');
macroZip.file('xl/vbaProject.bin', 'x');
const macroPath = join(artifacts, 'macro.xlsx');
await writeFile(macroPath, await macroZip.generateAsync({ type: 'nodebuffer' }));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
let page;
let currentStep = 'setup';
const step = async (name, run) => {
  currentStep = name;
  const started = Date.now();
  console.log(`▶ ${name}`);
  try {
    const details = (await run()) ?? {};
    evidence.steps.push({ name, ok: true, ms: Date.now() - started, ...details });
  } catch (error) {
    evidence.steps.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message || error),
    });
    await page
      ?.screenshot({ path: join(artifacts, `failure-${name.replace(/[^a-z0-9]+/giu, '-')}.png`) })
      .catch(() => {});
    await saveEvidence();
    throw error;
  }
  await saveEvidence();
};

try {
  page = await browser.newPage();
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      evidence.httpErrors.push({ status: response.status(), url: response.url() });
  });
  const open = async (scenario) => {
    await page.goto(`${base}/?scenario=${scenario}`);
    await page.locator('section[aria-label="Files"], section[aria-label$=" editor"]').waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => true));
  };
  const engine = () => page.locator('.albatross-sheet-frame .o-spreadsheet');
  const waitForEngine = async () => {
    await engine().waitFor({ timeout: 30_000 });
    await page.locator('.albatross-sheet-frame .o-grid').waitFor();
  };
  const bodies = (path) =>
    page.evaluate((needle) => globalThis.__sheet.bodies.filter((entry) => entry.url === needle), path);
  const selectCell = async (xc) => {
    // Select through the keyboard so the engine's own selection logic runs.
    await page.locator('.albatross-sheet-frame .o-grid').click({ position: { x: 100, y: 60 } });
    await page.keyboard.press('Control+Home');
    const { col, row } = xcToPosition(xc);
    for (let index = 0; index < col; index += 1) await page.keyboard.press('ArrowRight');
    for (let index = 0; index < row; index += 1) await page.keyboard.press('ArrowDown');
  };
  const typeCell = async (xc, text) => {
    await selectCell(xc);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  let exportNumber = 0;
  const exportWorkbook = async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Spreadsheet', exact: true }).click();
    const exported = await download;
    const bytes = await readFile(await exported.path());
    const zip = await JSZip.loadAsync(bytes);
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(bytes);
    await writeFile(join(artifacts, `export-${++exportNumber}.xlsx`), bytes);
    return { filename: exported.suggestedFilename(), bytes, zip, parsed };
  };

  await step('engine renders at three widths without page overflow', async () => {
    const widths = {};
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await open('grid');
      await waitForEngine();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
        `page overflow at ${width}`,
      );
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(artifacts, `sheet-${width}-light.png`) });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(artifacts, `sheet-${width}-dark.png`) });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      widths[width] = {
        sheetTabs: await page.locator('.albatross-sheet-frame .o-sheet-item.o-list-sheets').count(),
        topbar: await page.locator('.albatross-sheet-frame .o-spreadsheet-topbar').count(),
        composer: await page.locator('.albatross-sheet-frame .o-topbar-composer').count(),
      };
    }
    evidence.engine = await page.locator('.albatross-sheet-frame').getAttribute('data-spreadsheet-engine');
    assert.equal(evidence.engine, 'o-spreadsheet 19.0.50');
    return { widths };
  });

  await step('edit a formula: autosave carries the full engine snapshot', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open('grid');
    await waitForEngine();
    await typeCell('C2', '=B2*2');
    await page.getByText('Saved · revision 3', { exact: true }).waitFor({ timeout: 10_000 });
    const saves = await bodies('/api/documents/sheet-a');
    assert.equal(saves.length, 1, 'one autosave for one edit');
    assert.equal(saves[0].body.expectedRevision, 2);
    assert.equal(saves[0].body.model.version, 2, 'saved model is the full engine snapshot');
    assert.equal(saves[0].body.model.engine, 'o-spreadsheet');
    assert.equal(saves[0].body.model.engineVersion, '19.0.50');
    const plan = saves[0].body.model.workbook.sheets.find((s) => s.name === 'Plan');
    assert.equal(plan.cells.C2, '=B2*2', 'formula persisted as engine content');
    assert.equal(plan.cells.B4, '=SUM(B2:B3)', 'upgraded grid formula kept');
    assert.equal(saves[0].body.model.workbook.sheets.length, 2, 'both sheets kept');
    assert.ok(saves[0].body.model.workbook.revisionId, 'engine revision id present');
    return { savedBytes: JSON.stringify(saves[0].body.model).length };
  });

  await step('formulas are evaluated by the engine (exported values)', async () => {
    const { parsed } = await exportWorkbook();
    const c2 = parsed.getWorksheet('Plan').getCell('C2').value;
    const b4 = parsed.getWorksheet('Plan').getCell('B4').value;
    assert.equal(c2.formula, 'B2*2');
    assert.equal(c2.result, 2400);
    assert.equal(b4.formula, 'SUM(B2:B3)');
    assert.equal(b4.result, 4600);
    return { c2, b4 };
  });

  await step('formatting: bold from the keyboard is saved in the snapshot', async () => {
    await selectCell('B1');
    await page.keyboard.press('Control+b');
    await page.getByText('Saved · revision 4', { exact: true }).waitFor({ timeout: 10_000 });
    const saves = await bodies('/api/documents/sheet-a');
    const model = saves[saves.length - 1].body.model;
    const styles = JSON.stringify(model.workbook.styles || {});
    assert.ok(styles.includes('"bold":true'), `bold style stored: ${styles}`);
    const plan = model.workbook.sheets.find((s) => s.name === 'Plan');
    assert.ok(
      JSON.stringify(plan.styles || {}).includes('B1'),
      `B1 references a style: ${JSON.stringify(plan.styles)}`,
    );
    await page.screenshot({ path: join(artifacts, 'sheet-bold.png') });
    return { styles: model.workbook.styles, planStyles: plan.styles };
  });

  await step('reopen after navigating away restores the saved snapshot', async () => {
    await page.getByRole('button', { name: 'Back to Files', exact: true }).click();
    await page.locator('section[aria-label="Files"]').waitFor();
    await page.locator('button[title="Launch budget"]').click();
    await waitForEngine();
    await page.getByText('Saved · revision 4', { exact: true }).waitFor();
    const reopened = await page.evaluate(() => globalThis.__sheet.documents.get('sheet-a').model);
    assert.equal(reopened.version, 2);
    assert.equal(reopened.workbook.sheets[0].cells.C2, '=B2*2');
    const { parsed } = await exportWorkbook();
    assert.equal(
      parsed.getWorksheet('Plan').getCell('C2').result,
      2400,
      'reopened engine evaluates the saved formula',
    );
    await page.screenshot({ path: join(artifacts, 'sheet-reopened.png') });
  });

  await step('identity switch while dirty never saves A into B', async () => {
    await open('grid');
    await waitForEngine();
    await typeCell('D1', 'Only for A');
    await page.evaluate(() => {
      history.pushState(null, '', '?scenario=grid&view=files&document=sheet-b');
      window.dispatchEvent(new Event('lab86-mail:files-navigate'));
    });
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="File name"]')?.value === 'Second workbook',
    );
    await page.waitForFunction(() =>
      globalThis.__sheet.bodies.some((entry) => entry.url === '/api/documents/sheet-a'),
    );
    await page.waitForTimeout(1500);
    const aSaves = await bodies('/api/documents/sheet-a');
    const bSaves = await bodies('/api/documents/sheet-b');
    assert.equal(bSaves.length, 0, 'nothing was saved to B');
    assert.ok(aSaves.length >= 1, 'A was flushed');
    const last = aSaves[aSaves.length - 1].body;
    assert.equal(last.model.workbook.sheets[0].cells.D1, 'Only for A', 'A received its own edit');
    assert.equal(last.title, 'Launch budget');
    const stored = await page.evaluate(() => ({
      a: globalThis.__sheet.documents.get('sheet-a').model,
      b: globalThis.__sheet.documents.get('sheet-b').model,
    }));
    assert.equal(stored.a.workbook.sheets[0].cells.D1, 'Only for A');
    assert.equal(stored.b.version, 1, 'B untouched');
    assert.equal(await engine().count(), 1, 'exactly one live editor after the switch');
    return { aSaves: aSaves.length, bSaves: bSaves.length };
  });

  await step('flush failure on switch: returning recovers the retained edits', async () => {
    await open('flush-fail');
    await waitForEngine();
    await typeCell('E1', 'Recover me');
    await page.waitForTimeout(1200); // let the failing autosave run and stop
    await page.evaluate(() => {
      history.pushState(null, '', '?scenario=flush-fail&view=files&document=sheet-b');
      window.dispatchEvent(new Event('lab86-mail:files-navigate'));
    });
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="File name"]')?.value === 'Second workbook',
    );
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      history.pushState(null, '', '?scenario=flush-fail&view=files&document=sheet-a');
      window.dispatchEvent(new Event('lab86-mail:files-navigate'));
    });
    await page.getByText('Recovered unsaved edits', { exact: true }).waitFor({ timeout: 10_000 });
    await waitForEngine();
    await page.screenshot({ path: join(artifacts, 'sheet-recovered.png') });
    const recoveredModel = await page.evaluate(() => globalThis.__sheet.documents.get('sheet-a').model);
    assert.equal(recoveredModel.version, 1, 'server never received the failed save');
  });

  await step(
    'conflict: one failing save, no retries, draft downloadable, saved version reloads',
    async () => {
      await open('conflict');
      await waitForEngine();
      await typeCell('A8', 'Local only');
      await page.getByRole('alert').waitFor();
      await typeCell('A9', 'Still local');
      await page.waitForTimeout(1800);
      assert.equal((await bodies('/api/documents/sheet-a')).length, 1, 'conflict stops automatic retries');
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download my draft' }).click();
      const recovery = await downloadPromise;
      assert.equal(recovery.suggestedFilename(), 'albatross-recovered-draft.json');
      const draft = JSON.parse(await readFile(await recovery.path(), 'utf8'));
      assert.equal(draft.model.version, 2, 'draft is the full engine snapshot');
      assert.equal(draft.model.workbook.sheets[0].cells.A8, 'Local only');
      assert.equal(draft.model.workbook.sheets[0].cells.A9, 'Still local');
      await page.screenshot({ path: join(artifacts, 'sheet-conflict.png') });
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Load saved version' }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role="alert"]').length === 0);
      await waitForEngine();
      assert.equal(await engine().count(), 1, 'reload replaced the editor instead of stacking one');
    },
  );

  await step('macro-enabled archive is refused before the engine reads it', async () => {
    await open('import');
    await page.getByRole('button', { name: 'New' }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('menuitem', { name: 'Import Excel workbook' }).click(),
    ]);
    await chooser.setFiles(macroPath);
    await page
      .getByText(/macro|not supported|unsafe/iu)
      .first()
      .waitFor({ timeout: 10_000 });
    const imported = await page.evaluate(() => globalThis.__sheet.imported);
    assert.equal(imported, null, 'nothing reached the import endpoint');
    await page.screenshot({ path: join(artifacts, 'sheet-import-refused.png') });
  });

  await step('Excel import through the engine keeps original bytes and a v2 snapshot', async () => {
    await open('import');
    await page.getByRole('button', { name: 'New' }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('menuitem', { name: 'Import Excel workbook' }).click(),
    ]);
    await chooser.setFiles(xlsxPath);
    await waitForEngine();
    const imported = await page.evaluate(() => globalThis.__sheet.imported);
    assert.equal(imported.name, 'forecast.xlsx');
    assert.equal(imported.modelVersion, 2);
    assert.ok(imported.size > 1000, 'original bytes were sent');
    assert.equal(imported.size, xlsxBytes.length, 'original byte length preserved');
    assert.equal(imported.sha256, xlsxSha256, 'uploaded bytes are the untouched original');
    const importedModel = await page.evaluate(() => globalThis.__sheet.documents.get('imported').model);
    const forecast = importedModel.workbook.sheets.find((s) => s.name === 'Forecast');
    assert.equal(forecast.cells.B4, '=SUM(B2:B3)', 'formula read from Excel');
    assert.equal(forecast.cells.B2, '125000');
    assert.equal(importedModel.workbook.sheets.length, 2, 'both Excel sheets imported');
    assert.ok(
      importedModel.workbook.formats?.[forecast.formats?.B2],
      'B2 retains its imported number format',
    );
    assert.ok(JSON.stringify(importedModel.workbook.styles || {}).includes('"bold":true'), 'bold imported');
    await page.getByText('Imported from forecast.xlsx').waitFor();
    await page.getByRole('link', { name: 'Download original' }).waitFor();
    await page.screenshot({ path: join(artifacts, 'sheet-imported.png') });
    return { imported, warnings: imported.warnings };
  });

  await step('Excel export from the live engine is a real workbook with formulas and formats', async () => {
    const { filename, bytes, zip, parsed } = await exportWorkbook();
    assert.equal(filename, 'forecast.xlsx');
    assert.ok(zip.file('xl/workbook.xml'), 'workbook part present');
    const workbookXml = await zip.file('xl/workbook.xml').async('text');
    assert.ok(workbookXml.includes('Forecast') && workbookXml.includes('Assumptions'));
    assert.equal(parsed.getWorksheet('Forecast').getCell('B4').formula, 'SUM(B2:B3)');
    assert.equal(
      parsed.getWorksheet('Forecast').getCell('B4').result,
      275500,
      'imported formula evaluated by the engine',
    );
    const styles = await zip.file('xl/styles.xml').async('text');
    assert.equal(
      parsed.getWorksheet('Forecast').getCell('B2').numFmt,
      '#,##0',
      'number format survives export',
    );
    assert.ok(/<b\s*\/>|<b>/u.test(styles), 'bold survives export');
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(bytes);
    assert.equal(roundTrip.getWorksheet('Forecast').getCell('B4').formula, 'SUM(B2:B3)');
    assert.equal(roundTrip.getWorksheet('Forecast').getCell('B2').numFmt, '#,##0');
    await writeFile(join(artifacts, 'exported-forecast.xlsx'), bytes);
    return { bytes: bytes.length, parts: Object.keys(zip.files).length };
  });

  await step('import notes are visible and the original download is offered', async () => {
    await open('imported');
    await waitForEngine();
    await page.getByRole('button', { name: '1 import note' }).click();
    await page.getByRole('region', { name: 'Import notes' }).waitFor();
    await page.getByRole('link', { name: 'Download original' }).waitFor();
    await page.screenshot({ path: join(artifacts, 'sheet-import-notes.png') });
  });

  await step('AI change set applies through engine commands bound to the base revision', async () => {
    await open('suggest');
    await waitForEngine();
    const assistant = page.getByRole('complementary', { name: 'Document assistant' });
    await assistant.getByText('Plan!B6').waitFor();
    await assistant.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(() => typeof globalThis.__sheet.releaseSuggestion === 'function');
    assert.equal(
      await page.getByRole('textbox', { name: 'File name' }).isDisabled(),
      true,
      'apply locks editing',
    );
    await page.evaluate(() => globalThis.__sheet.releaseSuggestion());
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="File name"]')?.value === 'Add a contingency line',
    );
    const applied = (await bodies('/api/documents/sheet-a/suggestions/fill-total'))[0].body;
    assert.equal(applied.expectedRevision, 2);
    assert.equal(applied.model.version, 2);
    assert.equal(applied.model.workbook.sheets[0].cells.B6, '=B4+B5');
    assert.equal(applied.model.workbook.sheets[0].cells.A5, 'Contingency');
    await page.getByText('Saved · revision 3', { exact: true }).waitFor();
    const { parsed } = await exportWorkbook();
    assert.equal(parsed.getWorksheet('Plan').getCell('B6').formula, 'B4+B5');
    assert.equal(parsed.getWorksheet('Plan').getCell('B6').result, 5060, 'applied formulas evaluate');
    await page.screenshot({ path: join(artifacts, 'sheet-ai-applied.png') });
  });

  await step('narrow web editor supports keyboard cell editing and autosave', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open('grid');
    await waitForEngine();
    await typeCell('C2', '=B2*3');
    await page.getByText('Saved · revision 3', { exact: true }).waitFor({ timeout: 10_000 });
    const saved = await page.evaluate(() => globalThis.__sheet.documents.get('sheet-a').model);
    assert.equal(saved.version, 2);
    assert.equal(saved.workbook.sheets.find((sheet) => sheet.name === 'Plan').cells.C2, '=B2*3');
    await page.screenshot({ path: join(artifacts, 'sheet-390-edited.png') });
  });

  await step('no page errors', async () => {
    assert.deepEqual(evidence.pageErrors, [], `page errors: ${evidence.pageErrors.join('\n')}`);
    return { httpErrors: evidence.httpErrors.length, consoleErrors: evidence.consoleErrors.length };
  });

  evidence.finishedAt = new Date().toISOString();
  evidence.result = 'passed';
  await saveEvidence();
  console.log(`Spreadsheet UI acceptance passed. Artifacts: ${artifacts}`);
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  evidence.result = `failed at ${currentStep}`;
  await saveEvidence();
  console.error(`Spreadsheet UI acceptance failed at "${currentStep}". Artifacts: ${artifacts}`);
  throw error;
} finally {
  await browser.close();
}

function xcToPosition(xc) {
  const match = /^([A-Z]+)(\d+)$/u.exec(xc);
  let col = 0;
  for (const character of match[1]) col = col * 26 + character.charCodeAt(0) - 64;
  return { col: col - 1, row: Number(match[2]) - 1 };
}
