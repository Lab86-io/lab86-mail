import { type NextRequest, NextResponse } from 'next/server';
import { handleGmailPush } from '@/lib/google/push/receive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Gmail push through Cloud Pub/Sub (docs/google-direct-transport.md, "Push").
// The push subscription posts here with an OIDC token (Authorization: Bearer),
// which handleGmailPush checks before it reads the body. With
// LAB86_GOOGLE_GMAIL_PUSH off, the answer is 204 and nothing runs. 204
// acknowledges the message; only a request without a valid token gets 401.
export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length'));
  const result = await handleGmailPush({
    authorization: req.headers.get('authorization'),
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    readBody: () => req.text(),
  });
  return new NextResponse(null, { status: result.status });
}
