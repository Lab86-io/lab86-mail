import type { NextRequest } from 'next/server';
import { proofCandidatesForMail } from '@/lib/albatross/proof-match';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OpenWork {
  _id: string;
  title: string;
  contract: {
    outcome: string;
    proofs: Array<{ id: string; what: string; satisfiedAt?: number }>;
  } | null;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-proof-matches',
      limit: 60,
      windowMs: 60_000,
    });
    const body = await req.json().catch(() => ({}));
    const subject = typeof body.subject === 'string' ? body.subject.slice(0, 500) : '';
    const snippet = typeof body.snippet === 'string' ? body.snippet.slice(0, 2_000) : '';
    if (!subject.trim() && !snippet.trim()) {
      return Response.json({ ok: false, error: 'Mail text is required.' }, { status: 400 });
    }

    const open = await convexQuery<OpenWork[]>((api as any).albatrossWorkV2.openWorkForProof, {
      userId: user.userId,
      limit: 12,
    });
    const matches = proofCandidatesForMail(
      (open || []).map((work) => ({
        ...work,
        outcome: work.contract?.outcome,
        proofs: work.contract?.proofs,
      })),
      `${subject} ${snippet}`,
    );
    const candidates = matches.map(({ work, proofId, proofWhat }) => {
      return {
        workId: work._id,
        workTitle: work.title,
        proofId,
        proofWhat,
      };
    });

    return Response.json({ ok: true, candidates });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Proof matches could not be loaded.' },
      { status },
    );
  }
}
