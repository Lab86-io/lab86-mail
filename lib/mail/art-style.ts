/* The style of a painting, read from its date and its origin. The masthead
 * uses it to hang the day's art in a frame of the same period. Coarse on
 * purpose: a frame only has to feel right, not pass a curator. */

export type ArtStyle =
  | 'gothic'
  | 'art-deco'
  | 'renaissance'
  | 'dutch-golden-age'
  | 'baroque'
  | 'rococo'
  | 'neoclassical'
  | 'romantic'
  | 'american'
  | 'impressionist'
  | 'modern'
  | 'east-asian';

export const ART_STYLES: readonly ArtStyle[] = [
  'gothic',
  'art-deco',
  'renaissance',
  'dutch-golden-age',
  'baroque',
  'rococo',
  'neoclassical',
  'romantic',
  'american',
  'impressionist',
  'modern',
  'east-asian',
];

export interface ArtStyleInput {
  /** Year the work was begun, when known. */
  year?: number | null;
  /** Nationality, culture, or place of origin, in any wording the museum used. */
  region?: string | null;
  medium?: string | null;
  title?: string | null;
  /** An explicit museum movement wins over broad date-based inference. */
  movement?: string | null;
}

const EAST_ASIAN = /japan|china|chinese|korea|edo|ukiyo|meiji|qing|ming|song dynasty|kano|nihonga/i;
const LOW_COUNTRIES = /dutch|holland|netherland|nederland|flemish|flanders|flamsk|belgi/i;
const AMERICAN = /american|united states|\busa?\b/i;

export function artStyleFor(input: ArtStyleInput): ArtStyle {
  const movement = input.movement ?? '';
  if (/art[ -]?deco/i.test(movement)) return 'art-deco';
  if (/gothic|gotisk|medieval/i.test(movement)) return 'gothic';
  if (/cubis|abstract|expressionis|surrealis|bauhaus|modernis|suprematis|constructivis/i.test(movement))
    return 'modern';
  if (/impressionis|pointillis/i.test(movement)) return 'impressionist';
  if (/renaissance/i.test(movement)) return 'renaissance';
  if (/baroque/i.test(movement)) return 'baroque';
  if (/rococo/i.test(movement)) return 'rococo';
  const region = `${input.region ?? ''} ${input.medium ?? ''} ${input.title ?? ''}`;
  if (EAST_ASIAN.test(region)) return 'east-asian';
  const year = typeof input.year === 'number' && Number.isFinite(input.year) ? input.year : null;
  if (year === null) return 'romantic';
  if (year < 1450) return 'gothic';
  if (year < 1600) return 'renaissance';
  if (year < 1720) return LOW_COUNTRIES.test(region) ? 'dutch-golden-age' : 'baroque';
  if (year < 1780) return 'rococo';
  if (year < 1830) return 'neoclassical';
  if (year < 1870) return AMERICAN.test(region) ? 'american' : 'romantic';
  if (year < 1910) return AMERICAN.test(region) ? 'american' : 'impressionist';
  return 'modern';
}

/** Reads the first four-digit year out of a museum date string. */
export function yearFromDate(value: string | null | undefined): number | null {
  const match = String(value ?? '').match(/(1[0-9]{3}|20[0-9]{2})/);
  return match ? Number(match[1]) : null;
}
