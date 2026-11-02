'use client';

// The live Needs you list on Today (docs/research/needs-you-web-2-design-2026-11-02.md).
// The morning letter stores a copy of the list with no Done. This list reads
// the same subscription as the page, so it is live, and it acts in place:
// Done, Later, Reply with the prepared draft, Copy, Yes and No, Undo. It sits
// under the masthead and before the lede, in the measure of the letter. An
// empty list takes no space.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  groupNeedsYou,
  isClosedObligation,
  type LaterOption,
  laterOptions,
  type NeedsYouEntry,
  needsYouSummary,
} from '@/lib/obligations/groups';
import { canSendReply, closeReasonLabel } from '@/lib/obligations/labels';
import { todayNeedsYouFoot, todayNeedsYouHead, todayNeedsYouList } from '@/lib/obligations/surfaces';
import {
  postObligationAlbatross,
  postObligationDraft,
  postObligationReply,
  requestNeedsYouItem,
  useNeedsYouSnapshot,
} from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { NeedsYouRow } from './NeedsYouRow';
import { COPIED_MS } from './NeedsYouView';
import { useNeedsYou } from './useNeedsYou';
import { type ObligationPost, useObligationActions } from './useObligationActions';

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
  const [leaving, setLeaving] = useState<ReadonlyMap<string, { until: number; word?: string }>>(
    () => new Map(),
  );
  const [replyId, setReplyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftState>>(() => new Map());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderRef = useRef<string[]>([]);

  const merged = useMemo(() => actions.merge(items), [actions, items]);
  const groups = useMemo(() => groupNeedsYou(merged, extras, now, timezone), [merged, extras, now, timezone]);
  const summary = useMemo(() => needsYouSummary(groups), [groups]);
  const list = useMemo(() => todayNeedsYouList(groups), [groups]);
  const later = useMemo(() => laterOptions(now, timezone), [now, timezone]);

  // The rows in view: the open list, with the rows that leave still in their
  // old place. A row that comes back (Undo) keeps its place too.
  const rows = useMemo(() => {
    const byId = new Map<string, NeedsYouEntry<NotificationItem>>();
    for (const entry of list.entries) byId.set(entry.id, entry);
    for (const [id] of leaving) {
      if (byId.has(id)) continue;
      const obligation = merged.find((item) => item.id === id);
      if (obligation) byId.set(id, { type: 'obligation', id, obligation });
    }
    const ordered: NeedsYouEntry<NotificationItem>[] = [];
    const seen = new Set<string>();
    for (const id of orderRef.current) {
      const entry = byId.get(id);
      if (entry && !seen.has(id)) {
        ordered.push(entry);
        seen.add(id);
      }
    }
    for (const entry of list.entries) {
      if (!seen.has(entry.id)) {
        ordered.push(entry);
        seen.add(entry.id);
      }
    }
    return ordered;
  }, [list.entries, leaving, merged]);
  useEffect(() => {
    orderRef.current = rows.map((row) => row.id);
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

  const leave = useCallback((id: string, until: number | undefined, word?: string) => {
    const at = until && until > Date.now() ? until : Date.now() + LEAVE_WITHOUT_UNDO_MS;
    setLeaving((current) => new Map(current).set(id, { until: at, word }));
  }, []);
  const close = useCallback(
    async (obligation: ObligationView, action: Parameters<typeof actions.act>[1], word?: string) => {
      const ok = await actions.act(obligation, action);
      if (!ok) return;
      const until = action.action === 'rsvp' ? undefined : Date.now() + UNDO_WINDOW_MS;
      leave(obligation.id, until, word);
      if (replyId === obligation.id) setReplyId(null);
    },
    [actions, leave, replyId],
  );
  const undo = useCallback(
    async (obligation: ObligationView) => {
      const ok = await actions.undo(obligation);
      if (!ok) return;
      setLeaving((current) => {
        const next = new Map(current);
        next.delete(obligation.id);
        return next;
      });
    },
    [actions],
  );
  const copy = useCallback(
    (obligation: ObligationView) => {
      const value = obligation.code?.value.replace(/\s+/g, '');
      if (!value) return;
      void copyText(value).then(() => {
        setCopiedId(obligation.id);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopiedId(null), COPIED_MS);
      });
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

  const head = todayNeedsYouHead(summary, list.dueToday);
  const foot = todayNeedsYouFoot(list.more);
  if (!rows.length) return null;
  const errorFor = (id: string) => (actions.error?.id === id ? actions.error.text : null);

  return (
    <section data-today-needs-you aria-label="Needs you" className="mb-9">
      {head ? (
        <h2 className="text-pretty font-display text-[19px] font-medium leading-[1.3] tracking-tight text-[var(--color-text)]">
          {head}
        </h2>
      ) : null}
      <ul className="mt-2 border-t border-[var(--color-border)]">
        <AnimatePresence initial={false}>
          {rows.map((entry) => {
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
            const canUndo = Boolean(leavingEntry && obligation && leavingEntry.until > now - 100 && undoWord);
            return (
              <motion.li
                key={entry.id}
                layout={!reduceMotion}
                initial={false}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <ul className="-mx-5">
                  <NeedsYouRow
                    entry={entry}
                    now={now}
                    timezone={timezone}
                    selected={false}
                    focusable
                    pillsAlways
                    draftReady={obligation ? obligation.draftReady === true : false}
                    copied={copiedId === entry.id}
                    busy={actions.busyId === entry.id || sending === entry.id}
                    onOpen={() =>
                      entry.type === 'albatross'
                        ? entry.item.action && onAlbatrossAction(entry.item, entry.item.action)
                        : onOpenItem(entry.id)
                    }
                    onKeyDown={() => undefined}
                    onDone={open ? () => void close(open, { action: 'done' }) : undefined}
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
                            void close(open, { action: 'later', until: option.until }, 'Later')
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
      {foot ? (
        <p className="mt-2.5 text-[12.5px] text-[var(--color-text-muted)]">
          <button
            type="button"
            onClick={onOpenPage}
            className="underline-offset-2 hover:text-[var(--color-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
          >
            {foot}
          </button>
        </p>
      ) : null}
    </section>
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
      className="corner-smooth surface-accent mb-3 ml-10 rounded-ui border border-[var(--surface-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]"
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
  const snapshot = data.snapshot;
  if (!snapshot?.enabled) return null;
  return (
    <TodayNeedsYou
      items={snapshot.items}
      extras={data.extras}
      timezone={snapshot.timezone}
      now={data.nowMs}
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

function LayerWhenEnabled({ children }: { children: ReactNode }) {
  // Counts and rows only: no current-move read.
  const data = useNeedsYou({ execution: false });
  const enabled = data.snapshot?.enabled === true;
  const value = useMemo(
    () => ({
      node: enabled ? <ConnectedTodayNeedsYou data={data} /> : null,
      // A user outside the flag has no stored lane, so the hide costs nothing
      // while the snapshot loads; a user in the flag sees no lane flash.
      hideNeedsYou: data.snapshot === undefined || enabled,
    }),
    [data, enabled],
  );
  return <BriefLiveLayer.Provider value={value}>{children}</BriefLiveLayer.Provider>;
}

/** Reads only the snapshot first: a user outside the flag starts no second notification read. */
function LayerChooser({ children }: { children: ReactNode }) {
  const snapshot = useNeedsYouSnapshot();
  if (snapshot !== undefined && !snapshot.enabled) return <>{children}</>;
  return <LayerWhenEnabled>{children}</LayerWhenEnabled>;
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
