import { ART_POOL } from './daily-art-pool';

export interface DailyArt {
  imageUrl: string;
  title: string;
  artist: string;
  date: string;
  credit: string;
  source: string;
}

// One landscape per calendar day, chosen deterministically from the date so
// every user sees the same piece and it stays stable across the day's morning
// and evening editions (and in history) — no shared storage needed.
export function getDailyArt(at: number = Date.now()): DailyArt {
  const day = new Date(at);
  const key = `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}-${day.getUTCDate()}`;
  const piece = ART_POOL[hashString(key) % ART_POOL.length];
  return {
    // AIC IIIF: a wide 1686px render, ample for a full-bleed masthead.
    imageUrl: `https://www.artic.edu/iiif/2/${piece.imageId}/full/1686,/0/default.jpg`,
    title: piece.title,
    artist: piece.artist,
    date: piece.date,
    credit: [piece.title, piece.artist, piece.date].filter(Boolean).join(', '),
    source: 'Art Institute of Chicago',
  };
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
