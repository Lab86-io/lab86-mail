import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

/**
 * The artwork panel in a DOM: the default request from the theme, the
 * style chips, the museum toggle, "More", the two actions through the
 * import route, and the server's error text. The pure helpers (placement,
 * hue, notes) are covered in the same child process. Runs isolated like the
 * deck editor suite so react-dom sees a window before it loads.
 */
if (process.env.ALBATROSS_DECK_ARTWORK_DOM_TEST !== '1') {
  test('deck artwork panel DOM suite runs isolated from server-first React import order', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, ALBATROSS_DECK_ARTWORK_DOM_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`Isolated deck artwork suite failed:\n${output}\n${error}`);
    expect(exit).toBe(0);
    expect(error).toMatch(/\d+ pass/);
  }, 60_000);
} else {
  const TOUCHED_GLOBALS = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'KeyboardEvent',
    'MouseEvent',
    'Event',
    'CustomEvent',
    'FocusEvent',
    'ResizeObserver',
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'navigator',
  ] as const;
  const saved = new Map(
    TOUCHED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  );
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    FocusEvent: dom.window.FocusEvent,
    ResizeObserver: ResizeObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ArtworkPanel, defaultArtworkQuery, directionForTheme } = await import(
    '../components/files/editors/deck/artwork-panel'
  );
  const assets = await import('../components/files/editors/deck/assets');
  const { MAX_DECK_ASSET_BYTES: STORE_LIMIT } = await import('../lib/documents/deck-asset-store');
  const { DECK_THEMES } = await import('../lib/documents/deck-fixtures');
  const { searchArtPool, stylesForDirection } = await import('../lib/documents/deck-art');
  type Candidate = import('../components/files/editors/deck/assets').DeckArtworkCandidate;
  type Query = import('../components/files/editors/deck/assets').DeckArtworkQuery;
  type Imported = import('../components/files/editors/deck/assets').ImportedDeckArtwork;

  afterAll(() => {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });

  const roots: Root[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function mount(element: ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(element));
    return host;
  }

  const q = <T extends Element>(selector: string) => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing ${selector}`);
    return found;
  };
  const buttonNamed = (text: string) => {
    const found = [...document.querySelectorAll('button')].find((node) => node.textContent === text);
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const click = (target: Element) =>
    act(async () => {
      target.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const setValue = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    act(() => {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  /** A search that answers from the curated pool and records every query, as the route would. */
  function poolSearch() {
    const queries: Query[] = [];
    const search = async (query: Query) => {
      queries.push(query);
      return searchArtPool({
        text: query.text,
        styles: query.styles as never,
        accentHue: query.hue,
        count: query.count,
        seed: query.seed,
      });
    };
    return { queries, search };
  }

  function fakeImport(options: { fail?: string } = {}) {
    const posted: Candidate[] = [];
    const importArtwork = async (candidate: Candidate): Promise<Imported> => {
      posted.push(candidate);
      if (options.fail) throw new Error(options.fail);
      return {
        assetId: `asset-${posted.length}`,
        src: `/assets/${posted.length}.jpg`,
        width: 1600,
        height: 1000,
        aspect: 1.6,
        mime: 'image/jpeg',
        attribution: {
          title: candidate.title,
          artist: candidate.artist,
          date: candidate.date,
          credit: candidate.credit,
          source: candidate.source,
          sourceUrl: candidate.sourceUrl,
          license: candidate.license,
        },
      };
    };
    return { posted, importArtwork };
  }

  async function mountPanel(
    options: {
      theme?: (typeof DECK_THEMES)['editorial'];
      fail?: string;
      onPlace?: (asset: Imported, candidate: Candidate) => void;
      onBackground?: (asset: Imported, candidate: Candidate) => void;
    } = {},
  ) {
    const searching = poolSearch();
    const importing = fakeImport({ fail: options.fail });
    const placed: { asset: Imported; candidate: Candidate }[] = [];
    const backgrounds: { asset: Imported; candidate: Candidate }[] = [];
    await mount(
      <ArtworkPanel
        theme={options.theme ?? DECK_THEMES.editorial}
        slideId="slide-2"
        onPlace={(asset, candidate) => {
          placed.push({ asset, candidate });
          options.onPlace?.(asset, candidate);
        }}
        onBackground={(asset, candidate) => {
          backgrounds.push({ asset, candidate });
          options.onBackground?.(asset, candidate);
        }}
        search={searching.search}
        importArtwork={importing.importArtwork}
      />,
    );
    await settle();
    return { ...searching, ...importing, placed, backgrounds };
  }

  describe('helpers', () => {
    test('the client upload limit and direction styles match the server modules', () => {
      expect(assets.MAX_DECK_ASSET_BYTES).toBe(STORE_LIMIT);
      expect(assets.ARTWORK_STYLES_FOR_DIRECTION.editorial).toEqual(stylesForDirection('editorial'));
      expect(assets.ARTWORK_STYLES_FOR_DIRECTION.signal).toEqual(stylesForDirection('signal'));
    });

    test('hue reads a hex color; the theme accents land where the pool expects them', () => {
      expect(assets.hueFromHex('#FF0000')).toBe(0);
      expect(assets.hueFromHex('#00FF00')).toBe(120);
      expect(assets.hueFromHex('0000ff')).toBe(240);
      expect(assets.hueFromHex('#808080')).toBeUndefined();
      expect(assets.hueFromHex('not a color')).toBeUndefined();
      expect(assets.hueFromHex(DECK_THEMES.editorial.colors.accent)).toBe(15);
      expect(assets.hueFromHex(DECK_THEMES.signal.colors.accent)).toBe(227);
    });

    test('placement keeps the artwork aspect, at most 60 wide and 80 tall, centered', () => {
      const wide = assets.artworkPlacement(1.6);
      expect(wide).toEqual({ x: 20, y: 16.7, width: 60, height: 66.7 });
      expect(wide.x * 2 + wide.width).toBe(100);
      const tall = assets.artworkPlacement(0.7);
      expect(tall.height).toBe(80);
      expect(tall.width).toBe(31.5);
      expect(tall.x).toBe(34.3);
      expect(tall.y).toBe(10);
      expect(assets.artworkPlacement(undefined).width).toBe(60);
      expect(assets.artworkPlacement(undefined).height).toBe(80);
    });

    test('the credit lands in the notes once', () => {
      const line = 'Artwork: Harbor at Dusk, A. Painter, 1880, The Met';
      expect(assets.notesWithArtworkCredit(undefined, 'Harbor at Dusk, A. Painter, 1880', 'The Met')).toBe(
        line,
      );
      expect(
        assets.notesWithArtworkCredit('Open with the harbor.', 'Harbor at Dusk, A. Painter, 1880', 'The Met'),
      ).toBe(`Open with the harbor.\n${line}`);
      expect(
        assets.notesWithArtworkCredit(`Open.\n${line}`, 'Harbor at Dusk, A. Painter, 1880', 'The Met'),
      ).toBe(`Open.\n${line}`);
    });

    test('the search url carries text, repeated styles, hue, seed and live', () => {
      const url = assets.artworkSearchUrl({
        text: ' harbor ',
        styles: ['modern', 'art-deco'],
        hue: 226.6,
        count: 12,
        seed: 's1',
        live: true,
      });
      const params = new URL(url, 'http://localhost').searchParams;
      expect(url.startsWith('/api/documents/artworks?')).toBe(true);
      expect(params.get('q')).toBe('harbor');
      expect(params.getAll('style')).toEqual(['modern', 'art-deco']);
      expect(params.get('hue')).toBe('227');
      expect(params.get('seed')).toBe('s1');
      expect(params.get('live')).toBe('1');
      expect(assets.artworkSearchUrl({})).toBe('/api/documents/artworks');
    });

    test('the import helper posts the candidate and surfaces the server message', async () => {
      const candidate = searchArtPool({ count: 1, seed: 'x' })[0];
      const calls: { url: string; init?: RequestInit }[] = [];
      const ok = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            asset: { assetId: 'a1', src: '/a1.jpg', width: 200, height: 100, attribution: { credit: 'C' } },
          }),
          { status: 201 },
        );
      };
      const imported = await assets.importDeckArtwork(candidate, ok as never);
      expect(calls[0].url).toBe('/api/documents/artworks/import');
      expect(JSON.parse(calls[0].init?.body as string)).toEqual(candidate);
      expect(imported).toMatchObject({ assetId: 'a1', src: '/a1.jpg', aspect: 2 });
      expect(imported.attribution.credit).toBe('C');
      expect(imported.attribution.source).toBe(candidate.source);
      const failing = async () =>
        new Response(JSON.stringify({ error: 'The museum image could not be fetched (503).' }), {
          status: 502,
        });
      await expect(assets.importDeckArtwork(candidate, failing as never)).rejects.toThrow(
        'The museum image could not be fetched (503).',
      );
      const denied = async () => new Response(JSON.stringify({ error: 'Sign in first.' }), { status: 401 });
      await expect(assets.searchDeckArtworks({}, denied as never)).rejects.toThrow('Sign in first.');
    });

    test('the default query follows the theme direction, accent hue and slide seed', () => {
      expect(directionForTheme(DECK_THEMES.editorial)).toBe('editorial');
      expect(directionForTheme(DECK_THEMES.signal)).toBe('signal');
      expect(defaultArtworkQuery(DECK_THEMES.signal, 'slide-9')).toEqual({
        styles: stylesForDirection('signal'),
        hue: 227,
        count: 12,
        seed: 'slide-9',
      });
      const withImagery = {
        ...DECK_THEMES.editorial,
        imagery: { mode: 'paintings' as const, styles: ['baroque'] },
      };
      expect(defaultArtworkQuery(withImagery, 's').styles).toEqual(['baroque']);
    });
  });

  describe('the panel', () => {
    test('opens with results for the theme and shows a credit under each', async () => {
      const panel = await mountPanel();
      expect(panel.queries).toHaveLength(1);
      expect(panel.queries[0]).toMatchObject({
        styles: stylesForDirection('editorial'),
        hue: 15,
        count: 12,
        seed: 'slide-2',
        live: false,
      });
      expect(panel.queries[0].text).toBeUndefined();
      const items = document.querySelectorAll('.deck-artwork-item');
      expect(items).toHaveLength(12);
      const expected = searchArtPool({
        styles: stylesForDirection('editorial'),
        accentHue: 15,
        count: 12,
        seed: 'slide-2',
      });
      expect([...items].map((item) => item.querySelector('.deck-artwork-credit')?.textContent)).toEqual(
        expected.map((candidate) => candidate.credit),
      );
      expect(q<HTMLImageElement>('.deck-artwork-thumb img').getAttribute('src')).toBe(expected[0].previewUrl);
      expect(document.activeElement).toBe(q('[aria-label="Search artwork"]'));
      expect(buttonNamed('Any style').getAttribute('aria-pressed')).toBe('true');
      expect((buttonNamed('Place on slide') as HTMLButtonElement).disabled).toBe(true);
      expect((buttonNamed('Use as background') as HTMLButtonElement).disabled).toBe(true);
      expect(document.body.textContent).not.toMatch(/\bAI\b/);
    });

    test('a style chip, the museum toggle, the search field and More each change the request', async () => {
      const panel = await mountPanel();
      await click(buttonNamed('Modern'));
      expect(panel.queries.at(-1)).toMatchObject({ styles: ['modern'], seed: 'slide-2' });
      expect(buttonNamed('Modern').getAttribute('aria-pressed')).toBe('true');
      expect(buttonNamed('Any style').getAttribute('aria-pressed')).toBe('false');
      const modern = searchArtPool({ styles: ['modern'], accentHue: 15, count: 12, seed: 'slide-2' });
      expect([...document.querySelectorAll('.deck-artwork-credit')].map((node) => node.textContent)).toEqual(
        modern.map((candidate) => candidate.credit),
      );
      expect(modern[0].style).toBe('modern');
      await click(q('[aria-label="Search museums too"]'));
      expect(panel.queries.at(-1)?.live).toBe(true);
      setValue(q<HTMLInputElement>('[aria-label="Search artwork"]'), 'landscape');
      await act(async () => {
        q('form.deck-artwork-search').dispatchEvent(
          new dom.window.Event('submit', { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(panel.queries.at(-1)).toMatchObject({ text: 'landscape', styles: ['modern'], live: true });
      const before = panel.queries.length;
      await click(buttonNamed('More'));
      expect(panel.queries).toHaveLength(before + 1);
      expect(panel.queries.at(-1)?.seed).toBe('slide-2:1');
      await click(buttonNamed('Any style'));
      expect(panel.queries.at(-1)).toMatchObject({
        styles: stylesForDirection('editorial'),
        seed: 'slide-2',
      });
    });

    test('Place on slide imports the chosen artwork and hands back the asset', async () => {
      const panel = await mountPanel();
      const second = document.querySelectorAll<HTMLButtonElement>('.deck-artwork-item')[1];
      await click(second);
      expect(second.getAttribute('aria-pressed')).toBe('true');
      expect(q('.deck-artwork-selected-title').textContent).toBeTruthy();
      await click(buttonNamed('Place on slide'));
      expect(panel.posted).toHaveLength(1);
      expect(panel.posted[0].credit).toBe<unknown>(second.getAttribute('aria-label'));
      expect(panel.posted[0].imageUrl).toMatch(/^https:\/\//);
      expect(panel.placed).toHaveLength(1);
      expect(panel.placed[0].asset).toMatchObject({ assetId: 'asset-1', src: '/assets/1.jpg', aspect: 1.6 });
      expect(panel.placed[0].candidate.key).toBe(panel.posted[0].key);
      expect(assets.artworkPlacement(panel.placed[0].asset.aspect)).toEqual({
        x: 20,
        y: 16.7,
        width: 60,
        height: 66.7,
      });
      expect(panel.backgrounds).toHaveLength(0);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    test('Use as background imports and reports the background asset', async () => {
      const panel = await mountPanel();
      await click(q('.deck-artwork-item'));
      await click(buttonNamed('Use as background'));
      expect(panel.posted).toHaveLength(1);
      expect(panel.backgrounds).toHaveLength(1);
      expect(panel.backgrounds[0].asset.assetId).toBe('asset-1');
      expect(panel.placed).toHaveLength(0);
    });

    test('an import failure shows the server text and keeps the selection', async () => {
      const panel = await mountPanel({ fail: 'The museum image could not be fetched (503).' });
      await click(q('.deck-artwork-item'));
      await click(buttonNamed('Place on slide'));
      expect(q('[role="alert"]').textContent).toBe('The museum image could not be fetched (503).');
      expect(panel.placed).toHaveLength(0);
      expect(q('.deck-artwork-item').getAttribute('aria-pressed')).toBe('true');
      expect((buttonNamed('Place on slide') as HTMLButtonElement).disabled).toBe(false);
    });

    test('a search failure shows the server text', async () => {
      await mount(
        <ArtworkPanel
          theme={DECK_THEMES.editorial}
          slideId="s"
          onPlace={() => {}}
          onBackground={() => {}}
          search={async () => {
            throw new Error('Sign in first.');
          }}
          importArtwork={async () => {
            throw new Error('unused');
          }}
        />,
      );
      await settle();
      expect(q('[role="alert"]').textContent).toBe('Sign in first.');
      expect(document.querySelectorAll('.deck-artwork-item')).toHaveLength(0);
    });

    test('read only disables the field, the chips and the actions', async () => {
      await mount(
        <ArtworkPanel
          theme={DECK_THEMES.signal}
          slideId="s"
          readOnly
          onPlace={() => {}}
          onBackground={() => {}}
          search={poolSearch().search}
          importArtwork={fakeImport().importArtwork}
        />,
      );
      await settle();
      expect(q<HTMLInputElement>('[aria-label="Search artwork"]').disabled).toBe(true);
      expect(q<HTMLFieldSetElement>('fieldset.deck-artwork-styles').disabled).toBe(true);
      expect(q<HTMLButtonElement>('.deck-artwork-item').disabled).toBe(true);
      expect((buttonNamed('More') as HTMLButtonElement).disabled).toBe(true);
    });
  });
}
