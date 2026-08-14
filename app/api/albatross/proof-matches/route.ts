import type { NextRequest } from 'next/server';
import { matchingProofId, rankWorkForProof } from '@/lib/albatross/proof-match';
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
    const ranked = rankWorkForProof(
      open.map((work) => ({
        ...work,
        outcome: work.contract?.outcome,
        proofs: work.contract?.proofs,
      })),
      `${subject} ${snippet}`,
    );
    const candidates = ranked.slice(0, 5).map((work) => {
      const outstanding = (work.contract?.proofs || []).filter((proof) => !proof.satisfiedAt);
      const proofId = matchingProofId(outstanding, `${subject} ${snippet}`);
      const proof = outstanding.find((row) => row.id === proofId);
      return {
        workId: work._id,
        workTitle: work.title,
        proofId: proof?.id || null,
        proofWhat: proof?.what || null,
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
