import type { NextRequest } from 'next/server';
import { captureWork } from '@/lib/albatross/capture-work';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status });
}

export async function POST(req: NextRequest) {
  let body: {
    rawText?: string;
    transcript?: string;
    source?: 'text' | 'voice' | 'chat';
    timezone?: string;
    areaId?: string;
    reviewedItems?: Array<{ title?: string; rawText?: string }>;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }
  const rawText = String(body.rawText || '').trim();
  if (!rawText) return json(400, { ok: false, error: 'rawText required' });
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-capture-v2',
      limit: 30,
      windowMs: 60_000,
    });
    const result = await captureWork(
      {
        rawText,
        transcript: body.transcript,
        source: body.source || 'text',
        areaId: body.areaId,
        reviewedItems: Array.isArray(body.reviewedItems)
          ? body.reviewedItems.map((item) => ({
              title: String(item?.title || ''),
              rawText: String(item?.rawText || ''),
            }))
          : undefined,
      },
      user,
    );
    return json(200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    return json(500, { ok: false, error: error instanceof Error ? error.message : 'capture failed' });
  }
}
