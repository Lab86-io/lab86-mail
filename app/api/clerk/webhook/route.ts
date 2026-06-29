import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { api, convexMutation } from '@/lib/hosted/convex';
import { writeAudit } from '@/lib/store/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let event: any;
  try {
    event = await verifyWebhook(req);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'invalid webhook' }, { status: 400 });
  }

  const type = String(event.type || '');
  const data = event.data || {};
  const userId = String(data.id || data.user_id || data.userId || '');
  const email = primaryEmail(data);
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.full_name || email;
  const imageUrl = profileImageUrl(data);

  if (userId && email && (type === 'user.created' || type === 'user.updated')) {
    await convexMutation(api.users.upsertFromClerk, {
      userId,
      email,
      name,
      imageUrl,
    });
  }

  await writeAudit({
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
  }).catch(() => undefined);

  return NextResponse.json({ ok: true });
}

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
  const customImage = String(data.image_url || data.profile_image_url || '').trim();
  if (customImage && data.has_image) return customImage;
  const externalAccounts = Array.isArray(data.external_accounts) ? data.external_accounts : [];
  const oauthImage =
    externalAccounts.find((account: any) => typeof account?.image_url === 'string' && account.image_url)
      ?.image_url || '';
  return oauthImage || undefined;
}
