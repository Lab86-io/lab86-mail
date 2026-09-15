import type { ArtStyle } from '@/lib/mail/art-style';

/**
 * Artwork facts that both the browser and the server need. This module has
 * no Node dependencies, so the editor can import it directly.
 */

export const ARTWORK_STYLES_FOR_DIRECTION: Record<'editorial' | 'signal', readonly ArtStyle[]> = {
  editorial: ['impressionist', 'romantic', 'dutch-golden-age', 'american', 'east-asian', 'baroque'],
  signal: ['modern', 'art-deco', 'neoclassical', 'east-asian'],
};

/** Styles that sit well with each built-in deck direction. */
export function stylesForDirection(direction: 'editorial' | 'signal' | string): ArtStyle[] {
  return [
    ...(direction === 'signal'
      ? ARTWORK_STYLES_FOR_DIRECTION.signal
      : ARTWORK_STYLES_FOR_DIRECTION.editorial),
  ];
}
