'use client';

// The live Needs you list on Today (docs/research/today-live-2026-11-04.md).
// The list reads the same subscription as the page, so it is live, and it acts
// in place: Done, Later, Reply with the prepared draft, Copy, Yes and No, Undo.
// The notices of one sender share a row, and Done closes them all. An empty
// list takes no space.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { NotificationAction, NotificationItem } from '@/components/notifications/model';
import { useNotificationActions } from '@/components/notifications/NotificationsSurface';
import { BriefLiveLayer } from '@/components/report/live-layer';
import { Button } from '@/components/ui/button';
import { useClientStore } from '@/lib/client-state';
import type {
  ObligationAlbatrossResponse,
  ObligationDraftResponse,
  ObligationReplyResponse,
  ObligationView,
} from '@/lib/obligations/contract';
import { UNDO_WINDOW_MS } from '@/lib/obligations/contract';
import { groupNeedsYou, isClosedObligation, type LaterOption, laterOptions } from '@/lib/obligations/groups';
import { canSendReply, closeReasonLabel } from '@/lib/obligations/labels';
import {
  scheduleLines,
  type TodayRow,
  type TodayScheduleEvent,
  todayNote,
  todayRows,
} from '@/lib/obligations/today-page';
import {
  postObligationAlbatross,
  postObligationDraft,
  postObligationReply,
  requestNeedsYouItem,
  useNeedsYouSnapshot,
} from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { NeedsYouRow } from './NeedsYouRow';
import { COPIED_MS, sonnerNeedsYouNotifier } from './NeedsYouView';
import { TodayNote } from './TodayNote';
import { TodaySchedule, useDayEvents } from './TodaySchedule';
import { useNeedsYou } from './useNeedsYou';
import { type ObligationPost, useObligationActions } from './useObligationActions';
import { TodayWorthKnowing, WorthKnowing } from './WorthKnowing';

/** A row that the user closed stays this long without an Undo window (an answer to an invitation). */
const LEAVE_WITHOUT_UNDO_MS = 1_200;

interface DraftState {
  status: 'loading' | 'ready' | 'error';
  body: string;
}

export interface TodayNeedsYouProps {
  items: readonly ObligationView[];
  extras: readonly NotificationItem[];
  timezone: string;
  now: number;
  post?: ObligationPost;
  loadDraft: (obligation: ObligationView) => Promise<ObligationDraftResponse>;
  sendReply: (obligation: ObligationView, body: string) => Promise<ObligationReplyResponse>;
  startAlbatross: (obligation: ObligationView) => Promise<ObligationAlbatrossResponse>;
  copyText?: (text: string) => Promise<void>;
  /** The row itself: the item on the Needs you page. */
  onOpenItem: (id: string) => void;
  onOpenPage: () => void;
  onOpenWork: (workId: string) => void;
  onAlbatrossAction: (item: NotificationItem, action: NotificationAction) => void;
}

/** The pure list. The preview and the tests drive it; `ConnectedTodayNeedsYou` binds it to the app. */
export function TodayNeedsYou({
  items,
  extras,
  timezone,
  now,
  post,
  loadDraft,
  sendReply,
  startAlbatross,
  copyText = (text) => navigator.clipboard.writeText(text),
  onOpenItem,
  onOpenPage,
  onOpenWork,
  onAlbatrossAction,
}: TodayNeedsYouProps) {
  const actions = useObligationActions({ post, notify: null });
  const reduceMotion = useReducedMotion() ?? false;
  // Rows that the user closed or put off: they stay in place for the Undo
  // window, then leave with a height collapse. The map holds the leave time.
  const [leaving, setLeaving] = useState<
    ReadonlyMap<string, { until: number; word?: string; undoable: boolean; others: ObligationView[] }>
  >(() => new Map());
  const [replyId, setReplyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftState>>(() => new Map());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderRef = useRef<string[]>([]);

  const merged = useMemo(() => actions.merge(items), [actions, items]);
  const groups = useMemo(() => groupNeedsYou(merged, extras, now, timezone), [merged, extras, now, timezone]);
  const list = useMemo(() => todayRows(groups), [groups]);
  const later = useMemo(() => laterOptions(now, timezone), [now, timezone]);

  // The rows in view: the open list, with the rows that leave still in their
  // old place. A row that comes back (Undo) keeps its place too.
  const rows = useMemo(() => {
    const byId = new Map<string, TodayRow<NotificationItem>>();
    for (const row of list.rows) byId.set(row.entry.id, row);
    for (const [id, stay] of leaving) {
      if (byId.has(id)) continue;
      const obligation = merged.find((item) => item.id === id);
      if (obligation) byId.set(id, { entry: { type: 'obligation', id, obligation }, others: stay.others });
    }
    const ordered: TodayRow<NotificationItem>[] = [];
    const seen = new Set<string>();
    for (const id of orderRef.current) {
      const row = byId.get(id);
      if (row && !seen.has(id)) {
        ordered.push(row);
        seen.add(id);
      }
    }
    for (const row of list.rows) {
      if (!seen.has(row.entry.id)) {
        ordered.push(row);
        seen.add(row.entry.id);
      }
    }
    return ordered;
  }, [list.rows, leaving, merged]);
  useEffect(() => {
    orderRef.current = rows.map((row) => row.entry.id);
  }, [rows]);

  // Each leaving row leaves at its time.
  useEffect(() => {
    if (!leaving.size) return;
    const soonest = Math.min(...[...leaving.values()].map((entry) => entry.until));
    const timer = setTimeout(
      () => {
        const at = Date.now();
        setLeaving((current) => {
          const next = new Map(current);
          for (const [id, entry] of current) if (entry.until <= at) next.delete(id);
          return next;
        });
      },
      Math.max(0, soonest - Date.now()) + 20,
    );
    return () => clearTimeout(timer);
  }, [leaving]);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const leave = useCallback(
    (id: string, until: number | undefined, word?: string, others: ObligationView[] = []) => {
      const undoable = Boolean(until && until > Date.now());
      const at = undoable && until ? until : Date.now() + LEAVE_WITHOUT_UNDO_MS;
      setLeaving((current) => new Map(current).set(id, { until: at, word, undoable, others }));
    },
    [],
  );
  // A bundled row acts on all of its notices. It leaves only when the lead
  // closes, so a failed notice stays on the list under its own row.
  const close = useCallback(
    async (
      obligation: ObligationView,
      action: Parameters<typeof actions.act>[1],
      word?: string,
      others: ObligationView[] = [],
    ) => {
      const results = await Promise.all([obligation, ...others].map((member) => actions.act(member, action)));
      if (!results[0]) return;
      const until = action.action === 'rsvp' ? undefined : Date.now() + UNDO_WINDOW_MS;
      leave(
        obligation.id,
        until,
        word,
        others.filter((_, index) => results[index + 1]),
      );
      if (replyId === obligation.id) setReplyId(null);
    },
    [actions, leave, replyId],
  );
  const undo = useCallback(
    async (obligation: ObligationView) => {
      const others = leaving.get(obligation.id)?.others ?? [];
      const results = await Promise.all([obligation, ...others].map((member) => actions.undo(member)));
      if (!results[0]) return;
      setLeaving((current) => {
        const next = new Map(current);
        next.delete(obligation.id);
        return next;
      });
    },
    [actions, leaving],
  );
  const copy = useCallback(
    (obligation: ObligationView) => {
      const value = obligation.code?.value.replace(/\s+/g, '');
      if (!value) return;
      // The default can throw at once: an insecure page has no clipboard.
      void Promise.resolve()
        .then(() => copyText(value))
        .then(
          () => {
            setCopiedId(obligation.id);
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopiedId(null), COPIED_MS);
          },
          () => sonnerNeedsYouNotifier.info('Could not copy the code.', 'Select the code and copy it.'),
        );
    },
    [copyText],
  );
  const openReply = useCallback(
    (obligation: ObligationView) => {
      setReplyId((current) => (current === obligation.id ? null : obligation.id));
      if (drafts.has(obligation.id)) return;
      setDrafts((current) => new Map(current).set(obligation.id, { status: 'loading', body: '' }));
      loadDraft(obligation).then(
        (response) =>
          setDrafts((current) =>
            new Map(current).set(obligation.id, { status: 'ready', body: response.draft.body }),
          ),
        () => setDrafts((current) => new Map(current).set(obligation.id, { status: 'error', body: '' })),
      );
    },
    [drafts, loadDraft],
  );
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const send = useCallback(
    async (obligation: ObligationView) => {
      const body = drafts.get(obligation.id)?.body.trim();
      if (!body) return;
      setSending(obligation.id);
      setSendError(null);
      try {
        const response = await sendReply(obligation, body);
        actions.override(response.obligation);
        leave(obligation.id, response.undoUntil);
        setReplyId(null);
      } catch (caught) {
        setSendError(
          caught instanceof Error && caught.message ? caught.message : 'Could not send the reply.',
        );
      } finally {
        setSending(null);
      }
    },
    [drafts, sendReply, actions, leave],
  );
  const start = useCallback(
    async (obligation: ObligationView) => {
      const response = await startAlbatross(obligation).catch(() => null);
      if (!response) return;
      actions.override(response.obligation);
      onOpenWork(response.workId);
    },
    [startAlbatross, actions, onOpenWork],
  );

  if (!rows.length) return null;
  const errorFor = (id: string) => (actions.error?.id === id ? actions.error.text : null);

  return (
    <section data-today-needs-you aria-label="Needs you" className="@container min-w-0">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h2 className="font-display text-[17px] font-medium tracking-tight text-[var(--color-text)]">
          Needs you
          {list.open > 0 ? (
            <span className="ml-2 font-sans text-[12.5px] font-normal tabular-nums text-[var(--color-text-muted)]">
              {list.more > 0 ? `${list.rows.length} of ${list.open}` : list.open}
            </span>
          ) : null}
        </h2>
      </div>
      <ul className="border-t border-[var(--color-border)]">
        <AnimatePresence initial={false}>
          {rows.map((row, rowIndex) => {
            const { entry, others } = row;
            const obligation = entry.type === 'obligation' ? entry.obligation : null;
            const leavingEntry = leaving.get(entry.id);
            const closed = obligation ? isClosedObligation(obligation) : false;
            const open = obligation && !closed && !leavingEntry ? obligation : null;
            const undoWord =
              leavingEntry && obligation && !closed
                ? (leavingEntry.word ?? 'Later')
                : closed
                  ? closeReasonLabel(obligation?.closeReason)
                  : undefined;
            const canUndo = Boolean(
              leavingEntry?.undoable && obligation && leavingEntry.until > now - 100 && undoWord,
            );
            return (
              <motion.li
                key={entry.id}
                layout={!reduceMotion}
                initial={false}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <ul>
                  <NeedsYouRow
                    entry={entry}
                    now={now}
                    timezone={timezone}
                    selected={false}
                    focusable
                    flush
                    pillsAlways
                    actionsInline
                    bundled={others.length}
                    lead={rowIndex === 0}
                    draftReady={obligation ? obligation.draftReady === true : false}
                    copied={copiedId === entry.id}
                    busy={actions.busyId === entry.id || sending === entry.id}
                    onOpen={() =>
                      entry.type === 'albatross'
                        ? entry.item.action && onAlbatrossAction(entry.item, entry.item.action)
                        : onOpenItem(entry.id)
                    }
                    onKeyDown={() => undefined}
                    onDone={open ? () => void close(open, { action: 'done' }, undefined, others) : undefined}
                    onCopy={open?.kind === 'code' ? () => copy(open) : undefined}
                    onRsvp={
                      open?.kind === 'rsvp'
                        ? (response) => void close(open, { action: 'rsvp', response }, `Answered ${response}`)
                        : undefined
                    }
                    onStartAlbatross={open?.workId ? () => void start(open) : undefined}
                    onReply={open && canSendReply(open) ? () => openReply(open) : undefined}
                    laterOptions={later}
                    onLater={
                      open
                        ? (option: LaterOption) =>
                            void close(open, { action: 'later', until: option.until }, 'Later', others)
                        : undefined
                    }
                    onAlbatrossAction={
                      entry.type === 'albatross' && entry.item.action
                        ? () => onAlbatrossAction(entry.item, entry.item.action as NotificationAction)
                        : undefined
                    }
                    albatrossActionLabel={entry.type === 'albatross' ? 'Answer' : undefined}
                    onUndo={canUndo && obligation ? () => void undo(obligation) : undefined}
                    undoWord={canUndo ? undoWord : undefined}
                    registerRef={() => undefined}
                  />
                </ul>
                {errorFor(entry.id) ? (
                  <p role="alert" className="px-0 pb-2 text-[12px] text-[var(--color-danger)]">
                    {errorFor(entry.id)}
                  </p>
                ) : null}
                {open && replyId === entry.id ? (
                  <ReplyInPlace
                    obligation={open}
                    draft={drafts.get(entry.id)}
                    busy={sending === entry.id}
                    error={sendError}
                    onChange={(body) =>
                      setDrafts((current) => new Map(current).set(entry.id, { status: 'ready', body }))
                    }
                    onSend={() => void send(open)}
                    onCancel={() => setReplyId(null)}
                  />
                ) : null}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {list.more > 0 ? (
        <button
          type="button"
          data-today-more
          onClick={onOpenPage}
          className="mt-1 rounded-ui py-2.5 text-[13px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
        >
          View all
        </button>
      ) : null}
    </section>
  );
}

/** The live page under the painting: the note, the list, and the day. */
export function TodayLive({
  events,
  onOpenCalendar,
  ...list
}: TodayNeedsYouProps & {
  events: readonly TodayScheduleEvent[] | undefined;
  onOpenCalendar: () => void;
}) {
  const { items, extras, timezone, now } = list;
  const worthKnowing = useContext(TodayWorthKnowing);
  const groups = useMemo(() => groupNeedsYou(items, extras, now, timezone), [items, extras, now, timezone]);
  const summary = useMemo(() => todayRows(groups), [groups]);
  const lines = useMemo(() => scheduleLines(events ?? [], now), [events, now]);
  const note = useMemo(
    () => (events ? todayNote({ rows: summary.rows, open: summary.open, lines, now, timezone }) : null),
    [events, summary, lines, now, timezone],
  );
  return (
    <div data-today-live className="@container/today">
      <TodayNote note={note} />
      <div
        data-today-grid
        className="mt-6 grid gap-x-12 gap-y-8 @[860px]/today:grid-cols-[minmax(0,1fr)_288px]"
      >
        <TodayNeedsYou {...list} />
        <div data-today-aside className="flex min-w-0 flex-col gap-8">
          <TodaySchedule events={events} now={now} timezone={timezone} onOpen={onOpenCalendar} />
          <WorthKnowing items={worthKnowing} />
        </div>
      </div>
    </div>
  );
}

/** The prepared draft under the row: a plain field, Send reply, Cancel. */
function ReplyInPlace({
  obligation,
  draft,
  busy,
  error,
  onChange,
  onSend,
  onCancel,
}: {
  obligation: ObligationView;
  draft: DraftState | undefined;
  busy: boolean;
  error: string | null;
  onChange: (body: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const loading = !draft || draft.status === 'loading';
  return (
    <div
      data-today-reply={obligation.id}
      className="corner-smooth surface-accent mb-3 ml-[40px] rounded-ui border border-[var(--surface-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]"
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--surface-border)] px-3.5 py-2.5">
        <span className="text-[11px] font-semibold text-[var(--color-accent)]">Draft reply</span>
        <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-muted)]">
          To {obligation.asker}
        </span>
      </div>
      <div className="px-3.5 pb-3 pt-3">
        {loading ? (
          <p role="status" className="text-[12.5px] text-[var(--color-text-muted)]">
            Preparing a draft…
          </p>
        ) : (
          <>
            {draft.status === 'error' ? (
              <p className="mb-2 text-[12px] text-[var(--color-text-muted)]">
                Could not prepare a draft. Write the reply here.
              </p>
            ) : null}
            <textarea
              aria-label="Draft reply"
              value={draft.body}
              placeholder="Write the reply here."
              onChange={(event) => onChange(event.target.value)}
              className="field-sizing-content min-h-20 w-full resize-none bg-transparent p-0 text-[13.5px] leading-[1.6] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
            />
          </>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-[12px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        <div className="mt-2.5 flex items-center gap-2">
          <Button size="sm" disabled={busy || loading || !draft.body.trim()} onClick={onSend}>
            Send reply
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <span className="ml-auto text-[11.5px] text-[var(--color-text-faint)]">
            Sends in the thread. Undo for 10 seconds.
          </span>
        </div>
      </div>
    </div>
  );
}

/** The list bound to the app: the same routes as the page. */
function ConnectedTodayNeedsYou({ data }: { data: ReturnType<typeof useNeedsYou> }) {
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const { onAction } = useNotificationActions();
  const onOpenItem = useCallback(
    (id: string) => {
      requestNeedsYouItem(id);
      setPrimaryView('notifications');
    },
    [setPrimaryView],
  );
  const onOpenPage = useCallback(() => setPrimaryView('notifications'), [setPrimaryView]);
  const onOpenWork = useCallback(
    (workId: string) => {
      setSelectedWorkId(workId);
      setPrimaryView('albatrosses');
    },
    [setSelectedWorkId, setPrimaryView],
  );
  // A question or an approval opens its Albatross. A check-in opens the page, which hosts the check-in.
  const onAlbatrossAction = useCallback(
    (item: NotificationItem, action: NotificationAction) => {
      if (action.kind === 'checkin') onOpenItem(item.id);
      else void onAction(action);
    },
    [onAction, onOpenItem],
  );
  const onOpenCalendar = useCallback(() => setPrimaryView('calendar'), [setPrimaryView]);
  const snapshot = data.snapshot;
  const events = useDayEvents(data.nowMs, snapshot?.timezone);
  if (!snapshot?.enabled) return null;
  return (
    <TodayLive
      items={snapshot.items}
      extras={data.extras}
      timezone={snapshot.timezone}
      now={data.nowMs}
      events={events}
      onOpenCalendar={onOpenCalendar}
      loadDraft={(obligation) => postObligationDraft(obligation.id)}
      sendReply={(obligation, body) => postObligationReply(obligation.id, body)}
      startAlbatross={(obligation) => postObligationAlbatross(obligation.id)}
      onOpenItem={onOpenItem}
      onOpenPage={onOpenPage}
      onOpenWork={onOpenWork}
      onAlbatrossAction={onAlbatrossAction}
    />
  );
}

/** The list with its data: mounts only for a user in the flag, so nobody else starts the second read. */
function LiveTodayNeedsYou() {
  // Counts and rows only: no current-move read.
  const data = useNeedsYou({ execution: false });
  return <ConnectedTodayNeedsYou data={data} />;
}

/** One provider at all times: the brief under it never mounts again when the snapshot arrives. */
function LayerChooser({ children }: { children: ReactNode }) {
  const snapshot = useNeedsYouSnapshot();
  const loading = snapshot === undefined;
  const enabled = snapshot?.enabled === true;
  const value = useMemo(
    () => ({
      node: enabled ? <LiveTodayNeedsYou /> : null,
      // A user outside the flag has no live list, so a stored lane stays: an edition
      // moved its threads out of the other lanes. A user in the flag sees no lane flash.
      hideNeedsYou: loading || enabled,
      // The stories stay away too while the first read runs, so they never flash.
      replacesDocument: loading || enabled,
    }),
    [enabled, loading],
  );
  return <BriefLiveLayer.Provider value={value}>{children}</BriefLiveLayer.Provider>;
}

/**
 * Today wraps the brief in this layer. For a user in LAB86_NEEDS_YOU the
 * brief canvas shows the live list under the masthead and hides the stored
 * lane. Everyone else sees no change, and so does everyone when the snapshot
 * cannot load.
 */
export function TodayNeedsYouLayer({ children }: { children: ReactNode }) {
  return (
    <NeedsYouGate fallback={children}>
      <LayerChooser>{children}</LayerChooser>
    </NeedsYouGate>
  );
}
