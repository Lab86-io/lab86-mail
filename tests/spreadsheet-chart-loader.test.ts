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
