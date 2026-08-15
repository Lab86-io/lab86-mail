import type { NextRequest } from 'next/server';
import { evidenceSatisfies } from '@/lib/albatross/evidence-gate';
import {
  proofCandidatesForMail,
  proofOfferAllowed,
  threadPrimaryCategory,
} from '@/lib/albatross/proof-match';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Lexical rank is only a pre-filter; this many finalists meet the gate. */
const GATE_LIMIT = 3;

interface OpenWork {
  _id: string;
  title: string;
  contract: {
    outcome: string;
    proofs: Array<{ id: string; what: string; satisfiedAt?: number }>;
  } | null;
}

interface ProofMatchesDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexQuery: typeof convexQuery;
  evidenceSatisfies: typeof evidenceSatisfies;
}

const defaults: ProofMatchesDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexQuery,
  evidenceSatisfies,
};

export function createProofMatchesPost(overrides: Partial<ProofMatchesDependencies> = {}) {
  const deps: ProofMatchesDependencies = { ...defaults, ...overrides };
  return async function POST(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-proof-matches',
        limit: 60,
        windowMs: 60_000,
      });
      const body = await req.json().catch(() => ({}));
      const subject = typeof body.subject === 'string' ? body.subject.slice(0, 500) : '';
      const snippet = typeof body.snippet === 'string' ? body.snippet.slice(0, 2_000) : '';
      const accountId = typeof body.accountId === 'string' ? body.accountId.slice(0, 200) : '';
      const providerThreadId =
        typeof body.providerThreadId === 'string' ? body.providerThreadId.slice(0, 300) : '';
      if (!subject.trim() && !snippet.trim()) {
        return Response.json({ ok: false, error: 'Mail text is required.' }, { status: 400 });
      }

      // Marketing mail and verification codes never ask to become proof. A
      // thread missing from the corpus is merely unclassified; a failed
      // lookup fails closed, because "unknown class" must not become "offer".
      if (accountId && providerThreadId) {
        let thread: unknown;
        try {
          thread = await deps.convexQuery<any>((api as any).mailCorpus.getCorpusThread, {
            userId: user.userId,
            accountId,
            providerThreadId,
          });
        } catch {
          return Response.json({ ok: true, candidates: [], blocked: 'lookup_failed' });
        }
        if (thread && !proofOfferAllowed(threadPrimaryCategory(thread as any))) {
          return Response.json({ ok: true, candidates: [], blocked: 'category' });
        }
      }

      const open = await deps.convexQuery<OpenWork[]>((api as any).albatrossWorkV2.openWorkForProof, {
        userId: user.userId,
        limit: 12,
      });
      const mailText = `${subject} ${snippet}`.trim();
      const ranked = proofCandidatesForMail(
        (open || []).map((work) => ({
          ...work,
          outcome: work.contract?.outcome,
          proofs: work.contract?.proofs,
        })),
        mailText,
      );

      const candidates: Array<{
        workId: string;
        workTitle: string;
        outcome: string | null;
        proofId: string | null;
        proofWhat: string | null;
        gate: 'confirmed' | 'unchecked';
        outstanding: Array<{ id: string; what: string }>;
      }> = [];
      for (const match of ranked.slice(0, GATE_LIMIT)) {
        const verdict = await deps.evidenceSatisfies({
          userId: user.userId,
          workTitle: match.work.title,
          outcome: match.work.outcome ?? null,
          requirement: match.proofWhat || `Progress toward: ${match.work.outcome || match.work.title}`,
          evidenceText: mailText,
        });
        // A refuted match dies here. An unavailable gate keeps the offer an
        // offer: the user decides, and nothing is auto-claimed.
        if (!verdict.satisfies && !verdict.unavailable) continue;
        candidates.push({
          workId: match.work._id,
          workTitle: match.work.title,
          outcome: match.work.outcome ?? null,
          proofId: match.proofId,
          proofWhat: match.proofWhat,
          gate: verdict.satisfies ? 'confirmed' : 'unchecked',
          outstanding: (match.work.proofs || [])
            .filter((proof) => !proof.satisfiedAt)
            .map((proof) => ({ id: proof.id, what: proof.what })),
        });
      }

      return Response.json({ ok: true, candidates });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'Proof matches could not be loaded.' },
        { status },
      );
    }
  };
}

export const POST = createProofMatchesPost();
