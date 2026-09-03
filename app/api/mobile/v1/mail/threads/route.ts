import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { MailThreadPageSchema } from '@/lib/mobile/v1/contract';
import { MobileInputError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { mailListCursor, mailListLimit, mailThreadSummaryFromCorpus } from '@/lib/mobile/v1/mail-reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface CorpusPage {
  items: any[];
  // Convex answers `undefined` or `null` for the last page; only a numeric
  // watermark means another page exists.
  nextBefore?: number | null;
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
      const nextBefore =
        typeof page.nextBefore === 'number' && Number.isFinite(page.nextBefore) && page.nextBefore > 0
          ? Math.floor(page.nextBefore)
          : undefined;
      const payload = MailThreadPageSchema.parse({
        items: (page.items || []).map(mailThreadSummaryFromCorpus),
        nextCursor: nextBefore !== undefined ? String(nextBefore) : undefined,
        hasMore: nextBefore !== undefined,
        serverTime: new Date().toISOString(),
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileMailThreadsGet();
