import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { issueConsumeToken } from '@/lib/mail/one-time-code-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OneTimeCodeRow {
  id: string;
  code: string;
  label: string;
  issuer: string;
  serviceIdentifiers: string[];
  accountId: string;
  providerMessageId: string;
  providerThreadId: string;
  receivedAt: number;
  expiresAt: number;
}

interface OneTimeCodesDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  convexQuery: typeof convexQuery;
  issueConsumeToken: typeof issueConsumeToken;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: OneTimeCodesDependencies = {
  requireCurrentUser,
  convexQuery,
  issueConsumeToken,
  reportUnexpectedError: (error) => console.error('One-time code lookup failed.', error),
};

export function createOneTimeCodeHandlers(deps: OneTimeCodesDependencies = defaultDependencies) {
  async function get() {
    try {
      const user = await deps.requireCurrentUser();
      // Settings come back with the codes so the device configures itself from
      // one call. Splitting them would let the app fill from a stale policy —
      // filing mail the user had just told it to leave alone.
      const [codes, preferences] = await Promise.all([
        deps.convexQuery<OneTimeCodeRow[]>((api as any).mailOneTimeCodes.activeCodes, {
          userId: user.userId,
        }),
        deps.convexQuery<{ oneTimeCodeAutofillEnabled?: boolean; oneTimeCodeCleanupEnabled?: boolean }>(
          (api as any).albatrossNotifications.mobilePreferences,
          { userId: user.userId },
        ),
      ]);
      const autofillEnabled = preferences?.oneTimeCodeAutofillEnabled !== false;
      const cleanup = preferences?.oneTimeCodeCleanupEnabled ? 'archive' : 'none';
      // The AutoFill extension reports a used code with this rather than the
      // user's session, which it has no way to reach. Null when no signing
      // secret is configured; the app then cleans up itself on next launch.
      const consumeToken = deps.issueConsumeToken(user.userId);
      // These are live secrets. Nothing between here and the device should hold
      // a copy, so the response is explicitly uncacheable.
      return Response.json(
        { ok: true, codes: autofillEnabled ? codes : [], consumeToken, autofillEnabled, cleanup },
        { headers: { 'Cache-Control': 'no-store, private, max-age=0' } },
      );
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      deps.reportUnexpectedError(error);
      return Response.json({ ok: false, error: 'Could not load one-time codes.' }, { status: 500 });
    }
  }

  return { GET: get };
}

export const { GET } = createOneTimeCodeHandlers();
