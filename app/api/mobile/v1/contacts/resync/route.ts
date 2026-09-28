import { requireCurrentUser } from '@/lib/auth/current-user';
import { maybeKickContactSync } from '@/lib/contacts/sync';
import { api, convexQuery } from '@/lib/hosted/convex';
import { ContactResyncReceiptSchema, ContactResyncRequestSchema } from '@/lib/mobile/v1/contract';
import {
  MobileConflictError,
  MobileNotFoundError,
  mobileErrorResponse,
  mobileJSON,
  mobileRequestID,
} from '@/lib/mobile/v1/http';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One contact pass for one mailbox now (ContactResyncReceipt).
interface MobileContactResyncDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  listAccounts: (userId: string) => Promise<NylasAccountRow[]>;
  kick: typeof maybeKickContactSync;
}

const defaultDependencies: MobileContactResyncDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  listAccounts: (userId) => convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId }),
  kick: maybeKickContactSync,
};

export function createMobileContactResyncPost(deps: MobileContactResyncDependencies = defaultDependencies) {
  return async function mobileContactResyncPost(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const body = ContactResyncRequestSchema.parse(await request.json());
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'contacts_resync',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const account = (await deps.listAccounts(user.userId)).find((row) => row.accountId === body.accountID);
      if (!account) throw new MobileNotFoundError('No mailbox has this id.');
      if (account.status !== 'connected') {
        throw new MobileConflictError('Reconnect this mailbox before you sync its contacts.');
      }
      const started = deps.kick(
        { userId: user.userId, accountId: body.accountID },
        { force: true, reason: 'mobile_resync' },
      );
      return mobileJSON(
        ContactResyncReceiptSchema.parse({ accountID: body.accountID, started }),
        undefined,
        requestID,
      );
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const POST = createMobileContactResyncPost();
