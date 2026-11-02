import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlideSurface } from '../components/files/editors/SlideRenderer';
import { DECK_THEMES } from '../lib/documents/deck-fixtures';
import { chartInks, checkDeck, checkSlide, contrastRatio } from '../lib/documents/deck-quality';
import { exportDocument } from '../lib/documents/export';
import type {
  AlbatrossDocumentRecord,
  DeckElementV2,
  DeckModelV2,
  DeckSlideV2,
} from '../lib/documents/model';

const theme = DECK_THEMES.editorial;
const { ink, background, muted, accent } = theme.colors;

type Chart = Extract<DeckElementV2, { type: 'chart' }>;

function chart(overrides: Partial<Chart> = {}): Chart {
  return {
    id: 'chart',
    type: 'chart',
    chart: 'line',
    x: 40,
    y: 20,
    width: 50,
    height: 60,
    categories: ['Q1', 'Q2'],
    series: [
      { name: '2025', values: [41, 47] },
      { name: '2026', values: [52, 58] },
    ],
    colors: [accent, ink],
    legend: true,
    values: true,
    ...overrides,
  };
}

function slide(overrides: Partial<DeckSlideV2> = {}, element: Chart = chart()): DeckSlideV2 {
  return { id: 's', title: 'Sales', notes: '', elements: [element], ...overrides };
}

function deck(one: DeckSlideV2): DeckModelV2 {
  return { kind: 'deck', version: 2, activeSlideId: one.id, theme, slides: [one] };
}

function record(model: DeckModelV2): AlbatrossDocumentRecord {
  return {
    documentId: 'charts',
    kind: 'deck',
    title: 'Charts',
    model,
    currentRevision: 1,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function chartXml(model: DeckModelV2) {
  const { bytes } = await exportDocument(record(model));
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  return (await Promise.all(names.map((name) => zip.file(name)!.async('string')))).join('');
}

describe('chart colors by contrast', () => {
  test('on a dark slide in a light palette, each color reads and two series stay different', () => {
    const one = slide({ background: ink });
    const inks = chartInks(one, theme, one.elements[0] as Chart);
    expect(inks.ground).toBe(ink);
    expect(inks.label).toBe(background);
    expect(inks.quiet).toBe(background);
    expect(inks.grid).not.toBe(background);
    expect(contrastRatio(inks.grid, ink)!).toBeLessThan(3);
    expect(inks.ok).toBe(true);
    expect(inks.series[1]).not.toBe(ink);
    expect(inks.series[0]).not.toBe(inks.series[1]);
    for (const color of inks.series) expect(contrastRatio(color, ink)!).toBeGreaterThanOrEqual(3);
    expect(checkSlide(one, theme)).toEqual([]);
  });

  test('on the normal light ground, nothing changes', () => {
    const one = slide();
    expect(chartInks(one, theme, one.elements[0] as Chart)).toEqual({
      ground: background,
      label: ink,
      quiet: muted,
      grid: muted,
      series: [accent, ink],
      ok: true,
    });
  });

  test('a chart with no palette of its own gets the theme palette by the same rule', () => {
    const element = chart({ colors: undefined });
    const light = chartInks(slide({}, element), theme, element);
    expect(light.series.slice(0, 3)).toEqual([accent, ink, muted]);
    expect(light.ok).toBe(true);
    const dark = chartInks(slide({ background: ink }, element), theme, element);
    expect(dark.series).toHaveLength(4);
    for (const color of dark.series) expect(contrastRatio(color, ink)!).toBeGreaterThanOrEqual(3);
  });

  test('a dark panel under the chart counts as its ground, and a picture does not', () => {
    const element = chart();
    const panel: DeckElementV2 = {
      id: 'panel',
      type: 'shape',
      shape: 'rect',
      fill: ink,
      x: 30,
      y: 10,
      width: 65,
      height: 80,
    };
    const onPanel = slide({ elements: [panel, element] });
    expect(chartInks(onPanel, theme, element).label).toBe(background);
    const picture: DeckElementV2 = {
      id: 'picture',
      type: 'image',
      assetId: 'art',
      src: '/art/fallback-1.jpg',
      alt: 'Hills',
      x: 30,
      y: 10,
      width: 65,
      height: 80,
    };
    const onPicture = slide({ elements: [picture, element] });
    expect(chartInks(onPicture, theme, element).ground).toBe(background);
  });

  test('the check flags a chart when no color of the theme reads on its ground', () => {
    const one = slide({ background: '#777777' });
    expect(chartInks(one, theme, one.elements[0] as Chart).ok).toBe(false);
    const report = checkDeck(deck(one));
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: 'low-contrast', severity: 'error', elementIds: ['chart'] }),
    ]);
    expect(checkDeck(deck(slide())).ok).toBe(true);
    expect(checkDeck(deck(slide({ background: ink }))).ok).toBe(true);
  });
});

test('a theme with no color that reads gives the label color, and the check flags it', () => {
  const flat = {
    ...theme,
    colors: {
      ...theme.colors,
      ink: '#777777',
      background: '#7A7A7A',
      surface: '#808080',
      muted: '#787878',
      accent: '#7C7C7C',
      accentInk: '#747474',
    },
  };
  const element = chart({ colors: ['#7D7D7D'] });
  const one = slide({ background: '#777777' }, element);
  const inks = chartInks(one, flat, element);
  expect(inks.series).toEqual([inks.label]);
  expect(inks.ok).toBe(false);
  expect(checkSlide(one, flat).map((issue) => issue.kind)).toEqual(['low-contrast']);
});

describe('both renderers use those colors', () => {
  const bare = (hex: string) => hex.replace('#', '');

  test('the PPTX on a dark slide has readable labels and no series in ink', async () => {
    const xml = await chartXml(deck(slide({ background: ink })));
    expect(xml).toContain(bare(background));
    expect(xml).not.toContain(bare(ink));
    expect(xml).not.toContain(bare(muted));
  });

  test('the PPTX on a light slide keeps the theme colors', async () => {
    const xml = await chartXml(deck(slide()));
    expect(xml).toContain(bare(ink));
    expect(xml).toContain(bare(muted));
    expect(xml).toContain(bare(accent));
  });

  test('the web slide on a dark ground draws labels and series in the same colors', () => {
    const one = slide({ background: ink });
    const inks = chartInks(one, theme, one.elements[0] as Chart);
    const html = renderToStaticMarkup(<SlideSurface slide={one} theme={theme} />);
    expect(html).not.toContain('fill="var(--deck-ink)"');
    expect(html).not.toContain('fill="var(--deck-muted)"');
    expect(html).toContain(`fill="${background}"`);
    expect(html).toContain(`stroke="${inks.series[0]}"`);
    expect(html).toContain(`stroke="${inks.series[1]}"`);
    expect(html).not.toContain(`stroke="${ink}"`);
  });

  test('a doughnut hole on a dark slide takes the color of the slide, not the paper', () => {
    const element = chart({
      chart: 'doughnut',
      series: [{ name: 'Share', values: [3, 2] }],
      colors: [accent, ink],
    });
    const html = renderToStaticMarkup(
      <SlideSurface slide={slide({ background: ink }, element)} theme={theme} />,
    );
    expect(html).toContain(`fill="${ink}"`);
    expect(html).not.toContain('var(--deck-bg)"');
  });
});

describe('the corner of a rounded panel in the PPTX', () => {
  async function adjust(radius: number | undefined) {
    const element: DeckElementV2 = {
      id: 'round',
      type: 'shape',
      shape: 'roundRect',
      ...(radius === undefined ? {} : { radius }),
      fill: background,
      x: 6,
      y: 32,
      width: 40,
      height: 40,
    };
    const { bytes } = await exportDocument(
      record(deck({ id: 's', title: 'Panels', notes: '', elements: [element] })),
    );
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    return { xml, adj: xml.match(/name="adj" fmla="val (\d+)"/)?.[1] };
  }

  test('with no radius it matches the 12 points of the web renderer', async () => {
    const standard = await adjust(12);
    const unset = await adjust(undefined);
    expect(standard.adj).toBeDefined();
    expect(unset.adj).toBe(standard.adj);
  });

  test('a radius of zero is a square corner, as on the web', async () => {
    const { xml } = await adjust(0);
    expect(xml).toContain('prstGeom prst="rect"');
    expect(xml).not.toContain('prstGeom prst="roundRect"');
  });
});
