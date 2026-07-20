import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { MobileDomainSchema, SyncEnvelopeSchema } from '@/lib/mobile/v1/contract';
import { MobileInputError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cursorRevision(raw: string | null) {
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) throw new MobileInputError('cursor must be a non-negative integer revision.');
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) throw new MobileInputError('cursor is outside the supported range.');
  return revision;
}

export async function GET(request: Request) {
  const requestID = mobileRequestID(request);
  try {
    const user = await requireCurrentUser();
    const url = new URL(request.url);
    const domain = MobileDomainSchema.parse(url.searchParams.get('domain'));
    const afterRevision = cursorRevision(url.searchParams.get('cursor'));
    const requestedLimit = Number(url.searchParams.get('limit') || 200);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
      : 200;
    const result = await convexQuery<any>((api as any).mobile.listSync, {
      userId: user.userId,
      domain,
      afterRevision,
      limit,
    });
    const rows = result.page || [];
    const lastRevision = rows.length ? rows[rows.length - 1].revision : afterRevision;
    const payload = SyncEnvelopeSchema.parse({
      items: rows
        .filter((entry: any) => entry.type === 'change')
        .map((entry: any) => ({
          domain: entry.row.domain,
          entityKind: entry.row.entityKind,
          entityID: entry.row.entityId,
          revision: entry.row.revision,
          operation: 'upsert',
          payload: entry.row.payload || {},
        })),
      deletedIDs: rows
        .filter((entry: any) => entry.type === 'tombstone')
        .map((entry: any) => String(entry.row.entityId)),
      cursor: String(lastRevision),
      serverRevision: result.serverRevision || 0,
      hasMore: Boolean(result.hasMore),
    });
    return mobileJSON(payload, undefined, requestID);
  } catch (error) {
    return mobileErrorResponse(error, requestID);
  }
}
