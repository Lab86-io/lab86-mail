import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { DECK_THEMES } from '../lib/documents/deck-fixtures';
import { exportDocument } from '../lib/documents/export';
import type {
  AlbatrossDocumentModel,
  AlbatrossDocumentRecord,
  DeckModelV2,
  DeckSlideV2,
} from '../lib/documents/model';

/** A real file under `public`, so the asset loader reads it from disk. */
const ART = '/art/fallback-1.jpg';

function record(model: AlbatrossDocumentModel): AlbatrossDocumentRecord {
  return {
    documentId: 'export',
    kind: model.kind,
    title: 'Export',
    model,
    currentRevision: 1,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function deck(slides: DeckSlideV2[]): DeckModelV2 {
  return { kind: 'deck', version: 2, activeSlideId: slides[0].id, theme: DECK_THEMES.editorial, slides };
}

async function slideXml(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
  const charts = names.filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const chartXml = (await Promise.all(charts.map((name) => zip.file(name)!.async('string')))).join('');
  return {
    names,
    charts,
    chartXml,
    slide: (index: number) => zip.file(slides[index])!.async('string'),
  };
}

describe('version 2 deck export', () => {
  test('a slide background image, images, styled text, shapes, lines and charts stay native', async () => {
    const model = deck([
      {
        id: 'one',
        title: 'Art',
        notes: 'Speaker notes',
        backgroundImage: { assetId: 'bg', src: ART, opacity: 0.4 },
        elements: [
          {
            id: 'number',
            type: 'text',
            role: 'number',
            text: '42',
            x: 6,
            y: 8,
            width: 30,
            height: 20,
            fill: '#FFFFFF',
            letterSpacing: 0.05,
            italic: true,
            opacity: 0.8,
          },
          {
            id: 'subtitle',
            type: 'text',
            role: 'subtitle',
            text: 'Subtitle',
            x: 40,
            y: 8,
            width: 30,
            height: 10,
            align: 'center',
            valign: 'top',
          },
          {
            id: 'caption',
            type: 'text',
            role: 'caption',
            text: 'Caption',
            x: 40,
            y: 20,
            width: 30,
            height: 6,
            lineHeight: 1.2,
          },
          { id: 'kicker', type: 'text', role: 'kicker', text: 'Kicker', x: 72, y: 8, width: 20, height: 6 },
          { id: 'body', type: 'text', role: 'body', text: 'Body', x: 72, y: 16, width: 20, height: 10 },
          {
            id: 'round',
            type: 'shape',
            shape: 'roundRect',
            radius: 12,
            x: 6,
            y: 32,
            width: 20,
            height: 14,
            fill: '#E7E1D3',
            stroke: { color: '#AE4B2B', width: 1, dash: 'dash' },
          },
          {
            id: 'ellipse',
            type: 'shape',
            shape: 'ellipse',
            x: 30,
            y: 32,
            width: 14,
            height: 14,
            opacity: 0.5,
          },
          {
            id: 'rect',
            type: 'shape',
            x: 48,
            y: 32,
            width: 20,
            height: 14,
            stroke: { color: '#1E2A38', width: 0.75, dash: 'dot' },
          },
          {
            id: 'rule',
            type: 'line',
            x: 6,
            y: 50,
            width: 60,
            height: 4,
            flip: true,
            stroke: { color: '#1E2A38', width: 1.5, dash: 'dash' },
          },
          {
            id: 'photo',
            type: 'image',
            assetId: 'hills',
            src: ART,
            alt: 'Hills',
            fit: 'contain',
            opacity: 0.9,
            rotation: 5,
            x: 70,
            y: 32,
            width: 24,
            height: 24,
          },
          {
            id: 'pie',
            type: 'chart',
            chart: 'pie',
            x: 6,
            y: 58,
            width: 40,
            height: 36,
            categories: ['North', 'South'],
            series: [{ name: 'Share', values: [60, 40] }],
            unit: '%',
            values: true,
            legend: true,
          },
          {
            id: 'doughnut',
            type: 'chart',
            chart: 'doughnut',
            x: 52,
            y: 58,
            width: 40,
            height: 36,
            categories: ['A', 'B', 'C'],
            series: [{ name: 'Mix', values: [1, 2, 3] }],
            colors: ['#AE4B2B', '#1E2A38', '#5E5A51'],
          },
        ],
      },
      {
        id: 'two',
        title: 'Plain',
        background: '#111111',
        elements: [{ id: 'empty', type: 'text', text: '', x: 10, y: 10, width: 50, height: 10 }],
      },
    ]);
    const exported = await exportDocument(record(model));
    expect(exported.extension).toBe('pptx');
    expect(exported.fidelity).toBe('full');
    const pptx = await slideXml(exported.bytes);
    expect(pptx.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
    expect(pptx.names.some((name) => name.startsWith('ppt/media/'))).toBe(true);
    expect(pptx.charts.length).toBeGreaterThanOrEqual(2);
    expect(pptx.chartXml).toContain('<c:pieChart>');
    expect(pptx.chartXml).toContain('<c:doughnutChart>');

    const first = await pptx.slide(0);
    // The background picture and the image element are both pictures.
    expect(first.split('<p:pic>').length - 1).toBeGreaterThanOrEqual(2);
    expect(first).toContain('descr="Hills"');
    expect(first).toContain('prstGeom prst="roundRect"');
    expect(first).toContain('prstGeom prst="ellipse"');
    expect(first).toContain('prstGeom prst="line"');
    expect(first).toContain('prstDash val="dash"');
    expect(first).toContain('prstDash val="sysDot"');
    expect(first).toContain('flipV="1"');
    // Role sizes: number 64, subtitle 20, caption and kicker 12, body 16.
    expect(first).toContain('sz="6400"');
    expect(first).toContain('sz="2000"');
    expect(first).toContain('sz="1200"');
    expect(first).toContain('sz="1600"');
    // Letter spacing is 0.05 em of 64 pt, written in hundredths of a point.
    expect(first).toContain('spc="320"');
    expect(first).toContain(' i="1"');
    expect(first).toContain('algn="ctr"');
    expect(first).toContain('anchor="t"');

    const second = await pptx.slide(1);
    expect(second).toContain('<a:srgbClr val="111111"');
  }, 30_000);

  test('an image without an owned source is refused', async () => {
    const model = deck([
      {
        id: 'one',
        title: 'Missing',
        elements: [
          {
            id: 'ghost',
            type: 'image',
            assetId: 'orphan',
            alt: 'Orphan',
            x: 10,
            y: 10,
            width: 40,
            height: 40,
          },
        ],
      },
    ]);
    await expect(exportDocument(record(model))).rejects.toThrow('Image "Orphan" has no owned source');
  });
});

describe('document and spreadsheet export', () => {
  test('every block type maps to its Word style, including third-level headings', async () => {
    const exported = await exportDocument(
      record({
        kind: 'doc',
        version: 1,
        blocks: [
          { id: 'h1', type: 'heading', level: 1, text: 'One' },
          { id: 'h2', type: 'heading', level: 2, text: 'Two' },
          { id: 'h3', type: 'heading', level: 3, text: 'Three' },
          { id: 'p', type: 'paragraph', text: 'Plain\nbreak', runs: [{ text: 'Plain\nbreak', bold: true }] },
          { id: 'stale', type: 'paragraph', text: 'Canonical', runs: [{ text: 'Old', italic: true }] },
          { id: 'b', type: 'bullet', text: 'Point' },
          { id: 'n1', type: 'numbered', text: 'First' },
          { id: 'n2', type: 'numbered', text: 'Second' },
          { id: 'q', type: 'quote', text: 'Said', runs: [{ text: 'Said', underline: true, code: true }] },
          { id: 'n3', type: 'numbered', text: 'Restart' },
        ],
      } as AlbatrossDocumentModel),
    );
    expect(exported.extension).toBe('docx');
    const zip = await JSZip.loadAsync(exported.bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('w:val="Heading3"');
    expect(xml).toContain('Canonical');
    expect(xml).not.toContain('>Old<');
    expect(xml).toContain('w:left="500"');
    expect(xml).toContain('Consolas');
  });

  test('sheet cells keep formats and formulas, and duplicate tab names get a suffix', async () => {
    const exported = await exportDocument(
      record({
        kind: 'sheet',
        version: 1,
        activeSheetId: 'one',
        sheets: [
          {
            id: 'one',
            name: 'Budget',
            rowCount: 5,
            columnCount: 3,
            cells: {
              A1: { value: 'Total' },
              B1: { value: 12, format: 'currency' },
              C1: { value: 0.5, format: 'percent' },
              A2: { value: '2026-01-01', format: 'date' },
              B2: { formula: '=B1*2' },
              Z9: { value: 'outside' },
              bad: { value: 'skipped' },
            },
          },
          { id: 'two', name: 'Budget', rowCount: 2, columnCount: 2, cells: {} },
        ],
      }),
    );
    expect(exported.extension).toBe('xlsx');
    expect(exported.fidelity).toBe('full');
    const zip = await JSZip.loadAsync(exported.bytes);
    const workbook = await zip.file('xl/workbook.xml')!.async('string');
    expect(workbook).toContain('name="Budget"');
    expect(workbook).toContain('name="Budget (2)"');
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<f>B1*2</f>');
    expect(sheet).not.toContain('outside');
    expect(sheet).not.toContain('skipped');
  });
});
