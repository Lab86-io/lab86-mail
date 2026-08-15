import type { NextRequest } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SOURCE_KINDS = [
  'mail_thread',
  'calendar_event',
  'task',
  'chat',
  'question_answer',
  'area_fact',
  'github_issue',
  'github_pull_request',
  'github_project',
  'github_project_item',
  'github_commit',
  'mcp_item',
  'manual',
] as const;
const TRUST_LEVELS = ['observed', 'inferred', 'confirmed'] as const;

type SourceKind = (typeof SOURCE_KINDS)[number];
type Trust = (typeof TRUST_LEVELS)[number];

interface WorkProofDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  attachProof: (args: Record<string, unknown>) => Promise<string>;
  workDetail: (args: { userId: string; workId: string }) => Promise<any>;
  mailThread: (args: { userId: string; accountId: string; providerThreadId: string }) => Promise<any>;
  advanceWork: typeof advanceWork;
}

const defaults: WorkProofDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  attachProof: (args) => convexMutation<string>((api as any).albatrossWorkV2.attachProof, args),
  workDetail: (args) => convexQuery<any>((api as any).albatrossWorkV2.workDetail, args),
  mailThread: (args) => convexQuery<any>((api as any).mailCorpus.getCorpusThread, args),
  advanceWork,
};

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

function isTrust(value: unknown): value is Trust {
  return typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value);
}

export function createWorkProofPost(deps: WorkProofDependencies = defaults) {
  return async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-work-proof',
        limit: 30,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      if (!body.claim || !body.title || !isSourceKind(body.sourceKind) || !body.sourceId) {
        return Response.json({ ok: false, error: 'Proof details are required.' }, { status: 400 });
      }

      let trust: Trust;
      if (body.sourceKind === 'mail_thread') {
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        if (!accountId) {
          return Response.json({ ok: false, error: 'Proof details are required.' }, { status: 400 });
        }
        const thread = await deps.mailThread({
          userId: user.userId,
          accountId,
          providerThreadId: String(body.sourceId),
        });
        if (!thread) {
          return Response.json({ ok: false, error: 'Mail proof could not be verified.' }, { status: 400 });
        }
        // A thread visible in the signed-in user's corpus is observed evidence.
        // It can satisfy a named requirement, but cannot by itself claim the
        // confirmed trust needed to auto-close high-stakes outcomes.
        trust = 'observed';
      } else if (isTrust(body.trust)) {
        trust = body.trust;
      } else {
        return Response.json({ ok: false, error: 'Proof details are required.' }, { status: 400 });
      }

      const evidenceId = await deps.attachProof({
        userId: user.userId,
        workId,
        claim: String(body.claim),
        title: String(body.title),
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        limits: typeof body.limits === 'string' ? body.limits : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
        sourceKind: body.sourceKind,
        sourceId: String(body.sourceId),
        connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
        accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
        occurredAt: typeof body.occurredAt === 'number' ? body.occurredAt : undefined,
        trust,
        proofId: typeof body.proofId === 'string' ? body.proofId : undefined,
      });
      const detail = await deps.workDetail({ userId: user.userId, workId });
      const closed = detail?.work?.workState === 'done';
      if (!closed) {
        await deps.advanceWork({
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          workId,
          timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        });
      }
      return Response.json({ ok: true, evidenceId, closed, replanned: !closed });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'Proof could not be attached.' },
        { status },
      );
    }
  };
}

export const POST = createWorkProofPost();
