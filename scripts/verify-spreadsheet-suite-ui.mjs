/** Browser acceptance for a real workbook authored by the server Odoo engine. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:18846/?scenario=suite&view=files&document=sheet-a');
  await page.locator('.o-grid').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => Object.values(window.Chart?.instances || {}).length > 0);
  for (const label of ['File', 'Edit', 'View', 'Insert', 'Format', 'Data'])
    assert.ok(await page.locator('.o-spreadsheet').getByText(label, { exact: true }).isVisible(), label);
  const charts = await page.evaluate(() =>
    Object.values(window.Chart.instances).map((chart) => ({
      type: chart.config.type,
      labels: chart.data.labels,
      values: chart.data.datasets[0].data,
    })),
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      geo: Boolean(window.Chart.registry.getController('choropleth')),
      treemap: Boolean(window.Chart.registry.getController('treemap')),
      date: new window.Chart._adapters._date({}).formats().datetime !== undefined,
    })),
    { geo: true, treemap: true, date: true },
  );
  assert.equal(charts[0].type, 'bar');
  assert.deepEqual(charts[0].values, [1, 13, 7, 4]);
  const chartTypes = await page.evaluate(async () => {
    const engine = await import('/vendor/o-spreadsheet/19.0.50/dist/o_spreadsheet.esm.js');
    const types = [
      'bar',
      'line',
      'pie',
      'combo',
      'scatter',
      'waterfall',
      'pyramid',
      'radar',
      'geo',
      'funnel',
      'sunburst',
      'treemap',
      'gauge',
      'scorecard',
    ];
    for (const type of types) {
      const model = new engine.Model(globalThis.__sheet.documents.get('sheet-a').model.workbook);
      let chart;
      try {
        const definition = engine.registries.chartRegistry.get(type).getChartDefinitionFromContextCreation({
          range: [{ dataRange: 'B1:B5' }],
          hierarchicalRanges: [{ dataRange: 'A1:A5' }],
          auxiliaryRange: 'A1:A5',
          dataSetsHaveTitle: true,
          title: { text: type },
        });
        const result = model.dispatch('CREATE_CHART', {
          sheetId: model.getters.getActiveSheetId(),
          chartId: type,
          figureId: type,
          col: 0,
          row: 6,
          offset: { x: 0, y: 0 },
          size: { width: 480, height: 300 },
          definition,
        });
        if (!result.isSuccessful) throw new Error(`${type}: ${result.reasons.join(', ')}`);
        const runtime = model.getters.getChartRuntime(type);
        if (runtime.chartJsConfig)
          chart = new window.Chart(document.createElement('canvas').getContext('2d'), runtime.chartJsConfig);
      } finally {
        chart?.destroy();
        await model.leaveSession();
      }
    }
    return types;
  });
  const status = page.getByRole('button', { name: 'Saved · revision 2', exact: true });
  await status.hover();
  await page.getByRole('tooltip').filter({ hasText: 'Saved · revision 2' }).waitFor();
  const titleBox = await page.getByRole('textbox', { name: 'File name' }).boundingBox();
  const statusBox = await status.boundingBox();
  assert.ok(Math.abs(titleBox.y - statusBox.y) < 8);
  assert.ok(statusBox.x - (titleBox.x + titleBox.width) < 12);
  const text = await page.locator('body').innerText();
  for (const removed of [
    'This sheet opens in Odoo',
    'Private working copy',
    'Engine: o-spreadsheet',
    'Odoo · source and licenses',
    'Google publishing is unavailable',
  ])
    assert.ok(!text.includes(removed));
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await page.getByRole('complementary', { name: 'Version history' }).waitFor();
  await page.getByRole('button', { name: 'Close version history' }).click();
  for (const width of [1000, 798, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.waitForTimeout(250);
    assert.ok(await page.locator('.o-spreadsheet').getByText('Insert', { exact: true }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `/tmp/albatross-spreadsheet-suite-${width}.png` });
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Spreadsheet', exact: true }).click();
  const archive = await JSZip.loadAsync(await readFile(await (await download).path()));
  const chartFile = Object.keys(archive.files).find((path) => /^xl\/charts\/chart\d+\.xml$/.test(path));
  assert.ok(chartFile, 'The Excel download contains the real chart');
  const chartXml = await archive.file(chartFile).async('string');
  assert.match(chartXml, /barChart/);
  assert.match(chartXml, /Monthly commits/);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      charts,
      chartTypes,
      widths: [1000, 798, 390],
      screenshots: '/tmp/albatross-spreadsheet-suite-*.png',
    }),
  );
} finally {
  await browser.close();
}
