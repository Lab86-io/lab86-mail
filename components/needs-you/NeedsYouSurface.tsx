'use client';

import { useAuth } from '@clerk/nextjs';
import { useCallback, useEffect } from 'react';
import { DailyCheckin } from '@/components/albatross/DailyCheckin';
import {
  NotificationsSurface,
  useNotificationActions,
} from '@/components/notifications/NotificationsSurface';
import { useClientStore } from '@/lib/client-state';
import type { ObligationAction, ObligationView } from '@/lib/obligations/contract';
import {
  postObligationAction,
  postObligationDraft,
  postObligationReply,
  useNeedsYouOpenRequest,
} from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { NeedsYouView } from './NeedsYouView';
import { useNeedsYou } from './useNeedsYou';

/** The source thread of a mail obligation, from its fields or its source key. */
export function mailThreadOf(obligation: Pick<ObligationView, 'accountId' | 'threadId' | 'sourceKey'>) {
  if (obligation.accountId && obligation.threadId) {
    return { accountId: obligation.accountId, threadId: obligation.threadId };
  }
  const match = /^mail:([^:]+):(.+)$/.exec(obligation.sourceKey);
  return match ? { accountId: match[1], threadId: match[2] } : null;
}

function ConnectedNeedsYou({
  data,
  onOpenActivity,
}: {
  data: ReturnType<typeof useNeedsYou>;
  onOpenActivity?: () => void;
}) {
  const { userId } = useAuth();
  const { onAction, checkinOpen, setCheckinOpen } = useNotificationActions();
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setThreadAccount = useClientStore((state) => state.setThreadAccount);
  const setSelectedThread = useClientStore((state) => state.setSelectedThread);
  const openRequest = useNeedsYouOpenRequest((state) => state.request);
  const clearOpenRequest = useNeedsYouOpenRequest((state) => state.clear);
  useEffect(() => {
    if (openRequest) clearOpenRequest();
  }, [openRequest, clearOpenRequest]);

  const onObligationAction = useCallback(
    (obligation: ObligationView, action: ObligationAction) => postObligationAction(obligation.id, action),
    [],
  );
  const onLoadDraft = useCallback((obligation: ObligationView) => postObligationDraft(obligation.id), []);
  const onSendReply = useCallback(
    (obligation: ObligationView, body: string) => postObligationReply(obligation.id, body),
    [],
  );
  const onOpenSource = useCallback(
    (obligation: ObligationView) => {
      const thread = mailThreadOf(obligation);
      if (!thread) return;
      setThreadAccount(thread.accountId);
      setSelectedThread(thread.threadId);
      setPrimaryView('mail');
    },
    [setThreadAccount, setSelectedThread, setPrimaryView],
  );

  const snapshot = data.snapshot;
  return (
    <>
      <NeedsYouView
        items={snapshot?.items ?? []}
        extras={data.extras}
        timezone={snapshot?.timezone ?? 'UTC'}
        now={data.nowMs}
        isLoading={data.isLoading}
        storageKey={userId ? `albatross.needs-you.v1:${userId}` : undefined}
        openRequest={openRequest}
        onObligationAction={onObligationAction}
        onLoadDraft={onLoadDraft}
        onSendReply={onSendReply}
        onOpenSource={onOpenSource}
        onAlbatrossAction={onAction}
        onOpenActivity={onOpenActivity || (() => setPrimaryView('activity'))}
      />
      <DailyCheckin checkin={data.notifications.checkin} open={checkinOpen} onOpenChange={setCheckinOpen} />
    </>
  );
}

/** The list skeleton while the snapshot decides which page this is. */
function UndecidedSurface() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-content)]" data-needs-you-undecided>
      <header className="h-[57px] shrink-0 border-b border-[var(--color-border)]" />
      <div role="status" className="space-y-6 px-5 py-8 lg:w-[min(42%,440px)]">
        <span className="sr-only">Finding what needs you</span>
        {[0, 1, 2, 3, 4].map((key) => (
          <div key={key} className="space-y-2">
            <div className="h-3 w-4/5 rounded bg-[var(--color-control)]" />
            <div className="h-2.5 w-1/2 rounded bg-[var(--color-control)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function NeedsYouChooser({ onOpenActivity }: { onOpenActivity?: () => void }) {
  const data = useNeedsYou();
  if (data.snapshot === undefined) return <UndecidedSurface />;
  if (!data.enabled) return <NotificationsSurface onOpenActivity={onOpenActivity} />;
  return <ConnectedNeedsYou data={data} onOpenActivity={onOpenActivity} />;
}

/**
 * The bell's page. A user in LAB86_NEEDS_YOU gets Needs you; everyone else
 * keeps Notifications, and so does everyone when the snapshot cannot load.
 */
export function NeedsYouSurface({ onOpenActivity }: { onOpenActivity?: () => void } = {}) {
  return (
    <NeedsYouGate fallback={<NotificationsSurface onOpenActivity={onOpenActivity} />}>
      <NeedsYouChooser onOpenActivity={onOpenActivity} />
    </NeedsYouGate>
  );
}
