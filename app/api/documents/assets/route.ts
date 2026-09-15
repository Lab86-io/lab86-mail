import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { DeckAssetError, MAX_DECK_ASSET_BYTES, storeDeckAsset } from '@/lib/documents/deck-asset-store';
import { documentError } from '@/lib/documents/http';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Upload one owned image for a presentation. Multipart field `file`. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-asset-upload',
      limit: 60,
      windowMs: 60_000,
    });
    const length = Number(req.headers.get('content-length') || 0);
    if (length > MAX_DECK_ASSET_BYTES + 4_096)
      return NextResponse.json({ error: 'Images must be 8 MB or smaller.' }, { status: 413 });
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob))
      return NextResponse.json({ error: 'Attach one image as `file`.' }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await storeDeckAsset(user.userId, bytes);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof DeckAssetError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return documentError(error);
  }
}
