import { requireCurrentUser } from '@/lib/auth/current-user';
import { loadContactStatuses } from '@/lib/contacts/lookup';
import { contactAccountStatusV1 } from '@/lib/mobile/v1/contacts';
import { ContactStatusPageSchema } from '@/lib/mobile/v1/contract';
import { mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Contact sync state and the reconnect need of each mailbox (ContactStatusPage).
const defaults = {
  requireCurrentUser,
  loadContactStatuses: (userId: string) => loadContactStatuses(userId),
  now: () => new Date(),
};

export function createMobileContactStatusGet(deps = defaults) {
  return async function mobileContactStatusGet(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const statuses = await deps.loadContactStatuses(user.userId);
      const payload = ContactStatusPageSchema.parse({
        version: 1,
        accounts: statuses.map(contactAccountStatusV1),
        serverTime: deps.now().toISOString(),
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileContactStatusGet();
