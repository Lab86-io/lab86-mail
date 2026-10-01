import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { loadSendAsPage } from '@/lib/mail/send-as';
import { getNylasAccount } from '@/lib/nylas/provider';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The addresses one mailbox can send from, for the web composer's From
// control. Native clients use GET /api/mobile/v1/accounts/{accountID}/send-as.
//
// GET ?account=<accountId>[&messageId=][&threadId=]
//   → { ok, accountId, aliasesSupported, partial, identities, defaultAddress }

const defaults = {
  requireCurrentUser,
  getAccount: getNylasAccount,
  loadSendAsPage,
};

function param(url: URL, name: string) {
  const value = url.searchParams.get(name)?.trim();
  return value ? value.slice(0, 240) : undefined;
}

export function createSendAsGet(deps = defaults) {
  return async function GET(request: Request) {
    try {
      const user = await deps.requireCurrentUser();
      const url = new URL(request.url);
      const accountRef = param(url, 'account');
      if (!accountRef) return Response.json({ ok: false, error: 'account is required' }, { status: 400 });
      const account = await deps.getAccount(user.userId, accountRef);
      if (!account) {
        return Response.json({ ok: false, error: 'This mailbox is not connected.' }, { status: 404 });
      }
      const page = await deps.loadSendAsPage({
        userId: user.userId,
        account,
        messageId: param(url, 'messageId'),
        threadId: param(url, 'threadId'),
      });
      return Response.json({ ok: true, ...page });
    } catch (error) {
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'The From addresses are not available.', '[send-as]'),
        },
        { status },
      );
    }
  };
}

export const GET = createSendAsGet();
