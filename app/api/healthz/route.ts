import { NextResponse } from 'next/server';
import { describeProvider, hasAi } from '@/lib/ai/client';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  isLab86AiDisabled,
  isSubscriptionServiceDisabled,
  isUserOpenRouterKeyRequired,
} from '@/lib/hosted/controls';
import {
  isClerkBillingConfigured,
  isClerkConfigured,
  isConvexConfigured,
  isNylasConfigured,
} from '@/lib/hosted/env';
import { TOOLS } from '@/lib/tools';
import { listAccounts } from '@/lib/tools/mail';
import { APP_VERSION } from '@/lib/version';

export const runtime = 'nodejs';

export async function GET() {
  let accounts: any = { accounts: [] };
  const user = await getCurrentUser().catch(() => null);
  try {
    accounts = await listAccounts.handler(
      {},
      { agent: 'user', userId: user?.userId, userEmail: user?.email },
    );
  } catch {}
  return NextResponse.json({
    ok: true,
    service: 'lab86-mail',
    version: APP_VERSION,
    railway: {
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      service: process.env.RAILWAY_SERVICE_NAME || null,
      deployment: process.env.RAILWAY_DEPLOYMENT_ID || null,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    accounts: accounts.accounts.length,
    authed: accounts.accounts.filter((a: any) => a.authed).map((a: any) => a.email),
    tools: Object.keys(TOOLS).length,
    ai: {
      configured: hasAi(),
      ...describeProvider(),
      lab86Disabled: isLab86AiDisabled(),
      userOpenRouterKeyRequired: isUserOpenRouterKeyRequired(),
    },
    hosted: {
      clerk: isClerkConfigured(),
      clerkBilling: isClerkBillingConfigured(),
      convex: isConvexConfigured(),
      nylas: isNylasConfigured(),
      subscriptionsDisabled: isSubscriptionServiceDisabled(),
    },
  });
}
