import { requireCurrentUser } from '@/lib/auth/current-user';
import { checkRecipientRateLimit, readExcludeParam, suggestRecipients } from '@/lib/contacts/lookup';
import { recipientSuggestionV1 } from '@/lib/mobile/v1/contacts';
import { RecipientSuggestionPageSchema } from '@/lib/mobile/v1/contract';
import { MobileInputError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// Recipient search for native To, Cc, and Bcc fields (RecipientSuggestionPage).
interface MobileRecipientsDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  checkRateLimit: typeof checkRecipientRateLimit;
  suggest: typeof suggestRecipients;
  now: () => Date;
}

const defaultDependencies: MobileRecipientsDependencies = {
  requireCurrentUser,
  checkRateLimit: checkRecipientRateLimit,
  suggest: (userId, input) => suggestRecipients(userId, input),
  now: () => new Date(),
};

export function createMobileRecipientsGet(deps: MobileRecipientsDependencies = defaultDependencies) {
  return async function mobileRecipientsGet(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      deps.checkRateLimit(user.userId);
      const url = new URL(request.url);
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length > 200) throw new MobileInputError('q must be at most 200 characters.');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 8 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new MobileInputError('limit must be an integer from 1 to 10.');
      }
      const fromAccountId = url.searchParams.get('fromAccountID')?.trim() || undefined;
      const result = await deps.suggest(user.userId, {
        query,
        fromAccountId,
        limit,
        exclude: readExcludeParam(url.searchParams.getAll('exclude')),
      });
      const payload = RecipientSuggestionPageSchema.parse({
        version: 1,
        query,
        items: result.items.slice(0, limit).map(recipientSuggestionV1),
        serverTime: deps.now().toISOString(),
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileRecipientsGet();
