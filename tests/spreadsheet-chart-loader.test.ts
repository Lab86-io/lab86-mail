import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { loadChartLibraries, SPREADSHEET_CHART_SCRIPTS } from '../lib/documents/odoo-spreadsheet-engine';

test('chart libraries share in-flight loads and recover from a failed dependency without duplicating loaded scripts', async () => {
  const dom = new JSDOM('', { url: 'https://spreadsheet.example.test' });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const requests: string[] = [];
  const head = dom.window.document.head;
  const append = head.appendChild.bind(head);
  let failGeographicRenderer = true;
  head.appendChild = ((node: HTMLScriptElement) => {
    const result = append(node);
    const filename = new URL(node.src).pathname.split('/').at(-1)!;
    requests.push(filename);
    queueMicrotask(() => {
      if (filename === 'chart-geo.umd.js' && failGeographicRenderer) {
        failGeographicRenderer = false;
        node.dispatchEvent(new dom.window.Event('error'));
      } else {
        node.dispatchEvent(new dom.window.Event('load'));
      }
    });
    return result;
  }) as typeof head.appendChild;
  try {
    const firstLoad = loadChartLibraries();
    expect(loadChartLibraries()).toBe(firstLoad);
    await expect(firstLoad).rejects.toThrow('Could not load chart library chart-geo.umd.js.');
    expect(requests).toEqual(['chart.umd.js', 'chart-geo.umd.js']);
    expect([...head.querySelectorAll('script')].map((node) => node.dataset.sheetChart)).toEqual([
      'chart.umd.js',
    ]);

    await loadChartLibraries();
    expect(requests).toEqual(['chart.umd.js', 'chart-geo.umd.js', ...SPREADSHEET_CHART_SCRIPTS.slice(1)]);
    expect([...head.querySelectorAll('script')].map((node) => node.dataset.sheetChart)).toEqual(
      SPREADSHEET_CHART_SCRIPTS,
    );
    const requestsAfterRecovery = [...requests];
    await loadChartLibraries();
    expect(requests).toEqual(requestsAfterRecovery);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    dom.window.close();
  }
});

test('engine loading retries failed styles and templates and reuses successfully loaded assets', async () => {
  const { mock } = await import('bun:test');
  const { loadSpreadsheetEngine, SPREADSHEET_STYLESHEETS } = await import(
    '../lib/documents/odoo-spreadsheet-engine'
  );
  const { ODOO_SPREADSHEET_ASSET_BASE, ODOO_OWL_ASSET_BASE, ODOO_SPREADSHEET_VERSION } = await import(
    '../lib/documents/sheet-workbook'
  );
  const addChild = mock(() => {});
  mock.module(`${ODOO_SPREADSHEET_ASSET_BASE}/dist/o_spreadsheet.esm.js`, () => ({
    __info__: { version: ODOO_SPREADSHEET_VERSION },
    registries: { topbarMenuRegistry: { addChild } },
  }));
  mock.module(`${ODOO_OWL_ASSET_BASE}/dist/owl.es.js`, () => ({}));
  const dom = new JSDOM('', { url: 'https://spreadsheet.example.test' });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  let templatesFail = true;
  globalThis.fetch = (async () =>
    new Response('<templates/>', { status: templatesFail ? 503 : 200 })) as unknown as typeof fetch;
  const head = dom.window.document.head;
  const append = head.appendChild.bind(head);
  let failStyle = true;
  const requests: string[] = [];
  head.appendChild = ((node: HTMLLinkElement) => {
    const result = append(node);
    requests.push(node.href);
    queueMicrotask(() => {
      if (failStyle) {
        failStyle = false;
        node.dispatchEvent(new dom.window.Event('error'));
      } else node.dispatchEvent(new dom.window.Event('load'));
    });
    return result;
  }) as typeof head.appendChild;
  try {
    const first = loadSpreadsheetEngine();
    expect(loadSpreadsheetEngine()).toBe(first);
    await expect(first).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(head.querySelectorAll('link[data-loaded="true"]')).toHaveLength(2);
    templatesFail = false;
    const loaded = await loadSpreadsheetEngine();
    expect(loaded.templates).toBe('<templates/>');
    expect(requests).toHaveLength(4);
    expect(head.querySelectorAll('link[data-loaded="true"]')).toHaveLength(SPREADSHEET_STYLESHEETS.length);
    expect(addChild).toHaveBeenCalledTimes(1);
    expect(await loadSpreadsheetEngine()).toBe(loaded);
    expect(requests).toHaveLength(4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    dom.window.close();
  }
});
