import { classifyRoute } from '@/lib/albatross/route-classifier';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { AssistantRouteRequestSchema, AssistantRouteVerdictSchema } from '@/lib/mobile/v1/contract';
import { mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// The native Ask / Hold bar. Body: `{ text }`. Response: `{ route, confidence }`.
// A receipt cannot carry data, so this is a query, not a command.

interface MobileAssistantRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  classifyRoute: (input: { text: string; nowMs: number; userId: string }) => ReturnType<typeof classifyRoute>;
  now: () => number;
}

const defaultDependencies: MobileAssistantRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  classifyRoute: (input) => classifyRoute(input),
  now: () => Date.now(),
};

export function createMobileAssistantRoutePost(deps: MobileAssistantRouteDependencies = defaultDependencies) {
  return async function mobileAssistantRoutePost(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const body = AssistantRouteRequestSchema.parse(await request.json());
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-route',
        limit: 60,
        windowMs: 60_000,
      });
      const verdict = await deps.classifyRoute({ text: body.text, nowMs: deps.now(), userId: user.userId });
      const payload = AssistantRouteVerdictSchema.parse({
        route: verdict.route,
        confidence: verdict.confidence,
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const POST = createMobileAssistantRoutePost();
