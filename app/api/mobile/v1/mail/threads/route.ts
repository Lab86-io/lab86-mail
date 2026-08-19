import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { MailThreadPageSchema } from '@/lib/mobile/v1/contract';
import { MobileInputError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { mailListCursor, mailListLimit, mailThreadSummaryFromCorpus } from '@/lib/mobile/v1/mail-reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CorpusPage {
  items: any[];
  nextBefore?: number;
}

interface MobileMailThreadsDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  pageRecent(args: {
    userId: string;
    accountId?: string;
    limit: number;
    before?: number;
  }): Promise<CorpusPage>;
  pageCategory(args: {
    userId: string;
    accountId?: string;
    category: string;
    limit: number;
    before?: number;
  }): Promise<CorpusPage>;
}

const defaultDependencies: MobileMailThreadsDependencies = {
  requireCurrentUser,
  pageRecent: (args) => convexQuery<CorpusPage>((api as any).mailCorpus.pageRecentCorpusThreads, args),
  pageCategory: (args) => convexQuery<CorpusPage>((api as any).mailCorpus.listSmartCategoryThreads, args),
};

export function createMobileMailThreadsGet(deps: MobileMailThreadsDependencies = defaultDependencies) {
  return async function mobileMailThreadsGet(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const url = new URL(request.url);
      const accountID = url.searchParams.get('accountID')?.trim() || undefined;
      const category = url.searchParams.get('category')?.trim() || undefined;
      if (category && category.length > 240) {
        throw new MobileInputError('category is too long.');
      }
      const before = mailListCursor(url.searchParams.get('cursor'));
      const limit = mailListLimit(url.searchParams.get('limit'));
      const page = category
        ? await deps.pageCategory({ userId: user.userId, accountId: accountID, category, limit, before })
        : await deps.pageRecent({ userId: user.userId, accountId: accountID, limit, before });
      const payload = MailThreadPageSchema.parse({
        items: (page.items || []).map(mailThreadSummaryFromCorpus),
        nextCursor: page.nextBefore !== undefined ? String(page.nextBefore) : undefined,
        hasMore: page.nextBefore !== undefined,
        serverTime: new Date().toISOString(),
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileMailThreadsGet();
