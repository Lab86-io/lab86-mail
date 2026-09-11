import type { ArtStyle } from './art-style';
import { ART_POOL, type ArtPiece } from './daily-art-pool';
import { LOCAL_ART_PALETTES } from './local-art-palettes';

export interface DailyArtCandidate {
  imageUrl: string;
  title: string;
  artist: string;
  date: string;
  credit: string;
  source: string;
  sourceUrl?: string;
  style?: ArtStyle;
  palette?: string[];
}

export interface DailyArt extends DailyArtCandidate {
  // Ordered alternates tried (client-side, via onerror) when imageUrl fails to
  // load — drawn from OTHER museums first, then bundled local assets last, so
  // the hero is never blank no matter which single source is down.
  fallbacks: string[];
  /** Metadata travels with each fallback so the displayed work is credited. */
  fallbackArt?: DailyArtCandidate[];
}

// Bundled last-resort backstops served from the app's own origin. Absolute URLs
// because the brief renders inside an iframe srcDoc (no base URL to resolve
// relative paths against). These always load whenever the app itself loads.
function publicBase(): string {
  return (
    process.env.LAB86_MAIL_PUBLIC_URL ||
    process.env.MAIL_OS_PUBLIC_URL ||
    'https://mail.lab86.io'
  ).replace(/\/$/, '');
}

function localFallbacks(): string[] {
  const base = publicBase();
  return ['/art/fallback-1.jpg', '/art/fallback-2.jpg', '/art/fallback-3.jpg'].map(
    (path) => `${base}${path}`,
  );
}

// One piece per calendar day, chosen deterministically from the date so every
// user sees the same piece and it stays stable across the day's morning and
// evening editions (and in history) — no shared storage needed.
export function getDailyArt(at: number = Date.now()): DailyArt {
  const day = new Date(at);
  const key = `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}-${day.getUTCDate()}`;
  const hash = hashString(key);
  const locals = localFallbacks();
  const localArt: DailyArtCandidate[] = locals.map((imageUrl, index) => ({
    imageUrl,
    title: '',
    artist: '',
    date: '',
    credit: '',
    source: '',
    style: 'modern',
    palette: [...LOCAL_ART_PALETTES[index]],
  }));

  if (ART_POOL.length === 0) {
    return {
      imageUrl: locals[0],
      fallbacks: locals.slice(1),
      title: '',
      artist: '',
      date: '',
      credit: '',
      source: '',
      fallbackArt: localArt.slice(1),
    };
  }

  // Choose the museum first so a larger collection cannot crowd out the others.
  const sources = [...new Set(ART_POOL.map((piece) => piece.source))];
  const source = sources[hash % sources.length];
  const collection = ART_POOL.filter((piece) => piece.source === source);
  const primary = collection[hashString(`art:${key}`) % collection.length];
  const alternates = pickAlternates(primary, hash).map(artCandidate);
  const fallbackArt = [...alternates, ...localArt];
  return {
    ...artCandidate(primary),
    fallbacks: fallbackArt.map((piece) => piece.imageUrl),
    fallbackArt,
  };
}

export function artCandidate(piece: ArtPiece): DailyArtCandidate {
  return {
    imageUrl: highResolutionArtUrl(piece.imageUrl),
    title: piece.title,
    artist: piece.artist,
    date: piece.date,
    credit: [piece.title, piece.artist, piece.date].filter(Boolean).join(', '),
    source: piece.sourceName,
    sourceUrl: piece.sourceUrl,
    style: piece.style,
    palette: [...piece.palette],
  };
}

export function dailyArtCandidates(art: DailyArt): DailyArtCandidate[] {
  return [
    art,
    ...art.fallbacks.map(
      (imageUrl) =>
        art.fallbackArt?.find((piece) => piece.imageUrl === imageUrl) ?? {
          imageUrl,
          title: '',
          artist: '',
          date: '',
          credit: '',
          source: '',
        },
    ),
  ];
}

export function highResolutionArtUrl(url: string): string {
  if (url.includes('images.metmuseum.org/')) {
    return url.replace('/web-large/', '/original/');
  }
  if (url.includes('openaccess-cdn.clevelandart.org/')) {
    return url.replace(/_web(\.[a-z0-9]+)$/i, '_print$1');
  }
  return url;
}

// Up to two alternates from DIFFERENT museums than the primary (and each other),
// walked deterministically from the day's hash so the fallback chain is stable.
function pickAlternates(primary: ArtPiece, hash: number): ArtPiece[] {
  const out: ArtPiece[] = [];
  const usedSources = new Set([primary.source]);
  for (let i = 1; i <= ART_POOL.length && out.length < 2; i += 1) {
    const candidate = ART_POOL[(hash + i) % ART_POOL.length];
    if (usedSources.has(candidate.source)) continue;
    usedSources.add(candidate.source);
    out.push(candidate);
  }
  return out;
}

// FNV-1a — small, stable, dependency-free.
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
