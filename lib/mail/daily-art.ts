import { ART_POOL, type ArtPiece } from './daily-art-pool';

export interface DailyArt {
  imageUrl: string;
  // Ordered alternates tried (client-side, via onerror) when imageUrl fails to
  // load — drawn from OTHER museums first, then bundled local assets last, so
  // the hero is never blank no matter which single source is down.
  fallbacks: string[];
  title: string;
  artist: string;
  date: string;
  credit: string;
  source: string;
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

  if (ART_POOL.length === 0) {
    return {
      imageUrl: locals[0],
      fallbacks: locals.slice(1),
      title: '',
      artist: '',
      date: '',
      credit: '',
      source: '',
    };
  }

  const primary = ART_POOL[hash % ART_POOL.length];
  const alternates = pickAlternates(primary, hash);
  return {
    imageUrl: highResolutionArtUrl(primary.imageUrl),
    fallbacks: [...alternates.map((a) => highResolutionArtUrl(a.imageUrl)), ...locals],
    title: primary.title,
    artist: primary.artist,
    date: primary.date,
    credit: [primary.title, primary.artist, primary.date].filter(Boolean).join(', '),
    source: primary.sourceName,
  };
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
