import type { CSSProperties } from 'react';
import type { ArtStyle } from '../mail/art-style';
import { getDailyArt } from '../mail/daily-art';

/* The daily artwork hangs in a real picture frame. Frames include museum photographs
 * and original vector mouldings with a transparent opening, applied with CSS border-image
 * so it fits any painting size. The slice values are the pixel size of each
 * frame side in the asset; the corners scale as one piece and the sides tile.
 * The frame matches the art style and changes with the day, on the same seed family as the art, so the
 * morning and evening editions and every surface agree on one frame. */

export type BriefFrameId =
  | 'david-gilt'
  | 'robert-gilt'
  | 'rijks-french-gilt'
  | 'rijks-walnut-gilt'
  | 'rijks-glass-gilt'
  | 'gothic-cathedral'
  | 'gothic-quatrefoil'
  | 'gothic-thorn'
  | 'gothic-ebony'
  | 'gothic-tracery'
  | 'gothic-reliquary'
  | 'modern-graphite'
  | 'modern-ivory'
  | 'modern-oak'
  | 'modern-aluminum'
  | 'modern-walnut'
  | 'deco-stepped'
  | 'deco-fan'
  | 'deco-sunburst'
  | 'deco-emerald'
  | 'deco-champagne';

export interface BriefFrame {
  id: BriefFrameId;
  family: 'museum' | 'gothic' | 'modern' | 'art-deco';
  styles: readonly ArtStyle[];
  /** Absolute path under /public. */
  src: string;
  /** Asset pixel size, for tests and for the dev gallery. */
  width: number;
  height: number;
  /** border-image-slice in asset pixels: top, right, bottom, left. */
  slice: readonly [number, number, number, number];
  /** Multiplies the shared moulding width. Heavy carved frames read wider. */
  widthScale: number;
  /** One line for the credit strip. */
  title: string;
  credit: string;
  license: string;
}

export const BRIEF_FRAMES: readonly BriefFrame[] = [
  {
    id: 'david-gilt',
    family: 'museum',
    styles: ['neoclassical', 'renaissance', 'baroque'],
    src: '/frames/david-gilt.png',
    width: 1235,
    height: 1400,
    slice: [107, 101, 103, 106],
    widthScale: 1,
    title: 'Carved gilt frame, Mars Disarmed by Venus (1824)',
    credit: 'Photo Sailko, Wikimedia Commons',
    license: 'CC BY 3.0',
  },
  {
    id: 'robert-gilt',
    family: 'museum',
    styles: ['rococo', 'romantic'],
    src: '/frames/robert-gilt.png',
    width: 779,
    height: 567,
    slice: [66, 68, 64, 65],
    widthScale: 0.95,
    title: 'Gilt frame after Hubert Robert',
    credit: 'Wikimedia Commons',
    license: 'Public domain',
  },
  {
    id: 'rijks-french-gilt',
    family: 'museum',
    styles: ['impressionist', 'rococo'],
    src: '/frames/rijks-french-gilt.png',
    width: 594,
    height: 649,
    slice: [130, 136, 125, 129],
    widthScale: 1.1,
    title: '19th-century French carved gilt frame (RP-L-137)',
    credit: 'Rijksmuseum, Amsterdam',
    license: 'CC0',
  },
  {
    id: 'rijks-walnut-gilt',
    family: 'museum',
    styles: ['dutch-golden-age', 'american', 'romantic'],
    src: '/frames/rijks-walnut-gilt.png',
    width: 1400,
    height: 1188,
    slice: [92, 89, 89, 87],
    widthScale: 0.9,
    title: 'Stained profile frame with gilt sight edge (SK-L-1856)',
    credit: 'Rijksmuseum, Amsterdam',
    license: 'CC0',
  },
  {
    id: 'rijks-glass-gilt',
    family: 'museum',
    styles: ['impressionist', 'neoclassical', 'american'],
    src: '/frames/rijks-glass-gilt.png',
    width: 1400,
    height: 1259,
    slice: [86, 81, 79, 80],
    widthScale: 1,
    title: 'Gilt frame with glass plate (RP-L-530)',
    credit: 'Rijksmuseum, Amsterdam',
    license: 'CC0',
  },
  {
    id: 'gothic-cathedral',
    src: '/frames/gothic-cathedral.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 1.05,
    title: 'Cathedral · black lancet carving',
    family: 'gothic',
    styles: ['gothic', 'renaissance'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'gothic-quatrefoil',
    src: '/frames/gothic-quatrefoil.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 1.05,
    title: 'Quatrefoil · carved blackwood',
    family: 'gothic',
    styles: ['gothic', 'baroque'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'gothic-thorn',
    src: '/frames/gothic-thorn.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 1,
    title: 'Thorn · black vine carving',
    family: 'gothic',
    styles: ['gothic', 'romantic'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'gothic-ebony',
    src: '/frames/gothic-ebony.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.9,
    title: 'Ebony · rippled Dutch profile',
    family: 'gothic',
    styles: ['dutch-golden-age', 'baroque'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'gothic-tracery',
    src: '/frames/gothic-tracery.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 1.05,
    title: 'Tracery · blue-black fretwork',
    family: 'gothic',
    styles: ['gothic', 'renaissance'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'gothic-reliquary',
    src: '/frames/gothic-reliquary.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 1.1,
    title: 'Reliquary · black and antique brass',
    family: 'gothic',
    styles: ['gothic', 'baroque', 'neoclassical'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'modern-graphite',
    src: '/frames/modern-graphite.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.38,
    title: 'Graphite · slim gallery frame',
    family: 'modern',
    styles: ['modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'modern-ivory',
    src: '/frames/modern-ivory.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.45,
    title: 'Ivory · matte gallery frame',
    family: 'modern',
    styles: ['modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'modern-oak',
    src: '/frames/modern-oak.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.55,
    title: 'Oak · natural floating frame',
    family: 'modern',
    styles: ['modern', 'east-asian', 'american'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'modern-aluminum',
    src: '/frames/modern-aluminum.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.3,
    title: 'Aluminum · brushed gallery frame',
    family: 'modern',
    styles: ['modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'modern-walnut',
    src: '/frames/modern-walnut.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.5,
    title: 'Walnut · dark floating frame',
    family: 'modern',
    styles: ['modern', 'east-asian'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'deco-stepped',
    src: '/frames/deco-stepped.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.8,
    title: 'Metropolis · stepped brass',
    family: 'art-deco',
    styles: ['art-deco', 'modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'deco-fan',
    src: '/frames/deco-fan.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.9,
    title: 'Palmette · black and gold fans',
    family: 'art-deco',
    styles: ['art-deco', 'modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'deco-sunburst',
    src: '/frames/deco-sunburst.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.85,
    title: 'Solstice · brass sunbursts',
    family: 'art-deco',
    styles: ['art-deco', 'modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'deco-emerald',
    src: '/frames/deco-emerald.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.9,
    title: 'Emerald · lacquer and chevrons',
    family: 'art-deco',
    styles: ['art-deco', 'modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
  {
    id: 'deco-champagne',
    src: '/frames/deco-champagne.svg',
    width: 240,
    height: 240,
    slice: [80, 80, 80, 80],
    widthScale: 0.8,
    title: 'Champagne · stepped silver-gold',
    family: 'art-deco',
    styles: ['art-deco', 'modern'],
    credit: 'Albatross original design',
    license: 'Original artwork',
  },
];

export function briefFrameById(id: string | null | undefined): BriefFrame | null {
  if (!id) return null;
  return BRIEF_FRAMES.find((frame) => frame.id === id) ?? null;
}

/** Deterministic daily variation within the frames suited to the displayed art. */
export function briefFrameForDay(at: number, timezone?: string, style?: ArtStyle): BriefFrame {
  const key = `frame:${dayKey(at, timezone)}`;
  const genre = style ?? getDailyArt(at).style ?? 'romantic';
  const matches = BRIEF_FRAMES.filter((frame) => frame.styles.includes(genre));
  const candidates = matches.length ? matches : BRIEF_FRAMES.filter((frame) => frame.family === 'modern');
  return candidates[hashString(key) % candidates.length];
}

/** Custom properties the moulding CSS reads. */
export function briefFrameStyle(frame: BriefFrame): CSSProperties {
  return {
    '--brief-frame-src': `url("${frame.src}")`,
    '--brief-frame-slice': frame.slice.join(' '),
    '--brief-frame-scale': String(frame.widthScale),
  } as CSSProperties;
}

export function briefFrameCreditLine(frame: BriefFrame): string {
  return `Frame: ${frame.title} · ${frame.credit}`;
}

function dayKey(at: number, timezone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(at));
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${read('year')}-${read('month')}-${read('day')}`;
  } catch {
    const day = new Date(at);
    return `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}-${day.getUTCDate()}`;
  }
}

// FNV-1a, the same family the art picker uses.
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
