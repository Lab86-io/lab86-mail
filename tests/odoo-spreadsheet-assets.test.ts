import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SPREADSHEET_CHART_SCRIPTS } from '../lib/documents/odoo-spreadsheet-engine';
import {
  ODOO_OWL_VERSION,
  ODOO_SPREADSHEET_ASSET_BASE,
  ODOO_SPREADSHEET_VERSION,
} from '../lib/documents/sheet-workbook';

test('all chart renderers and the date adapter are pinned and distributed with licenses', async () => {
  const base = 'public/vendor/spreadsheet-charts';
  const manifest = JSON.parse(await readFile(`${base}/manifest.json`, 'utf8'));
  expect(manifest.versions).toEqual({
    'chart.js': '4.4.5',
    'chartjs-chart-geo': '4.3.6',
    luxon: '3.5.0',
    'chartjs-adapter-luxon': '1.3.1',
  });
  for (const name of SPREADSHEET_CHART_SCRIPTS) expect(manifest.files[name]).toBeTruthy();
  for (const [path, hash] of Object.entries(manifest.files))
    expect(
      createHash('sha256')
        .update(await readFile(`${base}/${path}`))
        .digest('hex'),
    ).toBe(hash);
});

test('vendored runtime and corresponding source match the pinned manifest and installed package', async () => {
  const base = `public${ODOO_SPREADSHEET_ASSET_BASE}`;
  const manifest = JSON.parse(await readFile(`${base}/manifest.json`, 'utf8'));
  const pkg = JSON.parse(await readFile('node_modules/@odoo/o-spreadsheet/package.json', 'utf8'));
  expect(manifest.version).toBe(ODOO_SPREADSHEET_VERSION);
  expect(pkg.version).toBe(ODOO_SPREADSHEET_VERSION);
  expect(manifest.owlVersion).toBe(ODOO_OWL_VERSION);
  for (const [path, digest] of Object.entries(manifest.files)) {
    expect(
      createHash('sha256')
        .update(await readFile(`${base}/${path}`))
        .digest('hex'),
    ).toBe(digest);
  }
  const runtime = await readFile(`${base}/dist/o_spreadsheet.esm.js`, 'utf8');
  expect(runtime).toContain(`from "/vendor/owl/${ODOO_OWL_VERSION}/dist/owl.es.js"`);
  expect(runtime).not.toContain('from "@odoo/owl"');
  const original = await readFile('node_modules/@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js', 'utf8');
  expect(runtime).toBe(
    original.replace('from "@odoo/owl"', `from "/vendor/owl/${ODOO_OWL_VERSION}/dist/owl.es.js"`),
  );
  expect(await readFile(`public/vendor/owl/${ODOO_OWL_VERSION}/dist/owl.es.js`, 'utf8')).toBe(
    await readFile('node_modules/@odoo/owl/dist/owl.es.js', 'utf8'),
  );
  expect(
    createHash('sha256')
      .update(await readFile(`public/vendor/owl/${ODOO_OWL_VERSION}/source.tar.gz`))
      .digest('hex'),
  ).toBe(manifest.sources.owl.sha256);
  expect(manifest.sources.spreadsheet.commit).toBe('e4992587245f832c0dbf361b1f23f14b74613d4e');
  expect(manifest.sources.owl.commit).toBe('54129a5f8dfc1ce16c62ee2f216058c043043a6e');
});

test('library source and third-party license notices are distributed beside replaceable ESM', async () => {
  const base = `public${ODOO_SPREADSHEET_ASSET_BASE}`;
  const source = await readFile(`${base}/source.tar.gz`);
  const owl = await readFile(`public/vendor/owl/${ODOO_OWL_VERSION}/source.tar.gz`);
  expect(source[0]).toBe(0x1f);
  expect(source[1]).toBe(0x8b);
  expect(owl[0]).toBe(0x1f);
  expect(owl[1]).toBe(0x8b);
  expect(await readFile(`${base}/NOTICE.md`, 'utf8')).toContain('no Albatross source or app rebuild');
  expect(await readFile(`${base}/BOOTSTRAP-LICENSE`, 'utf8')).toContain('Permission is hereby granted');
  const font = await readFile('public/vendor/font-awesome-4.7.0/LICENSES.txt', 'utf8');
  expect(font).toContain('Copyright Dave Gandy 2016');
  expect(font).toContain('SIL OPEN FONT LICENSE Version 1.1');
  expect(font).toContain('MIT License');
  const loader = await readFile('lib/documents/odoo-spreadsheet-engine.ts', 'utf8');
  expect(loader).toContain('webpackIgnore: true');
  expect(loader).not.toContain("        import('@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js')");
});
