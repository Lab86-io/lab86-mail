import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { capabilitiesForProvider } from '@/lib/mobile/v1/capabilities';
import { MobileBootstrapSchema, type MobileDomain } from '@/lib/mobile/v1/contract';
import { mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const domains: MobileDomain[] = [
  'accounts',
  'mail',
  'calendar',
  'tasks',
  'today',
  'work',
  'assistant',
  'activity',
];

function safeImageURL(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

interface MobileBootstrapDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  bootstrapState(args: { userId: string }): Promise<any>;
  now: () => Date;
}

const defaultDependencies: MobileBootstrapDependencies = {
  requireCurrentUser,
  bootstrapState: (args) => convexQuery<any>((api as any).mobile.bootstrapState, args),
  now: () => new Date(),
};

export function createMobileBootstrapGet(deps: MobileBootstrapDependencies = defaultDependencies) {
  return async function mobileBootstrapGet(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const state = await deps.bootstrapState({ userId: user.userId });
      const syncByAccount = new Map((state.mailSync || []).map((row: any) => [row.accountId, row]));
      const headByDomain = new Map((state.heads || []).map((row: any) => [row.domain, row.revision]));
      const payload = MobileBootstrapSchema.parse({
        version: 1,
        user: {
          id: user.userId,
          email: user.email,
          name: user.name,
          imageURL: safeImageURL(user.imageUrl),
        },
        accounts: (state.accounts || []).map((account: any) => {
          const sync: any = syncByAccount.get(account.accountId);
          return {
            id: account.accountId,
            email: account.email,
            provider: account.provider,
            status: account.status,
            displayName: account.displayName,
            scopes: account.scopes || [],
            capabilities: capabilitiesForProvider(account.provider),
            sync: {
              status: sync?.status || 'idle',
              corpusReady: Boolean(sync?.corpusReady),
              itemsSynced: typeof sync?.messagesSynced === 'number' ? sync.messagesSynced : undefined,
              lastSyncedAt: sync?.lastIncrementalSyncAt ?? sync?.lastBackfillAt ?? undefined,
              error: sync?.error || undefined,
            },
          };
        }),
        featureFlags: {
          mobileContractV1: true,
          typedCommandOutbox: true,
          assistantStreaming: false,
        },
        notificationSettings: {
          nativePushEnabled: state.preferences?.nativePushEnabled ?? true,
          newMailPushEnabled: state.preferences?.newMailPushEnabled ?? true,
          eventSuggestionPushEnabled: state.preferences?.eventSuggestionPushEnabled ?? true,
          eveningCheckinEnabled: state.preferences?.eveningCheckinEnabled ?? true,
        },
        cursors: Object.fromEntries(domains.map((domain) => [domain, String(headByDomain.get(domain) ?? 0)])),
        serverTime: deps.now().toISOString(),
      });
      return mobileJSON(payload, undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileBootstrapGet();
