import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { getDeckAsset } from '@/lib/documents/deck-asset-store';
import { documentError } from '@/lib/documents/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Fresh details of one owned image, including its stable storage address. */
export async function GET(_req: NextRequest, context: { params: Promise<{ assetId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { assetId } = await context.params;
    const asset = await getDeckAsset(user.userId, assetId);
    if (!asset) return NextResponse.json({ error: 'That image is not in your files.' }, { status: 404 });
    return NextResponse.json({ asset });
  } catch (error) {
    return documentError(error);
  }
}
