/**
 * Image upload for the slide editor. The route stores the file as an owned
 * asset and answers with the reference the deck model keeps. A failure
 * surfaces the server's own message so the user sees why.
 */
export interface UploadedDeckAsset {
  assetId: string;
  src: string;
  width?: number;
  height?: number;
  aspect?: number;
  mime?: string;
}

export const DECK_ASSET_ROUTE = '/api/documents/assets';
/**
 * Mirrors `MAX_DECK_ASSET_BYTES` in `lib/documents/deck-asset-store.ts`. That
 * module needs Node and Convex, so the client keeps its own copy; the deck
 * artwork test asserts the two stay equal.
 */
export const MAX_DECK_ASSET_BYTES = 8 * 1024 * 1024;

export async function uploadDeckAsset(
  file: File,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<UploadedDeckAsset> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > MAX_DECK_ASSET_BYTES) throw new Error('The image is larger than 8 MB.');
  const body = new FormData();
  body.append('file', file, file.name);
  const response = await fetchImpl(DECK_ASSET_ROUTE, { method: 'POST', body });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message =
      (typeof payload.error === 'string' && payload.error) ||
      (typeof payload.message === 'string' && payload.message) ||
      (text && text.length < 300 ? text : '') ||
      `Upload failed (${response.status}).`;
    throw new Error(message);
  }
  if (typeof payload.assetId !== 'string' || typeof payload.src !== 'string')
    throw new Error('The upload did not return an asset.');
  const width = typeof payload.width === 'number' ? payload.width : undefined;
  const height = typeof payload.height === 'number' ? payload.height : undefined;
  const aspect =
    typeof payload.aspect === 'number' && payload.aspect > 0
      ? payload.aspect
      : width && height
        ? width / height
        : undefined;
  return {
    assetId: payload.assetId,
    src: payload.src,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(aspect ? { aspect } : {}),
    ...(typeof payload.mime === 'string' ? { mime: payload.mime } : {}),
  };
}

/**
 * Public-domain artwork for a slide. The search route ranks the curated
 * pool (and the museums when asked); the import route copies one image into
 * an owned asset with attribution. Both helpers take a fetch for tests.
 */
export interface DeckArtworkCandidate {
  key: string;
  provider: 'pool' | 'met' | 'cleveland' | 'aic' | 'smk';
  title: string;
  artist: string;
  date: string;
  credit: string;
  source: string;
  sourceUrl: string;
  license: string;
  imageUrl: string;
  previewUrl: string;
  style?: string;
  palette?: string[];
  accentHue?: number;
}

export interface DeckArtworkAttribution {
  title: string;
  artist: string;
  date: string;
  credit: string;
  source: string;
  sourceUrl: string;
  license: string;
  style?: string;
}

export interface ImportedDeckArtwork extends UploadedDeckAsset {
  attribution: DeckArtworkAttribution;
}

export interface DeckArtworkQuery {
  text?: string;
  styles?: string[];
  hue?: number;
  count?: number;
  seed?: string;
  live?: boolean;
}

export const ARTWORK_SEARCH_ROUTE = '/api/documents/artworks';
export const ARTWORK_IMPORT_ROUTE = '/api/documents/artworks/import';

/**
 * Styles that sit well with each built-in deck direction. Mirrors
 * `stylesForDirection` in `lib/documents/deck-art.ts`, which the client
 * cannot import (it reaches the image pipeline); the artwork test pins them.
 */
export { ARTWORK_STYLES_FOR_DIRECTION } from '@/lib/documents/deck-art-shared';

/** The largest share of the slide an inserted artwork takes. */
export const ARTWORK_MAX_WIDTH = 60;
export const ARTWORK_MAX_HEIGHT = 80;

function readPayload(text: string): Record<string, unknown> {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function serverMessage(payload: Record<string, unknown>, text: string, fallback: string) {
  return (
    (typeof payload.error === 'string' && payload.error) ||
    (typeof payload.message === 'string' && payload.message) ||
    (text && text.length < 300 ? text : '') ||
    fallback
  );
}

export function artworkSearchUrl(query: DeckArtworkQuery) {
  const params = new URLSearchParams();
  if (query.text?.trim()) params.set('q', query.text.trim());
  for (const style of query.styles ?? []) params.append('style', style);
  if (typeof query.hue === 'number' && Number.isFinite(query.hue))
    params.set('hue', String(Math.round(query.hue)));
  if (query.count) params.set('count', String(query.count));
  if (query.seed) params.set('seed', query.seed);
  if (query.live) params.set('live', '1');
  const search = params.toString();
  return search ? `${ARTWORK_SEARCH_ROUTE}?${search}` : ARTWORK_SEARCH_ROUTE;
}

export async function searchDeckArtworks(
  query: DeckArtworkQuery,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  signal?: AbortSignal,
): Promise<DeckArtworkCandidate[]> {
  const response = await fetchImpl(artworkSearchUrl(query), { signal });
  const text = await response.text();
  const payload = readPayload(text);
  if (!response.ok) throw new Error(serverMessage(payload, text, `Search failed (${response.status}).`));
  return Array.isArray(payload.artworks) ? (payload.artworks as DeckArtworkCandidate[]) : [];
}

export async function importDeckArtwork(
  candidate: DeckArtworkCandidate,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<ImportedDeckArtwork> {
  const response = await fetchImpl(ARTWORK_IMPORT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(candidate),
  });
  const text = await response.text();
  const payload = readPayload(text);
  if (!response.ok) throw new Error(serverMessage(payload, text, `Import failed (${response.status}).`));
  const asset = (payload.asset ?? payload) as Record<string, unknown>;
  if (typeof asset.assetId !== 'string' || typeof asset.src !== 'string')
    throw new Error('The import did not return an asset.');
  const width = typeof asset.width === 'number' ? asset.width : undefined;
  const height = typeof asset.height === 'number' ? asset.height : undefined;
  const aspect =
    typeof asset.aspect === 'number' && asset.aspect > 0
      ? asset.aspect
      : width && height
        ? width / height
        : undefined;
  const given = (asset.attribution ?? {}) as Partial<DeckArtworkAttribution>;
  const attribution: DeckArtworkAttribution = {
    title: given.title ?? candidate.title,
    artist: given.artist ?? candidate.artist,
    date: given.date ?? candidate.date,
    credit: given.credit ?? candidate.credit,
    source: given.source ?? candidate.source,
    sourceUrl: given.sourceUrl ?? candidate.sourceUrl,
    license: given.license ?? candidate.license,
    ...((given.style ?? candidate.style) ? { style: given.style ?? candidate.style } : {}),
  };
  return {
    assetId: asset.assetId,
    src: asset.src,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(aspect ? { aspect } : {}),
    ...(typeof asset.mime === 'string' ? { mime: asset.mime } : {}),
    attribution,
  };
}

/** The hue of a hex color in degrees, for artwork searches near the theme accent. */
export function hueFromHex(value: string | undefined): number | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const r = Number.parseInt(match[1].slice(0, 2), 16) / 255;
  const g = Number.parseInt(match[1].slice(2, 4), 16) / 255;
  const b = Number.parseInt(match[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1e-6) return undefined;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return Math.round(hue);
}

/**
 * Where an inserted artwork sits: at most 60 percent wide and 80 percent
 * tall, its own aspect on a 16:9 slide, centered. Percent of the slide.
 */
export function artworkPlacement(aspect: number | undefined) {
  const ratio = aspect && aspect > 0 ? aspect : 4 / 3;
  const widthForHeight = (ARTWORK_MAX_HEIGHT * ratio * 9) / 16;
  const width = Math.round(Math.min(ARTWORK_MAX_WIDTH, widthForHeight) * 10) / 10;
  const height = Math.round((((width / ratio) * 16) / 9) * 10) / 10;
  return {
    x: Math.round(((100 - width) / 2) * 10) / 10,
    y: Math.round(((100 - height) / 2) * 10) / 10,
    width,
    height,
  };
}

export function artworkNoteLine(credit: string, source: string) {
  return `Artwork: ${[credit, source].filter(Boolean).join(', ')}`;
}

/** Speaker notes with the credit line added once. */
export function notesWithArtworkCredit(notes: string | undefined, credit: string, source: string) {
  const line = artworkNoteLine(credit, source);
  const current = notes ?? '';
  if (current.includes(line)) return current;
  return current.trim() ? `${current.replace(/\s+$/, '')}\n${line}` : line;
}
