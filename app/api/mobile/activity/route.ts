import type { FunctionReturnType } from 'convex/server';
import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PendingSuggestions = FunctionReturnType<typeof api.suggestions.listPending>;
type LatestUnansweredCheckin = FunctionReturnType<typeof api.albatrossNotifications.latestUnansweredCheckin>;

interface ActivityDependencies {
  currentUser: typeof requireCurrentUser;
  listPendingSuggestions(args: { userId: string; limit: number }): Promise<PendingSuggestions>;
  latestUnansweredCheckin(args: { userId: string }): Promise<LatestUnansweredCheckin>;
}

const activityDependencies: ActivityDependencies = {
  currentUser: requireCurrentUser,
  listPendingSuggestions: (args) => convexQuery<PendingSuggestions>(api.suggestions.listPending, args),
  latestUnansweredCheckin: (args) =>
    convexQuery<LatestUnansweredCheckin>(api.albatrossNotifications.latestUnansweredCheckin, args),
};

export function createActivityPost(deps: ActivityDependencies = activityDependencies) {
  return async function activityPost(_req: NextRequest) {
    try {
      const user = await deps.currentUser();
      const [suggestions, checkin] = await Promise.all([
        deps.listPendingSuggestions({ userId: user.userId, limit: 50 }),
        deps.latestUnansweredCheckin({ userId: user.userId }),
      ]);
      return Response.json({ ok: true, suggestions, checkin });
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      return Response.json({ ok: false, error: 'Activity could not be loaded.' }, { status: 500 });
    }
  };
}

export const POST = createActivityPost();
