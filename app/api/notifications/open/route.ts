import { type NextRequest, NextResponse } from 'next/server';
import { verifyNotificationLink } from '@/lib/notifications/delivery';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const notificationId = req.nextUrl.searchParams.get('notificationId') || '';
  const userId = req.nextUrl.searchParams.get('userId') || '';
  const redirect = req.nextUrl.searchParams.get('redirect') || '/';
  const expiresAt = Number(req.nextUrl.searchParams.get('expiresAt') || '');
  const sig = req.nextUrl.searchParams.get('sig') || '';
  if (!redirect.startsWith('/') || redirect.startsWith('//'))
    return NextResponse.redirect(new URL('/', req.url));
  if (!verifyNotificationLink(notificationId, userId, redirect, sig, expiresAt)) {
    return NextResponse.json({ ok: false, error: 'invalid notification link' }, { status: 403 });
  }
  return NextResponse.redirect(new URL(redirect, req.nextUrl.origin));
}
