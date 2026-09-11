import type { ArtStyle } from './art-style';

export type ArtSource = 'met' | 'cleveland' | 'smk' | 'nga';

export interface ArtPiece {
  source: ArtSource;
  sourceName: string;
  sourceUrl: string;
  license: string;
  title: string;
  artist: string;
  date: string;
  year: number | null;
  region: string;
  medium: string;
  movement: string;
  style: ArtStyle;
  imageUrl: string;
  palette: string[];
  accentHue: number;
  accentChroma: number;
}
