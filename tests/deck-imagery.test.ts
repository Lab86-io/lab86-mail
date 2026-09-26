import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type ArtworkCandidate, searchArtPool, stylesForDirection } from '../lib/documents/deck-art';
import { DeckAssetError } from '../lib/documents/deck-asset-store';
import { referenceDeck } from '../lib/documents/deck-fixtures';
import {
  artworksBySlideId,
  artworksBySlideIndex,
  artworksForDeck,
  compositionArtwork,
  DEFAULT_ARTWORK_BUDGET,
  hueOfHex,
  imageryDeclined,
  imageryTheme,
  planDeckImagery,
  planDeckImageryForDeck,
  resolveDeckImagery,
} from '../lib/documents/deck-imagery';
import { checkDeck } from '../lib/documents/deck-quality';
import { renderDeckSlides } from '../lib/documents/deck-render';
import {
  __setDeckUploadAssetDepsForTest,
  altFromFileName,
  assetsFromUploads,
} from '../lib/documents/deck-upload-assets';
import { createDefaultDocumentModel, type DeckElementV2, type DeckModelV2 } from '../lib/documents/model';
import {
  ARTWORK_PREFIX,
  buildDeckTheme,
  type CompositionArtwork,
  isArtworkSource,
  parseSlotName,
  stripArtworkNotes,
  withArtworkNote,
} from '../lib/documents/presentation-compositions';
import { composePresentationV2 } from '../lib/documents/presentation-design';
import {
  harborBrief,
  importedArtwork as importedFrom,
  lakeshoreBrief,
  poolArtworks,
  retroBrief,
  VALLEY,
} from './fixtures/presentation-briefs';

afterEach(() => {
  __setDeckUploadAssetDepsForTest();
  delete process.env.DECK_ART_LIVE;
});

const elements = (model: DeckModelV2, index: number) => model.slides[index].elements;
const bySlot = (list: DeckElementV2[], slot: string) =>
  list.find((element) => parseSlotName(element.name)?.slot === slot);
const artworkImages = (list: DeckElementV2[]) =>
  list.filter((element) => element.type === 'image' && isArtworkSource(element.source));

describe('the imagery plan', () => {
  test('chooses the artwork slots of a brief, in priority order, with subject words and styles', () => {
    const brief = lakeshoreBrief();
    const theme = buildDeckTheme('editorial', 'serif');
    const plan = planDeckImagery(brief, theme);
    expect(plan.subject).toBe('landscapes valley');
    expect(plan.styles).toEqual(stylesForDirection('editorial'));
    expect(typeof plan.accentHue).toBe('number');
    expect(plan.slots.map((slot) => [slot.role, slot.slideIndex, slot.slideId])).toEqual([
      ['cover', 0, 'slide-1'],
      ['image-left', 2, 'slide-3'],
      ['statement', 1, 'slide-2'],
      ['close', 5, 'slide-6'],
    ]);
    const cover = plan.slots[0];
    expect(cover.slotId).toBe('slot-1');
    expect(cover.query.text).toBe('valley landscapes lakeshore trail community update autumn 2026');
    expect(plan.slots.find((slot) => slot.slideIndex === 2)!.query.text.startsWith('hills ')).toBe(true);
    expect(cover.query.styles).toEqual(plan.styles);
    expect(cover.query.accentHue).toBe(plan.accentHue);
    expect(cover.query.count).toBeGreaterThan(1);
    // Owned assets take their slots first; artwork fills what remains.
    const withAssets = planDeckImagery(brief, theme, {
      assets: [VALLEY],
      slideIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(withAssets.slots.map((slot) => [slot.role, slot.slideId])).toEqual([
      ['image-left', 'c'],
      ['statement', 'b'],
      ['close', 'f'],
    ]);
  });

  test('a brief that declines imagery plans nothing; theme imagery narrows styles and subject', () => {
    expect(planDeckImagery(retroBrief(), buildDeckTheme('editorial', 'serif')).slots).toEqual([]);
    expect(imageryDeclined('None supplied; typographic slides.')).toBe(true);
    expect(imageryDeclined('Painted harbors.')).toBe(false);
    const theme = buildDeckTheme('signal', 'sans');
    expect(planDeckImagery(harborBrief(), theme).styles).toEqual(stylesForDirection('signal'));
    const themed = {
      ...theme,
      imagery: { mode: 'paintings' as const, styles: ['modern', 'bogus'], subject: 'ships' },
    };
    const plan = planDeckImagery(harborBrief(), themed);
    expect(plan.styles).toEqual(['modern']);
    expect(plan.subject).toBe('ships');
    expect(plan.slots.map((slot) => slot.role)).toEqual([
      'cover',
      'image-right',
      'statement',
      'close',
      'quote',
    ]);
    expect(plan.slots[0].query.text.startsWith('ships harbor works')).toBe(true);
  });

  test('the accent hue comes from a chromatic hex; grey or malformed colors give none', () => {
    expect(hueOfHex('#AE4B2B')).toBeGreaterThan(0);
    expect(hueOfHex('#777777')).toBeUndefined();
    expect(hueOfHex('red')).toBeUndefined();
    const grey = buildDeckTheme(
      {
        background: '#FFFFFF',
        surface: '#EEEEEE',
        ink: '#111111',
        muted: '#555555',
        accent: '#444444',
        accentInk: '#FFFFFF',
      },
      'serif',
    );
    const plan = planDeckImagery(harborBrief(), grey);
    expect(plan.accentHue).toBeUndefined();
    expect(plan.slots[0].query.accentHue).toBeUndefined();
  });

  test('an existing deck plans from its extracted content and skips slides it cannot carry', () => {
    const deck = referenceDeck('editorial');
    const plan = planDeckImageryForDeck(deck);
    // The cover and the image slide already show owned images; metrics and process take no painting.
    expect(plan.slots.map((slot) => [slot.role, slot.slideId])).toEqual([
      ['statement', 'statement'],
      ['close', 'close'],
    ]);
    expect(plan.subject).toBe('lakeshore trail');
    const chart = deck.slides[3].elements.find((element) => element.type === 'chart')!;
    const crowded: DeckModelV2 = {
      ...deck,
      theme: { ...deck.theme, imagery: { mode: 'paintings', subject: 'valley' } },
      slides: deck.slides.map((slide, index) =>
        index === 1 ? { ...slide, elements: [...slide.elements, chart, { ...chart, id: 'chart-2' }] } : slide,
      ),
    };
    const narrowed = planDeckImageryForDeck(crowded);
    expect(narrowed.subject).toBe('valley');
    expect(narrowed.slots.map((slot) => slot.slideId)).toEqual(['close']);
  });
});

describe('resolving the plan', () => {
  const plan = planDeckImagery(harborBrief(), buildDeckTheme('editorial', 'serif'));
  const pool = searchArtPool({
    text: 'harbor',
    styles: stylesForDirection('editorial'),
    count: 6,
    seed: 'r',
  });

  test('imports one painting per slot without repeats, within the budget, pool first', async () => {
    const search = mock(async (..._args: unknown[]) => pool);
    const importOne = mock(async (_userId: string, candidate: ArtworkCandidate) =>
      importedFrom(candidate, pool.indexOf(candidate)),
    );
    const resolved = await resolveDeckImagery(plan, { userId: 'u', search, importOne });
    expect(DEFAULT_ARTWORK_BUDGET).toBe(4);
    expect(resolved.assets).toHaveLength(4);
    expect(resolved.notes).toEqual([]);
    expect(new Set(resolved.assets.map((asset) => asset.attribution.sourceUrl)).size).toBe(4);
    expect(Object.keys(resolved.bySlot)).toEqual(plan.slots.slice(0, 4).map((slot) => slot.slotId));
    expect(search).toHaveBeenCalledTimes(4);
    expect(search.mock.calls[0][0]).toMatchObject({
      text: plan.slots[0].query.text,
      seed: 'slot-1',
      live: false,
    });
    expect((search.mock.calls[3][0] as any).exclude).toHaveLength(3);
    expect(importOne.mock.calls[0][0]).toBe('u');
    const two = await resolveDeckImagery(plan, { userId: 'u', search, importOne, budget: 2 });
    expect(two.assets).toHaveLength(2);
  });

  test('a failed search or import is a note, the next candidate is tried once, and live follows the flag', async () => {
    process.env.DECK_ART_LIVE = 'true';
    let calls = 0;
    const search = mock(async (..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error('museum down');
      return pool;
    });
    let attempts = 0;
    const importOne = mock(async (_userId: string, candidate: ArtworkCandidate) => {
      attempts += 1;
      if (attempts <= 2) throw new Error('fetch failed');
      return importedFrom(candidate, attempts);
    });
    const resolved = await resolveDeckImagery(plan, { userId: 'u', search, importOne });
    expect(search.mock.calls[1][0]).toMatchObject({ live: true });
    expect(resolved.notes).toEqual([
      'No artwork search result for slide 1.',
      'No artwork was imported for slide 3.',
    ]);
    expect(resolved.assets).toHaveLength(3);
    expect(Object.keys(resolved.bySlot)).toEqual(['slot-2', 'slot-6', 'slot-5']);
    const empty = await resolveDeckImagery(plan, { userId: 'u', search: async () => [], importOne });
    expect(empty.assets).toEqual([]);
    expect(empty.notes).toHaveLength(plan.slots.length);
  });

  test('imported paintings map to composition artworks with a credit and to the theme record', () => {
    const [asset] = poolArtworks(1);
    const artwork = compositionArtwork(asset);
    expect(artwork.credit).toBe(`${asset.attribution.credit}, ${asset.attribution.source}`);
    expect(artwork.asset).toEqual({
      assetId: 'art-1',
      src: asset.src,
      alt: asset.attribution.title,
      aspect: 1.6,
    });
    const resolved = { assets: [asset], bySlot: { 'slot-1': asset }, notes: [] };
    expect(artworksBySlideIndex(plan, resolved)).toEqual({ 0: artwork });
    expect(artworksBySlideId(plan, resolved)).toEqual({ 'slide-1': artwork });
    expect(imageryTheme(plan)).toEqual({
      mode: 'paintings',
      styles: stylesForDirection('editorial'),
      subject: 'harbor ships water dusk',
    });
    const bare = compositionArtwork({ ...asset, aspect: 0 });
    expect(bare.asset.aspect).toBeUndefined();
  });

  test('artworks for a deck upgrade the model and skip the search when nothing can take a painting', async () => {
    const search = mock(async (..._args: unknown[]) => pool);
    const importOne = mock(async (_userId: string, candidate: ArtworkCandidate) =>
      importedFrom(candidate, 0),
    );
    const blank = createDefaultDocumentModel('deck', 'd');
    const none = await artworksForDeck(blank as never, { userId: 'u', search, importOne });
    expect(none.artworks).toEqual({});
    expect(search).not.toHaveBeenCalled();
    const some = await artworksForDeck(referenceDeck('editorial'), { userId: 'u', search, importOne });
    expect(Object.keys(some.artworks)).toEqual(['statement', 'close']);
    expect(some.imagery.mode).toBe('paintings');
    expect(some.notes).toEqual([]);
  });
});

describe('compositions with artwork', () => {
  const artworks = poolArtworks(6);
  const map = (indices: number[]): Partial<Record<number, CompositionArtwork>> =>
    Object.fromEntries(indices.map((index, i) => [index, compositionArtwork(artworks[i])]));

  test('every artwork role hangs its painting with a credit, on a checked slide, with the notes line', () => {
    const brief = harborBrief();
    const plan = planDeckImagery(brief, buildDeckTheme('editorial', 'serif'));
    const model = composePresentationV2(brief, {
      artworks: map([0, 1, 2, 4, 5]),
      imagery: imageryTheme(plan),
    });
    expect(checkDeck(model)).toEqual({ ok: true, issues: [] });
    expect(model.theme.imagery).toEqual(imageryTheme(plan));
    for (const index of [0, 1, 2, 4, 5]) {
      const slide = model.slides[index];
      const credit = bySlot(slide.elements, 'credit');
      expect(credit).toMatchObject({ type: 'text', role: 'caption', fontSize: 11 });
      expect(credit?.type === 'text' && credit.text).toBe(
        compositionArtwork(artworks[[0, 1, 2, 4, 5].indexOf(index)]).credit,
      );
      expect(slide.notes?.split('\n').at(-1)?.startsWith(ARTWORK_PREFIX)).toBe(true);
    }
    // Cover: painting on the right half, the foot line moves up, credit under it.
    const cover = elements(model, 0);
    expect(artworkImages(cover)[0]).toMatchObject({
      x: 52,
      y: 0,
      width: 48,
      height: 100,
      source: `${ARTWORK_PREFIX}${compositionArtwork(artworks[0]).credit}`,
    });
    expect(bySlot(cover, 'foot')).toMatchObject({ y: 86 });
    expect(model.slides[0].notes).toBe(
      `Depths in metres below chart datum.\n${ARTWORK_PREFIX}${compositionArtwork(artworks[0]).credit}`,
    );
    // Statement: painting behind the words under an ink veil.
    const statement = model.slides[1];
    expect(statement.background).toBe(model.theme.colors.ink);
    expect(statement.backgroundImage).toMatchObject({ assetId: 'art-2', opacity: 0.28 });
    expect(bySlot(statement.elements, 'veil')).toMatchObject({
      type: 'shape',
      x: 0,
      width: 100,
      opacity: 0.35,
    });
    expect(artworkImages(statement.elements)).toHaveLength(0);
    expect(statement.notes).toBe(`${ARTWORK_PREFIX}${compositionArtwork(artworks[1]).credit}`);
    // Image-right: the painting takes the image box and the text keeps the left column.
    expect(artworkImages(elements(model, 2))[0]).toMatchObject({ x: 54, width: 46 });
    expect(bySlot(elements(model, 2), 'title')).toMatchObject({ x: 6 });
    // Metrics takes no painting even when one is offered.
    const offered = composePresentationV2(brief, { artworks: map([3]) });
    expect(artworkImages(elements(offered, 3))).toHaveLength(0);
    expect(offered.theme.imagery).toBeUndefined();
    // Quote: painting on the left third; the quote moves right of it.
    const quote = elements(model, 4);
    expect(artworkImages(quote)[0]).toMatchObject({ x: 0, width: 32 });
    expect(bySlot(quote, 'title')).toMatchObject({ x: 41, width: 50 });
    // Close: an art strip along the top; the head moves down and the credit sits right of the contact line.
    const close = elements(model, 5);
    expect(artworkImages(close)[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 8 });
    expect(bySlot(close, 'title')).toMatchObject({ y: 16 });
    expect(bySlot(close, 'credit')).toMatchObject({ x: 46, align: 'right' });
    expect(bySlot(elements(model, 2), 'page')).toMatchObject({ x: 40 });
    expect(bySlot(close, 'body')).toMatchObject({ width: 38 });
  });

  test('an owned image wins its slot; the signal voice and image-left also hang paintings', () => {
    const lakeshore = composePresentationV2(lakeshoreBrief('signal'), {
      assets: [VALLEY],
      artworks: map([0, 1, 2, 5]),
      imagery: { mode: 'paintings' },
    });
    expect(checkDeck(lakeshore).ok).toBe(true);
    const cover = elements(lakeshore, 0);
    expect(cover.find((element) => element.type === 'image')).toMatchObject({ assetId: 'dev-art-3' });
    expect(bySlot(cover, 'credit')).toBeUndefined();
    expect(lakeshore.slides[0].notes).toBeUndefined();
    // The signal statement moves to the ink ground when a painting sits behind it.
    expect(lakeshore.slides[1].background).toBe(lakeshore.theme.colors.ink);
    expect(bySlot(elements(lakeshore, 1), 'title')).toMatchObject({
      color: lakeshore.theme.colors.background,
    });
    const imageLeft = elements(lakeshore, 2);
    expect(artworkImages(imageLeft)[0]).toMatchObject({ x: 0, width: 46 });
    expect(bySlot(imageLeft, 'credit')).toMatchObject({ x: 52, width: 33 });
    expect(bySlot(imageLeft, 'title')).toMatchObject({ x: 52 });
    const data = lakeshoreBrief('signal').slides[3].chart!;
    expect(elements(lakeshore, 3).find((element) => element.type === 'chart')).toMatchObject({
      categories: data.categories,
      series: data.series,
      unit: data.unit,
      source: data.source,
    });
    // The typographic variants are unchanged without artwork.
    const plain = composePresentationV2(lakeshoreBrief('signal'));
    expect(plain.slides[1].background).toBe(plain.theme.colors.accent);
    expect(plain.slides[1].backgroundImage).toBeUndefined();
  });

  test('notes helpers add one artwork line and strip it again', () => {
    const artwork = compositionArtwork(artworks[0]);
    const line = `${ARTWORK_PREFIX}${artwork.credit}`;
    expect(withArtworkNote(undefined, artwork)).toBe(line);
    expect(withArtworkNote('Keep me.', artwork)).toBe(`Keep me.\n${line}`);
    expect(withArtworkNote(`Keep me.\n${line}`, artwork)).toBe(`Keep me.\n${line}`);
    expect(withArtworkNote(`Keep me.\n${line}`, undefined)).toBe('Keep me.');
    expect(stripArtworkNotes(undefined)).toBe('');
    expect(isArtworkSource(undefined)).toBe(false);
    expect(isArtworkSource(line)).toBe(true);
  });

  test.skipIf(!process.env.DECK_ART_RENDER)(
    'renders a sample deck with paintings for review',
    async () => {
      const brief = harborBrief();
      const model = composePresentationV2(brief, { artworks: map([0, 1, 2, 4, 5]) });
      const rendered = await renderDeckSlides(model, { browser: 'local', timeoutMs: 120_000 });
      mkdirSync('/tmp/deck-artful', { recursive: true });
      for (const slide of rendered)
        writeFileSync(`/tmp/deck-artful/${slide.index + 1}-${slide.slideId}.png`, slide.png);
      expect(rendered).toHaveLength(6);
    },
    120_000,
  );
});

describe('owned images from chat uploads', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
  const rows: Record<string, any> = {
    img: {
      _id: 'img',
      name: 'Harbor-photo.JPG',
      contentType: 'image/jpeg',
      size: 1000,
      url: 'https://files/img',
    },
    ext: { _id: 'ext', name: 'plan_v2.png', contentType: undefined, size: 1000, url: 'https://files/ext' },
    pdf: {
      _id: 'pdf',
      name: 'brief.pdf',
      contentType: 'application/pdf',
      size: 1000,
      url: 'https://files/pdf',
    },
    big: {
      _id: 'big',
      name: 'big.png',
      contentType: 'image/png',
      size: 9 * 1024 * 1024,
      url: 'https://files/big',
    },
    gone: { _id: 'gone', name: 'gone.png', contentType: 'image/png', size: 10, url: null },
    bad: { _id: 'bad', name: 'bad.png', contentType: 'image/png', size: 10, url: 'https://files/bad' },
    heavy: {
      _id: 'heavy',
      name: 'heavy.png',
      contentType: 'image/png',
      size: 10,
      url: 'https://files/heavy',
    },
    reject: {
      _id: 'reject',
      name: 'reject.png',
      contentType: 'image/png',
      size: 10,
      url: 'https://files/reject',
    },
    boom: { _id: 'boom', name: 'boom.png', contentType: 'image/png', size: 10, url: 'https://files/boom' },
    wide: { _id: 'wide', name: 'wide.png', contentType: 'image/png', size: 10, url: 'https://files/wide' },
  };

  test('stores image uploads as owned assets in order and skips the rest with a note', async () => {
    const stored: string[] = [];
    __setDeckUploadAssetDepsForTest({
      convexQuery: (async (_fn: unknown, args: any) => {
        if (args.uploadId === 'throws') throw new Error('invalid id');
        return rows[args.uploadId] ?? null;
      }) as any,
      fetch: (async (url: string) => {
        if (url.endsWith('/bad')) return new Response('', { status: 404 });
        if (url.endsWith('/heavy'))
          return {
            ok: true,
            headers: new Headers({ 'content-length': String(20 * 1024 * 1024) }),
            arrayBuffer: async () => png.buffer,
          };
        return new Response(png, { status: 200 });
      }) as any,
      storeDeckAsset: (async (userId: string, bytes: Uint8Array) => {
        if (stored.length === 2) throw new DeckAssetError('Use a PNG, JPEG, WebP or GIF image.', 415);
        if (stored.length === 3) throw new Error('storage offline');
        stored.push(`${userId}:${bytes.length}`);
        return {
          assetId: `asset-${stored.length}`,
          src: `https://owned/asset-${stored.length}`,
          width: 1200,
          height: 800,
          aspect: 1.5,
          mime: 'image/png',
          size: bytes.length,
        };
      }) as any,
    });
    const result = await assetsFromUploads('user-1', [
      'img',
      'ext',
      'img',
      'pdf',
      'big',
      'gone',
      'missing',
      'throws',
      'bad',
      'heavy',
    ]);
    expect(result.assets).toEqual([
      { assetId: 'asset-1', src: 'https://owned/asset-1', alt: 'Harbor photo', aspect: 1.5 },
      { assetId: 'asset-2', src: 'https://owned/asset-2', alt: 'plan v2', aspect: 1.5 },
    ]);
    expect(stored).toEqual(['user-1:14', 'user-1:14']);
    expect(result.notes).toEqual([
      'brief.pdf is not an image and was skipped.',
      'big.png is larger than 8 MB and was skipped.',
      'One attachment is no longer available and was skipped.',
      'One attachment is no longer available and was skipped.',
      'One attachment is no longer available and was skipped.',
      'bad.png was skipped. The upload could not be read.',
    ]);
    // The cap is eight ids; the ninth is never read.
    const read = mock(async () => null);
    __setDeckUploadAssetDepsForTest({ convexQuery: read as any });
    await assetsFromUploads(
      'user-1',
      Array.from({ length: 10 }, (_, i) => `id-${i}`),
    );
    expect(read).toHaveBeenCalledTimes(8);
    expect(altFromFileName('IMG_0042.heic')).toBe('IMG 0042');
  });

  test('an oversized body, a store refusal and a store failure each become a note with a plain reason', async () => {
    let calls = 0;
    __setDeckUploadAssetDepsForTest({
      convexQuery: (async (_fn: unknown, args: any) => rows[args.uploadId]) as any,
      fetch: (async (url: string) => {
        if (url.endsWith('/heavy'))
          return {
            ok: true,
            headers: new Headers({ 'content-length': String(20 * 1024 * 1024) }),
            arrayBuffer: async () => png.buffer,
          };
        if (url.endsWith('/wide'))
          return {
            ok: true,
            headers: new Headers(),
            arrayBuffer: async () => new ArrayBuffer(9 * 1024 * 1024),
          };
        return new Response(png, { status: 200 });
      }) as any,
      storeDeckAsset: (async () => {
        calls += 1;
        if (calls === 1) throw new DeckAssetError('Use a PNG, JPEG, WebP or GIF image.', 415);
        throw new Error('storage offline');
      }) as any,
    });
    const result = await assetsFromUploads('user-1', ['heavy', 'wide', 'reject', 'boom']);
    expect(result.assets).toEqual([]);
    expect(result.notes).toEqual([
      'heavy.png was skipped. The image is larger than 8 MB.',
      'wide.png was skipped. The image is larger than 8 MB.',
      'reject.png was skipped. Use a PNG, JPEG, WebP or GIF image.',
      'boom.png was skipped. The image could not be stored.',
    ]);
  });
});
