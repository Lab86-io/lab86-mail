import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { loadSendAsPage } from '@/lib/mail/send-as';
import { MobileSendAsPageSchema } from '@/lib/mobile/v1/contract';
import {
  MobileConflictError,
  MobileInputError,
  MobileNotFoundError,
  mobileErrorResponse,
  mobileJSON,
  mobileRequestID,
} from '@/lib/mobile/v1/http';
import type { NylasAccountRow } from '@/lib/nylas/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The addresses one mailbox can send from (MobileSendAsPage).
interface MobileSendAsDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  listAccounts: (userId: string) => Promise<NylasAccountRow[]>;
  loadSendAsPage: typeof loadSendAsPage;
  now: () => Date;
}

const defaultDependencies: MobileSendAsDependencies = {
  requireCurrentUser,
  listAccounts: (userId) => convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId }),
  loadSendAsPage,
  now: () => new Date(),
};

function optionalID(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > 240) throw new MobileInputError(`${name} is too long.`);
  return value;
}

export function createMobileSendAsGet(deps: MobileSendAsDependencies = defaultDependencies) {
  return async function mobileSendAsGet(
    request: Request,
    context: { params: Promise<{ accountID: string }> },
  ) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const { accountID } = await context.params;
      const url = new URL(request.url);
      const messageId = optionalID(url, 'messageID');
      const threadId = optionalID(url, 'threadID');
      const account = (await deps.listAccounts(user.userId)).find((row) => row.accountId === accountID);
      if (!account) throw new MobileNotFoundError('No mailbox has this id.');
      if (account.status !== 'connected') {
        throw new MobileConflictError('Reconnect this mailbox before you select a From address.');
      }
      const page = await deps.loadSendAsPage({ userId: user.userId, account, messageId, threadId });
      const payload = MobileSendAsPageSchema.parse({
        version: 1,
        accountID: page.accountId,
        aliasesSupported: page.aliasesSupported,
        partial: page.partial,
        identities: page.identities.slice(0, 100),
        defaultAddress: page.defaultAddress,
        serverTime: deps.now().toISOString(),
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileSendAsGet();
