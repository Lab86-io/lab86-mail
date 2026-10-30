'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { showArrivalToast } from '@/components/needs-you/NeedsYouArrivals';
import { NeedsYouView } from '@/components/needs-you/NeedsYouView';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import type {
  ObligationAction,
  ObligationActionResponse,
  ObligationAlbatrossResponse,
  ObligationDraftResponse,
  ObligationReplyResponse,
  ObligationView,
} from '@/lib/obligations/contract';
import { UNDO_WINDOW_MS } from '@/lib/obligations/contract';
import { NEEDS_YOU_FIXTURE_NOW, needsYouFixture } from '@/lib/obligations/fixtures';
import { isClosedObligation } from '@/lib/obligations/groups';

/* Dev-only harness: the Needs you page from fixtures, so every state can be
 * seen and screenshotted without a backend. Query switches:
 *   ?select=<id>      opens one item (ob_sow, ob_code_now, ob_flight, ob_lease, question:q_deck,
 *                     ob_slack_numbers, ob_jira_lab212, ob_granola_nda, ob_github_491, ob_pipeline,
 *                     ob_drive_memo, ob_rsvp, ob_prepare, ob_card)
 *   ?state=empty      nothing open, only Closed today
 *   ?state=loading    the skeleton
 *   ?toast=1          the arrival toast for Dana's reply
 *   ?toast=code       the arrival toast for a code
 * Actions change local state and answer like the server: Done, Later, Not
 * mine, Undo, the draft, Send reply, Yes/No/Maybe, and Start in Albatross
 * all work. Not linked from anywhere;
 * 404s outside development. */
export default function NeedsYouPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <QueryProvider clerkEnabled={false}>
      <NeedsYouPreviewInner />
    </QueryProvider>
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = NEEDS_YOU_FIXTURE_NOW;

function NeedsYouPreviewInner() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const state = params.get('state');
  const select = params.get('select');
  const toastParam = params.get('toast');
  const fixture = useMemo(() => needsYouFixture(), []);
  const startedAt = useRef(Date.now());
  const [items, setItems] = useState<ObligationView[]>(() =>
    state === 'empty' ? fixture.items.filter(isClosedObligation) : fixture.items,
  );
  const extras = state === 'empty' ? [] : fixture.extras;
  // The fixture clock moves with the real one, so a close made now reads as "now".
  const fixtureNow = useCallback(() => now + (Date.now() - startedAt.current), []);

  const onObligationAction = useCallback(
    async (obligation: ObligationView, action: ObligationAction): Promise<ObligationActionResponse> => {
      await delay(150);
      const at = fixtureNow();
      const original = fixture.items.find((item) => item.id === obligation.id) ?? obligation;
      let next: ObligationView;
      if (action.action === 'undo') next = { ...original, updatedAt: at };
      else if (action.action === 'later')
        next = { ...obligation, state: 'snoozed', snoozedUntil: action.until, updatedAt: at };
      else if (action.action === 'not_mine')
        next = { ...obligation, state: 'dismissed', closedAt: at, closeReason: 'not_mine', updatedAt: at };
      else if (action.action === 'rsvp')
        next = { ...obligation, state: 'done', closedAt: at, closeReason: 'event_passed', updatedAt: at };
      else
        next = {
          ...obligation,
          state: 'done',
          closedAt: at,
          closeReason: obligation.kind === 'reply' ? 'user_done_no_reply' : 'user_done',
          updatedAt: at,
        };
      setItems((list) => list.map((item) => (item.id === next.id ? next : item)));
      return {
        obligation: next,
        undoUntil: action.action === 'undo' ? undefined : Date.now() + UNDO_WINDOW_MS,
      };
    },
    [fixture, fixtureNow],
  );
  const onLoadDraft = useCallback(
    async (obligation: ObligationView): Promise<ObligationDraftResponse> => {
      await delay(400);
      const draft = fixture.drafts[obligation.id];
      if (!draft) throw new Error('No draft in the fixture.');
      return { draft };
    },
    [fixture],
  );
  const onStartAlbatross = useCallback(
    async (obligation: ObligationView): Promise<ObligationAlbatrossResponse> => {
      await delay(300);
      const created = !obligation.workId;
      const next: ObligationView = {
        ...obligation,
        workId: obligation.workId ?? 'work_new_from_item',
        workTitle: obligation.workTitle ?? obligation.title.replace(/\.$/, ''),
        updatedAt: fixtureNow(),
      };
      setItems((list) => list.map((item) => (item.id === next.id ? next : item)));
      return { workId: next.workId as string, created, obligation: next };
    },
    [fixtureNow],
  );
  const onSendReply = useCallback(
    async (obligation: ObligationView): Promise<ObligationReplyResponse> => {
      await delay(300);
      const at = fixtureNow();
      const next: ObligationView = {
        ...obligation,
        state: 'done',
        closedAt: at,
        closeReason: 'sent_reply',
        updatedAt: at,
      };
      setItems((list) => list.map((item) => (item.id === next.id ? next : item)));
      return { obligation: next, undoUntil: Date.now() + UNDO_WINDOW_MS };
    },
    [fixtureNow],
  );

  useEffect(() => {
    if (!toastParam) return;
    const item = fixture.items.find(
      (entry) => entry.id === (toastParam === 'code' ? 'ob_code_now' : 'ob_sow'),
    );
    if (!item) return;
    const timer = setTimeout(
      () =>
        showArrivalToast(item, now, fixture.timezone, {
          onOpen: () => toast('Open'),
          onLater: () => toast('Later'),
          onCopy: () => toast('Copied'),
        }),
      100,
    );
    return () => clearTimeout(timer);
  }, [toastParam, fixture]);

  return (
    <div className="h-dvh">
      <NeedsYouView
        items={items}
        extras={extras}
        timezone={fixture.timezone}
        now={now}
        isLoading={state === 'loading'}
        openRequest={select ? { id: select, at: 1 } : null}
        onObligationAction={onObligationAction}
        onLoadDraft={onLoadDraft}
        onSendReply={onSendReply}
        onOpenSource={() => {
          toast('Open in Mail');
        }}
        onAlbatrossAction={() => {
          toast('Albatross action');
        }}
        onStartAlbatross={onStartAlbatross}
        onOpenWork={(workId) => {
          toast(`Open thread ${workId}`);
        }}
        onOpenActivity={() => {
          toast('Activity history');
        }}
      />
    </div>
  );
}
