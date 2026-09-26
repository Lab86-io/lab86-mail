import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { api, convexMutation } from '@/lib/hosted/convex';
import { deleteUserData } from '@/lib/security/account-deletion';
import { writeAudit } from '@/lib/store/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDeps = {
  verifyWebhook: (req: NextRequest) => verifyWebhook(req),
  upsertFromClerk: (args: { userId: string; email: string; name: string; imageUrl?: string }) =>
    convexMutation(api.users.upsertFromClerk, args),
  deleteUserData: (userId: string) => deleteUserData(userId),
  writeAudit,
};

export function createClerkWebhookPost(deps: typeof defaultDeps = defaultDeps) {
  return async function clerkWebhookPost(req: NextRequest) {
    let event: any;
    try {
      event = await deps.verifyWebhook(req);
    } catch {
      // One generic message: the reason (missing secret, bad signature) is not
      // for the caller.
      return NextResponse.json({ ok: false, error: 'Invalid webhook.' }, { status: 400 });
    }

    const type = String(event.type || '');
    const data = event.data || {};
    const userId = String(data.id || data.user_id || data.userId || '');
    const email = primaryEmail(data);
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.full_name || email;
    const imageUrl = profileImageUrl(data);

    if (userId && email && (type === 'user.created' || type === 'user.updated')) {
      await deps.upsertFromClerk({ userId, email, name, imageUrl });
    }

    // A user who deletes the account from the Clerk profile gets the same
    // cleanup as DELETE /api/account. A non-2xx answer makes Clerk retry, and
    // each step is safe to run again.
    if (userId && type === 'user.deleted') {
      try {
        const result = await deps.deleteUserData(userId);
        if (!result.ok) {
          return NextResponse.json(
            { ok: false, error: 'Mail providers could not be disconnected.' },
            { status: 502 },
          );
        }
      } catch (err) {
        console.error('[clerk/webhook] user deletion failed', err);
        return NextResponse.json({ ok: false, error: 'User deletion failed.' }, { status: 500 });
      }
    }

    await deps
      .writeAudit({
        tool: `clerk_webhook:${type || 'unknown'}`,
        userId: userId || null,
        account: null,
        args: {
          type,
          userId: userId || null,
          email: email || null,
          plan: data.plan?.slug || data.subscription?.plan?.slug || data.slug || null,
        },
        result: 'ok',
        agent: 'user',
      })
      .catch(() => undefined);

    return NextResponse.json({ ok: true });
  };
}

export const POST = createClerkWebhookPost();

function primaryEmail(data: any) {
  const primaryId = data.primary_email_address_id;
  const emails = Array.isArray(data.email_addresses) ? data.email_addresses : [];
  return (
    emails.find((item: any) => item.id === primaryId)?.email_address ||
    emails[0]?.email_address ||
    data.email ||
    ''
  );
}

function profileImageUrl(data: any) {
  const customImage =
    typeof data.image_url === 'string'
      ? data.image_url.trim()
      : typeof data.profile_image_url === 'string'
        ? data.profile_image_url.trim()
        : '';
  if (customImage && data.has_image) return customImage;
  const externalAccounts = Array.isArray(data.external_accounts) ? data.external_accounts : [];
  const oauthImage =
    externalAccounts
      .find((account: any) => typeof account?.image_url === 'string' && account.image_url.trim())
      ?.image_url?.trim() || '';
  return oauthImage || undefined;
}
