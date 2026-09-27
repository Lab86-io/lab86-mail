import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { dismissProofWork } from '@/lib/store/proof-dismissals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One request holds one click, or one batch of device pairs to move to the server. */
const PROOF_DISMISSAL_BATCH_LIMIT = 100;

const bodySchema = z.object({
  dismissals: z
    .array(
      z.object({
        accountId: z.string().trim().min(1).max(200),
        providerThreadId: z.string().trim().min(1).max(300),
        workId: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(PROOF_DISMISSAL_BATCH_LIMIT),
});

interface ProofDismissalsDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  dismissProofWork: typeof dismissProofWork;
}

const defaults: ProofDismissalsDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  dismissProofWork,
};

/**
 * "Not related" on a mail proof offer, for web and native. The pairs are kept
 * for the user, and /api/albatross/proof-matches leaves them out after that.
 */
export function createProofDismissalsPost(overrides: Partial<ProofDismissalsDependencies> = {}) {
  const deps: ProofDismissalsDependencies = { ...defaults, ...overrides };
  return async function POST(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-proof-dismissals',
        limit: 60,
        windowMs: 60_000,
      });
      const parsed = bodySchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return Response.json(
          { ok: false, error: 'Send one or more dismissals with an account, thread, and Work.' },
          { status: 400 },
        );
      }
      const threads = await runWithAiRequestContext({ userId: user.userId, agent: 'user' }, () =>
        deps.dismissProofWork(
          parsed.data.dismissals.map((pair) => ({
            accountId: pair.accountId,
            threadId: pair.providerThreadId,
            workId: pair.workId,
          })),
        ),
      );
      return Response.json({ ok: true, saved: parsed.data.dismissals.length, threads });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        { ok: false, error: status === 401 ? 'Sign in again.' : 'The dismissal could not be saved.' },
        { status },
      );
    }
  };
}

export const POST = createProofDismissalsPost();
