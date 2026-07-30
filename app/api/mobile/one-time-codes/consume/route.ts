import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { consumeOneTimeCode, parseCleanupMode } from '@/lib/mail/one-time-code-cleanup';
import { verifyConsumeToken } from '@/lib/mail/one-time-code-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConsumeDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  verifyConsumeToken: typeof verifyConsumeToken;
  consumeOneTimeCode: typeof consumeOneTimeCode;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: ConsumeDependencies = {
  requireCurrentUser,
  verifyConsumeToken,
  consumeOneTimeCode,
  reportUnexpectedError: (error) => console.error('One-time code consume failed.', error),
};

export function createConsumeHandlers(deps: ConsumeDependencies = defaultDependencies) {
  async function post(req: NextRequest) {
    try {
      // The AutoFill extension authenticates with a consume-scoped token; the
      // app uses its ordinary session. The token is preferred when present
      // because it grants strictly less than a session does.
      const scopedToken = req.headers.get('x-lab86-consume-token') || '';
      let userId: string;
      if (scopedToken) {
        const verification = deps.verifyConsumeToken(scopedToken);
        if (!verification.ok || !verification.userId) {
          return Response.json({ ok: false, error: 'Invalid consume token.' }, { status: 401 });
        }
        userId = verification.userId;
      } else {
        userId = (await deps.requireCurrentUser()).userId;
      }
      const body = (await req.json()) as Record<string, unknown>;
      const codeId = String(body.codeId || '').trim();
      if (!codeId) {
        return Response.json({ ok: false, error: 'codeId is required.' }, { status: 400 });
      }
      const result = await deps.consumeOneTimeCode({
        userId,
        codeId,
        cleanup: parseCleanupMode(body.cleanup),
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof SyntaxError) {
        return Response.json({ ok: false, error: 'Request body must be valid JSON.' }, { status: 400 });
      }
      // A code id that does not resolve is the client's problem, not a fault.
      if (error instanceof Error && /not found/i.test(error.message)) {
        return Response.json({ ok: false, error: 'Code not found.' }, { status: 404 });
      }
      deps.reportUnexpectedError(error);
      return Response.json({ ok: false, error: 'Could not consume the code.' }, { status: 500 });
    }
  }

  return { POST: post };
}

export const { POST } = createConsumeHandlers();
