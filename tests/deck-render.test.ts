import { describe, expect, test } from 'bun:test';
import { hiringDeck, referenceDeck } from '../lib/documents/deck-fixtures';
import { checkDeck, repairDeck } from '../lib/documents/deck-quality';
import { availableRenderBrowser, renderDeckHtml } from '../lib/documents/deck-render';

describe('deck render page', () => {
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
