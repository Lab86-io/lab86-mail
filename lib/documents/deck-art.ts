import { hex, paletteFromPixels, pickAccent } from '@/lib/mail/art-palette';
import type { ArtStyle } from '@/lib/mail/art-style';
import { highResolutionArtUrl } from '@/lib/mail/daily-art';
import { ART_POOL, type ArtPiece } from '@/lib/mail/daily-art-pool';
import { type DeckAsset, storeDeckAsset } from './deck-asset-store';

/**
 * Artwork for presentations: public-domain paintings and prints from the
 * museums the app already draws on (The Met, Cleveland, SMK, National
 * Gallery of Art, Art Institute of Chicago). The curated pool answers first
 * with palettes and styles already known; live searches widen the field.
 * Every import becomes an owned asset with attribution, never a hot link.
 */

export type ArtworkProvider = 'pool' | 'met' | 'cleveland' | 'aic' | 'smk';

export interface ArtworkCandidate {
  key: string;
  provider: ArtworkProvider;
  title: string;
  artist: string;
  date: string;
  /** "Title, Artist, Date" for captions and notes. */
  credit: string;
  source: string;
  sourceUrl: string;
  license: string;
  /** Full-size image for import. */
  imageUrl: string;
  /** Smaller image for pickers. */
  previewUrl: string;
  style?: ArtStyle;
  palette?: string[];
  accentHue?: number;
}

export interface ArtworkQuery {
  text?: string;
  styles?: ArtStyle[];
  /** Theme accent hue in degrees; closer artworks score higher. */
  accentHue?: number;
  count?: number;
  /** Deterministic variety: the same seed returns the same order. */
  seed?: string;
  exclude?: string[];
}

export interface ArtworkAttribution {
  title: string;
  artist: string;
  date: string;
  credit: string;
  source: string;
  sourceUrl: string;
  license: string;
  style?: string;
}

/** Hosts that serve the museums' own images. Imports refuse anything else. */
export const ARTWORK_IMAGE_HOSTS = [
  'images.metmuseum.org',
  'openaccess-cdn.clevelandart.org',
  'api.nga.gov',
  'iip.smk.dk',
  'api.smk.dk',
  'www.artic.edu',
  'iiif.smk.dk',
];

export const MAX_ARTWORK_EDGE = 2400;

export { ARTWORK_STYLES_FOR_DIRECTION, stylesForDirection } from './deck-art-shared';

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokens(text: string | undefined) {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function hueDistance(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function candidateFromPiece(piece: ArtPiece): ArtworkCandidate {
  return {
    key: `pool:${piece.sourceUrl}`,
    provider: 'pool',
    title: piece.title,
    artist: piece.artist,
    date: piece.date,
    credit: [piece.title, piece.artist, piece.date].filter(Boolean).join(', '),
    source: piece.sourceName,
    sourceUrl: piece.sourceUrl,
    license: piece.license,
    imageUrl: highResolutionArtUrl(piece.imageUrl),
    previewUrl: piece.imageUrl,
    style: piece.style,
    palette: [...piece.palette],
    accentHue: piece.accentHue,
  };
}

/** Score a piece against the query. Higher is better; zero means no signal. */
export function scoreArtwork(candidate: ArtworkCandidate, query: ArtworkQuery): number {
  let score = 0;
  if (query.styles?.length && candidate.style) {
    const index = query.styles.indexOf(candidate.style);
    if (index >= 0) score += 3 - Math.min(2, index * 0.5);
  }
  const wanted = tokens(query.text);
  if (wanted.length) {
    const title = tokens(candidate.title);
    const other = tokens(`${candidate.artist} ${candidate.date}`);
    for (const token of wanted) {
      if (title.some((t) => t.startsWith(token) || token.startsWith(t))) score += 3;
      else if (other.includes(token)) score += 1;
    }
  }
  if (query.accentHue !== undefined && candidate.accentHue !== undefined)
    score += 1.5 * (1 - hueDistance(query.accentHue, candidate.accentHue) / 180);
  return score;
}

/** Curated pool search: deterministic for a seed, varied across seeds. */
export function searchArtPool(query: ArtworkQuery = {}): ArtworkCandidate[] {
  const count = Math.max(1, Math.min(40, query.count ?? 8));
  const exclude = new Set(query.exclude ?? []);
  const seed = query.seed ?? '';
  const scored = ART_POOL.map(candidateFromPiece)
    .filter((candidate) => !exclude.has(candidate.key))
    .map((candidate) => ({
      candidate,
      score: scoreArtwork(candidate, query) + (hashString(`${seed}:${candidate.key}`) % 1000) / 4000,
    }));
  const hasSignal = Boolean(query.text || query.styles?.length || query.accentHue !== undefined);
  return scored
    .filter((item) => !hasSignal || item.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((item) => item.candidate);
}

type FetchLike = typeof fetch;

async function json(fetchImpl: FetchLike, url: string): Promise<any> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

async function searchMet(text: string, fetchImpl: FetchLike, limit: number): Promise<ArtworkCandidate[]> {
  const search = await json(
    fetchImpl,
    `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&isPublicDomain=true&q=${encodeURIComponent(text)}`,
  );
  const ids: number[] = (search.objectIDs ?? []).slice(0, limit);
  const objects = await Promise.all(
    ids.map((id) =>
      json(fetchImpl, `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`).catch(
        () => null,
      ),
    ),
  );
  return objects
    .filter((o) => o?.isPublicDomain && o.primaryImage)
    .map((o) => ({
      key: `met:${o.objectID}`,
      provider: 'met' as const,
      title: o.title || 'Untitled',
      artist: o.artistDisplayName || '',
      date: o.objectDate || '',
      credit: [o.title, o.artistDisplayName, o.objectDate].filter(Boolean).join(', '),
      source: 'The Met',
      sourceUrl: o.objectURL || `https://www.metmuseum.org/art/collection/search/${o.objectID}`,
      license: 'Public domain',
      imageUrl: o.primaryImage,
      previewUrl: o.primaryImageSmall || o.primaryImage,
    }));
}

async function searchCleveland(
  text: string,
  fetchImpl: FetchLike,
  limit: number,
): Promise<ArtworkCandidate[]> {
  const result = await json(
    fetchImpl,
    `https://openaccess-api.clevelandart.org/api/artworks/?q=${encodeURIComponent(text)}&has_image=1&cc0=1&limit=${limit}`,
  );
  return (result.data ?? [])
    .filter((o: any) => o.images?.web?.url)
    .map((o: any) => ({
      key: `cleveland:${o.id}`,
      provider: 'cleveland' as const,
      title: o.title || 'Untitled',
      artist: o.creators?.[0]?.description || '',
      date: o.creation_date || '',
      credit: [o.title, o.creators?.[0]?.description, o.creation_date].filter(Boolean).join(', '),
      source: 'Cleveland Museum of Art',
      sourceUrl: o.url || '',
      license: 'CC0',
      imageUrl: o.images?.print?.url || o.images.web.url,
      previewUrl: o.images.web.url,
    }));
}

async function searchAic(text: string, fetchImpl: FetchLike, limit: number): Promise<ArtworkCandidate[]> {
  const result = await json(
    fetchImpl,
    `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(text)}&query[term][is_public_domain]=true&fields=id,title,artist_display,date_display,image_id&limit=${limit}`,
  );
  return (result.data ?? [])
    .filter((o: any) => o.image_id)
    .map((o: any) => ({
      key: `aic:${o.id}`,
      provider: 'aic' as const,
      title: o.title || 'Untitled',
      artist: o.artist_display || '',
      date: o.date_display || '',
      credit: [o.title, o.artist_display, o.date_display].filter(Boolean).join(', '),
      source: 'Art Institute of Chicago',
      sourceUrl: `https://www.artic.edu/artworks/${o.id}`,
      license: 'CC0',
      imageUrl: `https://www.artic.edu/iiif/2/${o.image_id}/full/1686,/0/default.jpg`,
      previewUrl: `https://www.artic.edu/iiif/2/${o.image_id}/full/843,/0/default.jpg`,
    }));
}

async function searchSmk(text: string, fetchImpl: FetchLike, limit: number): Promise<ArtworkCandidate[]> {
  const result = await json(
    fetchImpl,
    `https://api.smk.dk/api/v1/art/search/?keys=${encodeURIComponent(text)}&filters=[has_image:true],[public_domain:true]&rows=${limit}`,
  );
  return (result.items ?? [])
    .filter((o: any) => o.image_native || o.image_thumbnail)
    .map((o: any) => ({
      key: `smk:${o.object_number || o.id}`,
      provider: 'smk' as const,
      title: o.titles?.[0]?.title || 'Untitled',
      artist: o.production?.[0]?.creator || o.artist?.[0] || '',
      date: o.production_date?.[0]?.period || '',
      credit: [
        o.titles?.[0]?.title,
        o.production?.[0]?.creator || o.artist?.[0],
        o.production_date?.[0]?.period,
      ]
        .filter(Boolean)
        .join(', '),
      source: 'SMK',
      sourceUrl: `https://open.smk.dk/en/artwork/image/${encodeURIComponent(o.object_number || o.id)}`,
      license: 'Public domain',
      imageUrl: o.image_native || o.image_thumbnail,
      previewUrl: o.image_thumbnail || o.image_native,
    }));
}

const providers = { met: searchMet, cleveland: searchCleveland, aic: searchAic, smk: searchSmk } as const;

export interface LiveSearchOptions {
  fetch?: FetchLike;
  providers?: Array<keyof typeof providers>;
  perProvider?: number;
}

/** Live museum search. Each provider is optional; a failure drops that provider only. */
export async function searchArtLive(
  text: string,
  options: LiveSearchOptions = {},
): Promise<ArtworkCandidate[]> {
  const fetchImpl = options.fetch ?? fetch;
  const names = options.providers ?? (Object.keys(providers) as Array<keyof typeof providers>);
  const limit = Math.max(1, Math.min(20, options.perProvider ?? 6));
  const results = await Promise.all(
    names.map((name) => providers[name](text, fetchImpl, limit).catch(() => [] as ArtworkCandidate[])),
  );
  const seen = new Set<string>();
  return results.flat().filter((candidate) => {
    if (seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
}

/** Pool first, then live results for the same text, deduplicated by source URL. */
export async function searchArtworks(
  query: ArtworkQuery & { live?: boolean },
  options: LiveSearchOptions = {},
): Promise<ArtworkCandidate[]> {
  const count = Math.max(1, Math.min(40, query.count ?? 12));
  const pool = searchArtPool({ ...query, count });
  if (!query.live || !query.text?.trim()) return pool;
  const live = await searchArtLive(query.text, options);
  const seen = new Set(pool.map((candidate) => candidate.sourceUrl));
  const merged = [...pool];
  for (const candidate of live) {
    if (seen.has(candidate.sourceUrl)) continue;
    seen.add(candidate.sourceUrl);
    merged.push(candidate);
  }
  return merged.slice(0, count);
}

export function isAllowedArtworkImage(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ARTWORK_IMAGE_HOSTS.includes(parsed.host);
  } catch {
    return false;
  }
}

export interface PreparedArtwork {
  bytes: Uint8Array;
  width: number;
  height: number;
  palette: string[];
  accentHue: number;
}

/** Decode, bound to the maximum edge, re-encode as JPEG, and read a palette. */
export async function prepareArtworkImage(source: Uint8Array): Promise<PreparedArtwork> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(source));
  const scale = Math.min(1, MAX_ARTWORK_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  const sample = createCanvas(48, 27);
  sample.getContext('2d').drawImage(image, 0, 0, 48, 27);
  const data = sample.getContext('2d').getImageData(0, 0, 48, 27).data;
  const pixels: Array<[number, number, number]> = [];
  for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
  const swatches = paletteFromPixels(pixels, 5);
  const accent = pickAccent(swatches);
  return {
    bytes: new Uint8Array(canvas.toBuffer('image/jpeg', 86)),
    width,
    height,
    palette: swatches.map((swatch) => hex(swatch.rgb)),
    accentHue: accent.hue,
  };
}

const defaultDependencies = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  prepare: prepareArtworkImage,
  store: storeDeckAsset,
};
let dependencies = defaultDependencies;
export function __setDeckArtDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export interface ImportedArtwork extends DeckAsset {
  attribution: ArtworkAttribution;
  palette: string[];
  accentHue: number;
}

/** Fetch a museum image, bound it, and store it as an owned asset with attribution. */
export async function importArtwork(userId: string, candidate: ArtworkCandidate): Promise<ImportedArtwork> {
  if (!isAllowedArtworkImage(candidate.imageUrl))
    throw new Error('That image is not from a supported museum.');
  const response = await dependencies.fetch(candidate.imageUrl, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`The museum image could not be fetched (${response.status}).`);
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength > 40 * 1024 * 1024) throw new Error('The museum image is too large to import.');
  const prepared = await dependencies.prepare(raw);
  const attribution: ArtworkAttribution = {
    title: candidate.title,
    artist: candidate.artist,
    date: candidate.date,
    credit: candidate.credit,
    source: candidate.source,
    sourceUrl: candidate.sourceUrl,
    license: candidate.license,
    ...(candidate.style ? { style: candidate.style } : {}),
  };
  const asset = await dependencies.store(userId, prepared.bytes, attribution);
  return { ...asset, attribution, palette: prepared.palette, accentHue: prepared.accentHue };
}
