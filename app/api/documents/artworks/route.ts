import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { searchArtworks } from '@/lib/documents/deck-art';
import { documentError } from '@/lib/documents/http';
import { ART_STYLES, type ArtStyle } from '@/lib/mail/art-style';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Public-domain artworks for a presentation: `?q=`, `?style=` (repeatable), `?hue=`, `?live=1`. */
export async function GET(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-artwork-search',
      limit: 120,
      windowMs: 60_000,
    });
    const params = req.nextUrl.searchParams;
    const styles = params
      .getAll('style')
      .filter((style): style is ArtStyle => ART_STYLES.includes(style as ArtStyle));
    const hue = Number(params.get('hue'));
    const artworks = await searchArtworks({
      text: params.get('q')?.slice(0, 200) || undefined,
      styles: styles.length ? styles : undefined,
      accentHue: Number.isFinite(hue) && params.get('hue') ? hue : undefined,
      count: Math.min(40, Math.max(1, Number(params.get('count')) || 12)),
      seed: params.get('seed') || undefined,
      live: params.get('live') === '1',
    });
    return NextResponse.json({ artworks });
  } catch (error) {
    return documentError(error);
  }
}
