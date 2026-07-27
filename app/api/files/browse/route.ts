import { type NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { browseCloudFiles } from '@/lib/files/browse';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function cloudFileBrowseErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Could not load cloud files.';
  if (/invalid onedrive page cursor/iu.test(message)) {
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
  if (/access expired|reconnect/iu.test(message)) {
    return NextResponse.json({ ok: false, error: message, code: 'RECONNECT_REQUIRED' }, { status: 409 });
  }
  return NextResponse.json(
    { ok: false, error: message.slice(0, 200) },
    { status: /not found/iu.test(message) ? 404 : 502 },
  );
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'cloud_file_browse',
      limit: 120,
      windowMs: 60_000,
    });
    const connectionId = (req.nextUrl.searchParams.get('connectionId') || '').trim();
    if (!connectionId) {
      return NextResponse.json({ ok: false, error: 'connectionId required' }, { status: 400 });
    }
    const page = await browseCloudFiles({
      userId: user.userId,
      connectionId,
      folderId: req.nextUrl.searchParams.get('folderId') || undefined,
      query: req.nextUrl.searchParams.get('q') || undefined,
      cursor: req.nextUrl.searchParams.get('cursor') || undefined,
    });
    return NextResponse.json({ ok: true, ...page });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }
    return cloudFileBrowseErrorResponse(error);
  }
}
