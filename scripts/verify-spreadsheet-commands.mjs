/** Real Odoo command/undo regression checks; synthetic in-memory workbook only. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const built = await Bun.build({
  entrypoints: ['scripts/fixtures/spreadsheet-command-checks.ts'],
  target: 'browser',
  format: 'iife',
});
if (!built.success) throw new Error(String(built.logs));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addScriptTag({ content: await built.outputs[0].text() });
  const results = await page.evaluate(() => globalThis.verifySpreadsheetCommands());
  for (const result of results) {
    if (result.scenario === 'success' || result.scenario === 'success-id') {
      assert.equal(result.outcome.applied, 1);
      assert.deepEqual(result.outcome.failed, []);
      assert.equal(result.after[0].cells.A1, 'AI proposal');
      assert.equal(
        result.after.length,
        result.before.length,
        'Editing an existing sheet never creates a duplicate',
      );
      assert.equal(
        result.after[0].id,
        result.before[0].id,
        'The existing stable sheet identity is preserved',
      );
      assert.deepEqual(result.afterUndo, result.before, 'Undo restores the human workbook');
    } else if (result.scenario === 'no-op-only') {
      assert.equal(result.outcome.applied, 0);
      assert.deepEqual(result.outcome.failed, []);
      assert.deepEqual(result.after, result.before, 'Already-satisfied changes are a harmless no-op');
    } else {
      assert.equal(result.outcome.applied, 0);
      assert.ok(result.outcome.failed.length > 0);
      assert.deepEqual(
        result.after,
        result.before,
        `${result.scenario}: rejected AI proposal changed human data`,
      );
    }
  }
  const migration = await page.evaluate(() => globalThis.verifySpreadsheetMigration());
  const expected = [
    '=SUM(B1)',
    '="unsafe"',
    '001',
    'TRUE',
    1234.5,
    0.125,
    46275,
    1234.5,
    null,
    '001',
    2469,
    false,
    0,
    '2026-09-10',
    '+123',
    '=path\\folder\nnext\\',
  ];
  for (const phase of ['initial', 'reopened', 'imported']) {
    assert.deepEqual(
      migration[phase].map((cell) => cell.value),
      expected,
      `${phase}: migration preserves exact literal types/values and formulas`,
    );
    assert.equal(migration[phase][4].display, '$1,234.50');
    assert.equal(migration[phase][5].display, '12.50%');
    assert.equal(migration[phase][6].format, 'yyyy-mm-dd');
    assert.equal(migration[phase][7].display, '1,234.50');
    assert.equal(migration[phase][8].format, '$#,##0.00', 'Format-only empty cells survive');
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { ok: true, engine: 'o-spreadsheet', scenarios: results.map((item) => item.scenario), migration },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
