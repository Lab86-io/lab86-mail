import { describe, expect, test } from 'bun:test';
import { hiringDeck, referenceDeck } from '../lib/documents/deck-fixtures';
import { checkDeck, estimateTextLines, repairDeck, textFits } from '../lib/documents/deck-quality';
import { availableRenderBrowser, renderDeckHtml } from '../lib/documents/deck-render';

describe('deck render page', () => {
  test('horizontal bars keep upright labels and signed data on the correct side of zero', async () => {
    const model = referenceDeck('editorial');
    model.slides = [
      {
        id: 'chart-test',
        title: 'Signed values',
        elements: [
          {
            id: 'chart',
            type: 'chart',
            chart: 'bar',
            x: 10,
            y: 10,
            width: 80,
            height: 70,
            categories: ['Loss', 'Gain'],
            series: [{ name: 'Net', values: [-50, 100] }],
            values: true,
          },
        ],
      },
    ];
    const html = await renderDeckHtml(model);
    expect(html).not.toContain('scale(1 -1)');
    expect(html).not.toContain('rotate(90');
    expect(html).toContain('data-chart-mark="bar" data-value="-50"');
    expect(html).toContain('data-chart-mark="bar" data-value="100"');
    const { JSDOM } = await import('jsdom');
    const document = new JSDOM(html).window.document;
    const bars = [...document.querySelectorAll('[data-chart-mark="bar"]')];
    const [loss, gain] = bars.map((bar) => ({
      x: Number(bar.getAttribute('x')),
      width: Number(bar.getAttribute('width')),
      height: Number(bar.getAttribute('height')),
    }));
    expect(loss.x + loss.width).toBeCloseTo(gain.x);
    expect(gain.width).toBeCloseTo(loss.width * 2);
    expect(bars.every((bar) => Number(bar.getAttribute('height')) > 0)).toBe(true);
    expect(
      [...document.querySelectorAll('text')]
        .filter((text) => ['Loss', 'Gain'].includes(text.textContent ?? ''))
        .every((text) => !text.getAttribute('transform')),
    ).toBe(true);
  });
  test('inlines the packaged fonts and one frame per slide with absolute asset paths', async () => {
    const html = await renderDeckHtml(referenceDeck('editorial'), {
      assetOrigin: 'https://mail-staging.lab86.io',
    });
    expect(html).toContain('font-family:"Fraunces"');
    expect(html).toContain('font-family:"Geist"');
    expect(html).toContain('data:font/woff2;base64,');
    expect((html.match(/class="slide-frame"/g) || []).length).toBe(6);
    expect(html).toContain('src="https://mail-staging.lab86.io/art/fallback-3.jpg"');
    expect(html).not.toContain('src="/art/');
  });
  test('reports a browser outside production without configuration', () => {
    expect(['local', 'browserbase']).toContain(availableRenderBrowser());
  });
});

describe('deck quality checks', () => {
  test('words wider than a column wrap before overflow is accepted', () => {
    const element = {
      id: 'label',
      type: 'text' as const,
      role: 'subtitle' as const,
      text: 'Media completeness',
      x: 9,
      y: 34,
      width: 13,
      height: 12,
      fontSize: 24,
    };
    expect(estimateTextLines(element)).toBe(3);
    expect(textFits(element)).toBe(false);
    const deck = referenceDeck('editorial');
    deck.slides = [{ id: 'comparison', title: 'Checks', elements: [element] }];
    const repaired = repairDeck(deck);
    expect(repaired.report.ok).toBe(true);
    expect(
      repaired.model.slides[0].elements[0].type === 'text' && repaired.model.slides[0].elements[0].fontSize,
    ).toBeLessThan(24);
    expect(estimateTextLines({ ...element, text: 'abcdefghijklmnopqrstu' })).toBe(3);
  });

  test('the reference decks pass without errors', () => {
    for (const deck of [referenceDeck('editorial'), referenceDeck('signal'), hiringDeck()]) {
      const report = checkDeck(deck);
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });
  test('finds off-canvas, overflow, contrast, overlap and missing images, and repairs what it can', () => {
    const deck = referenceDeck('editorial');
    const slide = deck.slides[0];
    const broken = {
      ...deck,
      slides: [
        {
          ...slide,
          elements: [
            { id: 'off', type: 'text', text: 'Off the edge', x: 90, y: 90, width: 30, height: 20 },
            {
              id: 'long',
              type: 'text',
              text: 'word '.repeat(400),
              x: 5,
              y: 5,
              width: 20,
              height: 5,
              fontSize: 40,
            },
            { id: 'faint', type: 'text', text: 'Faint', x: 5, y: 40, width: 20, height: 8, color: '#F0EEE8' },
            { id: 'a', type: 'text', text: 'One', x: 50, y: 50, width: 20, height: 10 },
            { id: 'b', type: 'text', text: 'Two', x: 55, y: 55, width: 20, height: 10 },
            { id: 'img', type: 'image', x: 5, y: 60, width: 20, height: 20, assetId: 'x', alt: 'No source' },
          ],
        } as typeof slide,
      ],
    };
    const kinds = new Set(checkDeck(broken).issues.map((issue) => issue.kind));
    for (const kind of ['off-canvas', 'overflow', 'low-contrast', 'overlap', 'missing-image'])
      expect(kinds.has(kind as never)).toBe(true);
    const repaired = repairDeck(broken);
    const after = new Set(repaired.report.issues.map((issue) => issue.kind));
    expect(after.has('off-canvas')).toBe(false);
    const long = repaired.model.slides[0].elements.find((element) => element.id === 'long');
    expect(long?.type === 'text' && (long.fontSize ?? 0) < 40).toBe(true);
    expect(repaired.report.ok).toBe(false);
  });
  test('deliberate overlap is allowed when marked', () => {
    const deck = referenceDeck('editorial');
    const slide = deck.slides[0];
    const model = {
      ...deck,
      slides: [
        {
          ...slide,
          elements: [
            { id: 'a', type: 'text', text: 'One', x: 50, y: 50, width: 20, height: 10, overlapAllowed: true },
            { id: 'b', type: 'text', text: 'Two', x: 55, y: 55, width: 20, height: 10 },
          ],
        } as typeof slide,
      ],
    };
    expect(checkDeck(model).issues.some((issue) => issue.kind === 'overlap')).toBe(false);
  });
});

describe('deck slide rendering', () => {
  test('measures actual text clipping and closes the browser when images fail or work is cancelled', async () => {
    const { __setDeckRenderDepsForTest, renderDeckSlides } = await import('../lib/documents/deck-render');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    let broken = false;
    let clipped = true;
    let closed = 0;
    const box = {
      dataset: { elementId: 'body' },
      querySelector: () => ({
        textContent: 'Evidence',
        getBoundingClientRect: () => ({ top: 10, bottom: clipped ? 35 : 20, left: 0, right: 100 }),
      }),
      getBoundingClientRect: () => ({ top: 10, bottom: 20, left: 0, right: 100 }),
    };
    const document = {
      fonts: { ready: Promise.resolve() },
      get images() {
        return [{ complete: true, naturalWidth: broken ? 0 : 100 }];
      },
      querySelectorAll: () => [{ dataset: { slideId: 'h-cover' }, querySelectorAll: () => [box] }],
      createRange: () => ({
        selectNodeContents() {},
        getBoundingClientRect: () => ({ top: 10, bottom: 35, left: 0, right: 100 }),
      }),
    };
    const page = {
      setDefaultTimeout() {},
      async setContent() {},
      async evaluate(fn: () => unknown) {
        return fn();
      },
      async waitForTimeout() {},
      locator: () => ({ screenshot: async () => Buffer.from('pixels') }),
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
    __setDeckRenderDepsForTest({
      connectBrowser: async () =>
        ({
          browser: { newContext: async () => ({ newPage: async () => page, close: async () => {} }) },
          close: async () => {
            closed++;
          },
        }) as any,
    });
    try {
      const deck = hiringDeck();
      deck.slides[0].id = 'h-cover';
      const images = await renderDeckSlides(deck, { browser: 'local' });
      expect(images[0].issues).toEqual([
        { elementId: 'body', description: expect.stringContaining('outside its visible box') },
      ]);
      clipped = false;
      const clean = await renderDeckSlides(deck, { browser: 'local' });
      // The glyph Range still extends past the box, but the actual line fits.
      expect(clean[0].issues).toEqual([]);
      broken = true;
      await expect(renderDeckSlides(deck, { browser: 'local' })).rejects.toThrow('images did not finish');
      expect(closed).toBe(3);
      const controller = new AbortController();
      controller.abort(new Error('Stopped'));
      await expect(
        renderDeckSlides(deck, { browser: 'local', abortSignal: controller.signal }),
      ).rejects.toThrow('Stopped');
      expect(closed).toBe(3);
    } finally {
      __setDeckRenderDepsForTest();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
  test('drives a browser page per slide and always closes it', async () => {
    const { __setDeckRenderDepsForTest, renderDeckSlides } = await import('../lib/documents/deck-render');
    const events: string[] = [];
    const fakePage = {
      setDefaultTimeout: () => undefined,
      setContent: async (html: string) =>
        events.push(`content:${(html.match(/class="slide-frame"/g) || []).length}`),
      evaluate: async () => undefined,
      waitForTimeout: async () => undefined,
      locator: (selector: string) => ({ screenshot: async () => Buffer.from(selector) }),
    };
    const fakeContext = { newPage: async () => fakePage, close: async () => events.push('context-closed') };
    __setDeckRenderDepsForTest({
      connectBrowser: async (kind) => {
        events.push(`connect:${kind}`);
        return {
          browser: { newContext: async () => fakeContext } as never,
          close: async () => events.push('browser-closed'),
        };
      },
    });
    try {
      const slides = await renderDeckSlides(hiringDeck(), { browser: 'browserbase' });
      expect(slides.map((slide) => slide.index)).toEqual([0, 1, 2]);
      expect(slides[1].png.toString()).toContain('data-slide-index="1"');
      expect(events).toEqual(['connect:browserbase', 'content:3', 'context-closed', 'browser-closed']);
    } finally {
      __setDeckRenderDepsForTest();
    }
  });
  test('refuses to render without a browser', async () => {
    const { renderDeckSlides } = await import('../lib/documents/deck-render');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(renderDeckSlides(hiringDeck())).rejects.toThrow('No render browser');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
