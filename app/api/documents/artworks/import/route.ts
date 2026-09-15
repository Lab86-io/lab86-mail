import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { importArtwork, isAllowedArtworkImage } from '@/lib/documents/deck-art';
import { DeckAssetError } from '@/lib/documents/deck-asset-store';
import { documentError } from '@/lib/documents/http';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const candidateSchema = z.object({
  key: z.string().min(1).max(200),
  provider: z.enum(['pool', 'met', 'cleveland', 'aic', 'smk']),
  title: z.string().max(500),
  artist: z.string().max(300),
  date: z.string().max(100),
  credit: z.string().max(800),
  source: z.string().max(120),
  sourceUrl: z.string().max(2_000),
  license: z.string().max(120),
  imageUrl: z.string().url().max(2_000),
  previewUrl: z.string().max(2_000),
  style: z.string().max(40).optional(),
});

/** Import one museum image as an owned asset with attribution. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-artwork-import',
      limit: 30,
      windowMs: 60_000,
    });
    const parsed = candidateSchema.safeParse(await req.json());
    if (!parsed.success)
      return NextResponse.json({ error: 'Pick an artwork from the search results.' }, { status: 400 });
    if (!isAllowedArtworkImage(parsed.data.imageUrl))
      return NextResponse.json({ error: 'That image is not from a supported museum.' }, { status: 400 });
    const asset = await importArtwork(user.userId, parsed.data as never);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof DeckAssetError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /museum|fetched|too large/.test(error.message))
      return NextResponse.json({ error: error.message }, { status: 502 });
    return documentError(error);
  }
}
