import { requireCurrentUser } from '@/lib/auth/current-user';
import { mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { loadTodaySummary } from '@/lib/mobile/v1/today-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The Today summary for widgets (FEATURES item 19): TodaySummary in the
// mobile v1 contract.
const defaults = { requireCurrentUser, loadTodaySummary: (userId: string) => loadTodaySummary(userId) };

export function createMobileTodaySummaryGet(deps = defaults) {
  return async function mobileTodaySummaryGet(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      return mobileJSON(await deps.loadTodaySummary(user.userId), undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileTodaySummaryGet();
