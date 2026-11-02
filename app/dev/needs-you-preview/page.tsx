'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { InboxThreadRow } from '@/components/inbox/Inbox';
import {
  CalendarNeedsYouItems,
  EventNeedsYou,
  EventNeedsYouMark,
} from '@/components/needs-you/CalendarNeedsYou';
import { showArrivalToast } from '@/components/needs-you/NeedsYouArrivals';
import { NeedsYouView } from '@/components/needs-you/NeedsYouView';
import { ThreadNeedsYouStrip } from '@/components/needs-you/ThreadNeedsYouStrip';
import { TodayNeedsYou } from '@/components/needs-you/TodayNeedsYou';
import type { NotificationItem } from '@/components/notifications/model';
import { projectNotifications } from '@/components/notifications/model';
import { NotificationsView } from '@/components/notifications/NotificationsSurface';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { seedApprovalPreview } from '@/lib/albatross/approval-fixtures';
import type {
  ObligationAction,
  ObligationActionResponse,
  ObligationAlbatrossResponse,
  ObligationDraftResponse,
  ObligationReplyResponse,
  ObligationView,
} from '@/lib/obligations/contract';
import { UNDO_WINDOW_MS } from '@/lib/obligations/contract';
import {
  NEEDS_YOU_FIXTURE_APPROVAL_ID,
  NEEDS_YOU_FIXTURE_NOW,
  needsYouApprovalFixture,
  needsYouFixture,
} from '@/lib/obligations/fixtures';
import { isClosedObligation } from '@/lib/obligations/groups';
import { mailThreadKey, obligationsByThread } from '@/lib/obligations/surfaces';

/* Dev-only harness: the Needs you page from fixtures, so every state can be
 * seen and screenshotted without a backend. Query switches:
 *   ?select=<id>      opens one item (ob_sow, ob_code_now, ob_flight, ob_lease, question:q_deck,
 *                     ob_slack_numbers, ob_jira_lab212, ob_granola_nda, ob_github_491, ob_pipeline,
 *                     ob_drive_memo, ob_rsvp, ob_prepare, ob_card)
 *   ?state=empty      nothing open, only Closed today
 *   ?state=loading    the skeleton
 *   ?toast=1          the arrival toast for Dana's reply
 *   ?toast=code       the arrival toast for a code
 *   ?approval=waiting | deciding | approved | declined | failed
 *                     an invite a run queued, in that state; &select=approval:ap_kickoff opens it
 *   &surface=notifications   the same approval on the older Notifications page
 *   ?surface=today    the live list of Today (with &state=empty)
 *   ?surface=mail     the reader strip and the inbox row mark
 *   ?surface=calendar the event dialog card and the block mark
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

/** The fixture as a server: the actions change local state and answer like the routes. */
function useFixtureServer(state: string | null) {
  const fixture = useMemo(() => needsYouFixture(), []);
  const startedAt = useRef(Date.now());
  const [items, setItems] = useState<ObligationView[]>(() =>
    state === 'empty' ? fixture.items.filter(isClosedObligation) : fixture.items,
  );
  const approvalState = useSearchParams().get('approval');
  // One approval in the state the query names. The buttons answer like the server.
  useState(() => seedApprovalPreview(NEEDS_YOU_FIXTURE_APPROVAL_ID, approvalState));
  const extras = useMemo(
    () =>
      state === 'empty'
        ? []
        : approvalState
          ? [needsYouApprovalFixture(), ...fixture.extras]
          : fixture.extras,
    [state, approvalState, fixture],
  );
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
      // As the server: an undo and a calendar answer have no undo window.
      return {
        obligation: next,
        undoUntil:
          action.action === 'undo' || action.action === 'rsvp' ? undefined : Date.now() + UNDO_WINDOW_MS,
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

  return { fixture, items, extras, onObligationAction, onLoadDraft, onStartAlbatross, onSendReply };
}

function NeedsYouPreviewInner() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const state = params.get('state');
  const select = params.get('select');
  const toastParam = params.get('toast');
  const surface = params.get('surface');
  const server = useFixtureServer(state);
  const { fixture, items, extras, onObligationAction, onLoadDraft, onStartAlbatross, onSendReply } = server;
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
  if (surface === 'today') return <TodaySurfacePreview server={server} />;
  if (surface === 'mail') return <MailSurfacePreview server={server} />;
  if (surface === 'calendar') return <CalendarSurfacePreview server={server} />;

  if (params.get('surface') === 'notifications') {
    const approval = needsYouApprovalFixture();
    const projection = projectNotifications({
      notifications: [],
      questions: [],
      approvals: [
        {
          _id: NEEDS_YOU_FIXTURE_APPROVAL_ID,
          title: approval.title,
          detail: approval.body,
          status: 'pending',
          kind: 'calendar_invite',
          intentId: 'work_q3_deck',
          createdAt: approval.createdAt,
        },
      ],
      checkin: null,
    });
    return (
      <div className="h-dvh">
        <NotificationsView
          projection={projection}
          now={now}
          openRequest={select ? { id: select, at: 1 } : null}
          onRead={async () => undefined}
          onDismiss={async () => undefined}
          onAction={() => {
            toast('Albatross action');
          }}
        />
      </div>
    );
  }

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

type FixtureServer = ReturnType<typeof useFixtureServer>;

const say = (text: string) => () => toast(text);

/** The live list of Today, in the measure of the letter, over a stand-in lede. */
function TodaySurfacePreview({ server }: { server: FixtureServer }) {
  return (
    <div className="min-h-dvh bg-[var(--color-content)] px-6 py-10">
      <div className="mx-auto w-full" style={{ maxWidth: 640 }}>
        <p className="mb-8 text-[12px] text-[var(--color-text-faint)]">
          Written at 7:02 from your mail and calendar.
        </p>
        <TodayNeedsYou
          items={server.items}
          extras={server.extras as unknown as NotificationItem[]}
          timezone={server.fixture.timezone}
          now={now}
          post={server.onObligationAction}
          loadDraft={server.onLoadDraft}
          sendReply={server.onSendReply}
          startAlbatross={server.onStartAlbatross}
          onOpenItem={(id) => toast(`Open ${id}`)}
          onOpenPage={say('Open the Needs you page')}
          onOpenWork={(workId) => toast(`Open thread ${workId}`)}
          onAlbatrossAction={say('Albatross action')}
        />
        <p className="font-display text-[22px] leading-[1.35] text-[var(--color-text)]">
          Good morning. The lede of the letter follows here, in the same scroll, and the stored Needs you lane
          stays out of it.
        </p>
      </div>
    </div>
  );
}

/** The reader strip under a stand-in title bar, and two inbox rows, one with the mark. */
function MailSurfacePreview({ server }: { server: FixtureServer }) {
  const dana = obligationsByThread(server.items, now).get(mailThreadKey('acct_alex', 'thr_dana_sow')) ?? [];
  const rowBase = {
    rowAccount: 'acct_alex',
    senderEmail: '',
    providerPhotoUrl: null,
    selected: false,
    active: false,
    selecting: false,
    onSelectRange: () => undefined,
    onToggleSelect: () => undefined,
    onOpen: () => undefined,
    onPrefetch: () => undefined,
    onApplyLabels: () => undefined,
    onArchive: () => undefined,
    onTrash: () => undefined,
    onCorrect: () => undefined,
    onUndoLast: () => undefined,
    customLabels: [],
  };
  return (
    <div className="min-h-dvh bg-[var(--color-content)] p-6">
      <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-ui border border-[var(--color-border)]">
          <InboxThreadRow
            {...rowBase}
            rowId="thr_dana_sow"
            item={{
              _id: 'thr_dana_sow',
              account: 'acct_alex',
              subject: 'SOW start date',
              from: 'Dana Whitfield <dana@northwindlegal.example.com>',
              senderName: 'Dana Whitfield',
              snippet: 'Can you confirm by Friday so our side can countersign?',
              lastDate: now - 18 * 60 * 60_000,
              unread: true,
              messageCount: 3,
            }}
            needsYou={dana[0]?.title}
          />
          <InboxThreadRow
            {...rowBase}
            rowId="thr_news"
            item={{
              _id: 'thr_news',
              account: 'acct_alex',
              subject: 'October product notes',
              from: 'Northwind Updates <news@northwind.example.com>',
              senderName: 'Northwind Updates',
              snippet: 'What changed this month across the platform.',
              lastDate: now - 20 * 60 * 60_000,
              unread: false,
            }}
          />
        </div>
        <div className="overflow-hidden rounded-ui border border-[var(--color-border)] bg-[var(--color-content)]">
          <div className="flex h-12 items-center border-b border-[var(--color-border)] px-3">
            <h1 className="font-display text-[15px] font-semibold tracking-[-0.01em]">SOW start date</h1>
          </div>
          <ThreadNeedsYouStrip
            items={dana}
            now={now}
            timezone={server.fixture.timezone}
            post={server.onObligationAction}
            onDraftReply={say('Draft reply opens on the page')}
            onOpen={say('Open in Needs you')}
          />
          <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            <p className="font-medium text-[var(--color-text)]">Dana Whitfield, yesterday at 4:48 PM</p>
            <p>
              Hi Alex, after the kickoff slipped we moved the start date in the SOW to Monday, November 16.
              Can you confirm by Friday so our side can countersign?
            </p>
            <p>Thanks, Dana</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The event dialog card and a week block with the mark, from the calendar fixtures. */
function CalendarSurfacePreview({ server }: { server: FixtureServer }) {
  return (
    <CalendarNeedsYouItems
      items={server.items}
      now={now}
      timezone={server.fixture.timezone}
      post={server.onObligationAction}
    >
      <div className="min-h-dvh bg-[var(--color-content)] p-6">
        <div className="mx-auto grid max-w-4xl gap-8 md:grid-cols-[200px_minmax(0,1fr)]">
          <div className="space-y-2">
            {(['evt_harbor_followup', 'evt_board_checkin', 'evt_plain'] as const).map((eventId) => (
              <div
                key={eventId}
                className="flex h-14 flex-col justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-2 text-xs text-[var(--color-accent)]"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <p className="truncate font-semibold">
                    {eventId === 'evt_harbor_followup'
                      ? 'Harbor Labs follow-up'
                      : eventId === 'evt_board_checkin'
                        ? 'Board check-in'
                        : 'Team lunch'}
                  </p>
                  <EventNeedsYouMark event={{ accountId: 'acct_alex', id: eventId }} />
                </div>
                <p className="truncate">3:00 PM - 3:45 PM</p>
              </div>
            ))}
          </div>
          <div className="space-y-6">
            {(['evt_harbor_followup', 'evt_board_checkin'] as const).map((eventId) => (
              <div
                key={eventId}
                className="rounded-ui border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 shadow-[var(--shadow-soft)]"
              >
                <h2 className="mb-4 font-display text-[18px] leading-snug">
                  {eventId === 'evt_harbor_followup' ? 'Harbor Labs follow-up' : 'Board check-in'}
                </h2>
                <EventNeedsYou event={{ accountId: 'acct_alex', id: eventId }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </CalendarNeedsYouItems>
  );
}
