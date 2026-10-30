'use client';

import { ArrowUpRight } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { NotificationAction, NotificationItem } from '@/components/notifications/model';
import { Button } from '@/components/ui/button';
import type {
  ObligationAction,
  ObligationActionResponse,
  ObligationDraftResponse,
  ObligationReplyResponse,
  ObligationView,
} from '@/lib/obligations/contract';
import {
  groupNeedsYou,
  isClosedObligation,
  type LaterOption,
  laterOptions,
  type NeedsYouGroup,
  needsYouSummary,
} from '@/lib/obligations/groups';
import { cn } from '@/lib/utils';
import { AlbatrossDetail, type DraftState, EmptyDetail, ObligationDetail } from './NeedsYouDetail';
import { ClosedGroupHead, GroupHead, type NeedsYouListEntry, NeedsYouRow } from './NeedsYouRow';

/** A group shows this many rows, then "Show N more". */
export const NEEDS_YOU_ROW_CAP = 20;
/** "Copied" stays on the button this long. */
export const COPIED_MS = 2000;

/** The toasts of the page. The default uses sonner; tests pass a record. */
export interface NeedsYouNotifier {
  undo(input: { title: string; description?: string; until: number; onUndo: () => Promise<void> }): void;
  info(message: string, description?: string): void;
  error(message: string): void;
}

export const sonnerNeedsYouNotifier: NeedsYouNotifier = {
  undo: ({ title, description, until, onUndo }) =>
    toast(title, {
      description,
      duration: Math.max(1_000, until - Date.now()),
      action: {
        label: 'Undo',
        onClick: () => {
          void onUndo().catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : 'Could not undo this.'),
          );
        },
      },
    }),
  info: (message, description) => toast(message, description ? { description } : undefined),
  error: (message) => toast.error(message),
};

function defaultCopy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export interface NeedsYouViewProps {
  items: readonly ObligationView[];
  extras: readonly NotificationItem[];
  timezone: string;
  now: number;
  isLoading?: boolean;
  storageKey?: string;
  /** Set by the arrival toast: open this item. */
  openRequest?: { id: string; at: number } | null;
  onObligationAction: (
    obligation: ObligationView,
    action: ObligationAction,
  ) => Promise<ObligationActionResponse>;
  onLoadDraft: (obligation: ObligationView) => Promise<ObligationDraftResponse>;
  onSendReply: (obligation: ObligationView, body: string) => Promise<ObligationReplyResponse>;
  onOpenSource: (obligation: ObligationView) => void;
  onAlbatrossAction: (action: NotificationAction) => Promise<void> | void;
  onOpenActivity?: () => void;
  notify?: NeedsYouNotifier;
  copyText?: (text: string) => Promise<void>;
}

type ListGroup = NeedsYouGroup<NotificationItem> & { shown: NeedsYouListEntry[] };

function isEditable(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  return node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable === true;
}

function restoreSelected(storageKey: string | undefined): string | null {
  if (!storageKey) return null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    const value = raw ? JSON.parse(raw) : null;
    return typeof value?.selectedId === 'string' && value.selectedId.length < 600 ? value.selectedId : null;
  } catch {
    return null;
  }
}

/**
 * The Needs you page: the list with its groups, the detail, the actions with
 * Undo, and the keys. Pure in the sense of the Notifications view: every
 * side effect is a prop, so the preview and the tests drive it.
 */
export function NeedsYouView({
  items,
  extras,
  timezone,
  now,
  isLoading = false,
  storageKey,
  openRequest,
  onObligationAction,
  onLoadDraft,
  onSendReply,
  onOpenSource,
  onAlbatrossAction,
  onOpenActivity,
  notify = sonnerNeedsYouNotifier,
  copyText = defaultCopy,
}: NeedsYouViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ObligationView>>(() => new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftState>>(() => new Map());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailRef = useRef<HTMLElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const handledRequest = useRef<number | null>(null);
  const draftRequests = useRef(new Set<string>());

  useEffect(() => {
    const restored = restoreSelected(storageKey);
    if (restored) setSelectedId(restored);
  }, [storageKey]);
  useEffect(() => {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ selectedId }));
    } catch {
      /* View state is optional. */
    }
  }, [storageKey, selectedId]);
  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest.at) return;
    handledRequest.current = openRequest.at;
    setSelectedId(openRequest.id);
    setError(null);
  }, [openRequest]);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // What the user just did shows at once; the server row replaces it when it
  // catches up.
  const merged = useMemo(
    () =>
      items.map((item) => {
        const override = overrides.get(item.id);
        return override && override.updatedAt > item.updatedAt ? override : item;
      }),
    [items, overrides],
  );
  const groups = useMemo(() => groupNeedsYou(merged, extras, now, timezone), [merged, extras, now, timezone]);
  const summary = useMemo(() => needsYouSummary(groups), [groups]);
  const later = useMemo(() => laterOptions(now, timezone), [now, timezone]);
  const listGroups: ListGroup[] = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        shown:
          group.id === 'closed_today' && !closedOpen
            ? []
            : expanded.has(group.id)
              ? group.entries
              : group.entries.slice(0, NEEDS_YOU_ROW_CAP),
      })),
    [groups, closedOpen, expanded],
  );
  const flat = useMemo(() => listGroups.flatMap((group) => group.shown), [listGroups]);
  const allEntries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const selected = allEntries.find((entry) => entry.id === selectedId) ?? null;
  const focusable = flat.find((entry) => entry.id === selectedId)?.id ?? flat[0]?.id ?? null;
  const hasOpenItems = groups.some((group) => group.id !== 'closed_today');

  const applyOverride = useCallback((obligation: ObligationView) => {
    setOverrides((current) => new Map(current).set(obligation.id, obligation));
  }, []);

  const selectAfter = useCallback(
    (id: string) => {
      if (selectedId !== id) return;
      const index = flat.findIndex((entry) => entry.id === id);
      const next = flat[index + 1] ?? flat[index - 1] ?? null;
      setSelectedId(next && next.id !== id ? next.id : null);
    },
    [flat, selectedId],
  );

  const focusRow = useCallback((id: string | null) => {
    if (!id) return;
    rowRefs.current.get(id)?.focus({ preventScroll: false });
  }, []);

  const open = useCallback((entry: NeedsYouListEntry) => {
    setSelectedId(entry.id);
    setError(null);
    setLaterOpen(false);
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
      requestAnimationFrame(() => detailRef.current?.focus());
    }
  }, []);

  const goBack = useCallback(() => {
    const previous = selectedId;
    setSelectedId(null);
    setError(null);
    setLaterOpen(false);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => focusRow(previous ?? flat[0]?.id ?? null));
    }
  }, [selectedId, flat, focusRow]);

  const move = useCallback(
    (from: string | null, step: number | 'home' | 'end') => {
      if (!flat.length) return;
      const index = flat.findIndex((entry) => entry.id === from);
      const target =
        step === 'home'
          ? 0
          : step === 'end'
            ? flat.length - 1
            : Math.min(flat.length - 1, Math.max(0, (index < 0 ? -1 : index) + step));
      focusRow(flat[target]?.id ?? null);
    },
    [flat, focusRow],
  );

  const perform = useCallback(
    async (id: string, operation: () => Promise<void>, failure: string) => {
      if (busyId) return;
      setBusyId(id);
      setError(null);
      retryRef.current = operation;
      try {
        await operation();
        retryRef.current = null;
      } catch (caught) {
        setError(caught instanceof Error && caught.message ? caught.message : failure);
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  const close = useCallback(
    (obligation: ObligationView, action: ObligationAction, title: string, description?: string) =>
      perform(
        obligation.id,
        async () => {
          const response = await onObligationAction(obligation, action);
          applyOverride(response.obligation);
          selectAfter(obligation.id);
          const until = response.undoUntil;
          if (until && until > Date.now()) {
            notify.undo({
              title,
              description,
              until,
              onUndo: async () => {
                const undone = await onObligationAction(obligation, { action: 'undo' });
                applyOverride(undone.obligation);
              },
            });
          } else notify.info(title, description);
        },
        'Could not save this change. Nothing has changed.',
      ),
    [perform, onObligationAction, applyOverride, selectAfter, notify],
  );

  const done = useCallback(
    (obligation: ObligationView) =>
      close(
        obligation,
        { action: 'done' },
        'Done',
        obligation.kind === 'reply' ? 'No reply sent.' : undefined,
      ),
    [close],
  );
  const snooze = useCallback(
    (obligation: ObligationView, option: LaterOption) =>
      close(
        obligation,
        { action: 'later', until: option.until },
        'Later',
        `Back ${option.label.toLowerCase()}.`,
      ),
    [close],
  );
  const notMine = useCallback(
    (obligation: ObligationView) =>
      close(obligation, { action: 'not_mine' }, 'Not mine', 'This thread will not ask you again.'),
    [close],
  );
  const sendReply = useCallback(
    (obligation: ObligationView) => {
      const draft = drafts.get(obligation.id);
      const body = draft?.body.trim();
      if (!body) return;
      return perform(
        obligation.id,
        async () => {
          const response = await onSendReply(obligation, body);
          applyOverride(response.obligation);
          selectAfter(obligation.id);
          const until = response.undoUntil;
          if (until && until > Date.now()) {
            notify.undo({
              title: 'Replied',
              description: 'Sent in the thread.',
              until,
              onUndo: async () => {
                const undone = await onObligationAction(obligation, { action: 'undo' });
                applyOverride(undone.obligation);
              },
            });
          } else notify.info('Replied', 'Sent in the thread.');
        },
        'Could not send the reply. The draft is still here.',
      );
    },
    [drafts, perform, onSendReply, applyOverride, selectAfter, notify, onObligationAction],
  );
  const copy = useCallback(
    (obligation: ObligationView) => {
      const value = obligation.code?.value.replace(/\s+/g, '');
      if (!value) return;
      void copyText(value).then(
        () => {
          setCopiedId(obligation.id);
          if (copiedTimer.current) clearTimeout(copiedTimer.current);
          copiedTimer.current = setTimeout(() => setCopiedId(null), COPIED_MS);
        },
        () => notify.error('Could not copy the code.'),
      );
    },
    [copyText, notify],
  );
  const albatross = useCallback(
    (item: NotificationItem) => {
      if (!item.action) return;
      const action = item.action;
      return perform(
        item.id,
        async () => {
          await onAlbatrossAction(action);
        },
        'Could not open this. Please try again.',
      );
    },
    [perform, onAlbatrossAction],
  );

  // A reply opens with its prepared draft. One request for each item; the
  // answer lands by id, so a re-render never cancels it.
  useEffect(() => {
    if (!selected || selected.type !== 'obligation') return;
    const { obligation } = selected;
    if (obligation.kind !== 'reply' || isClosedObligation(obligation)) return;
    if (drafts.has(obligation.id) || draftRequests.current.has(obligation.id)) return;
    draftRequests.current.add(obligation.id);
    setDrafts((current) =>
      new Map(current).set(obligation.id, { status: 'loading', to: [], body: '', edited: false }),
    );
    onLoadDraft(obligation).then(
      (response) => {
        setDrafts((current) =>
          new Map(current).set(obligation.id, {
            status: 'ready',
            to: response.draft.to,
            body: response.draft.body,
            edited: false,
          }),
        );
      },
      () => {
        setDrafts((current) =>
          new Map(current).set(obligation.id, { status: 'error', to: [], body: '', edited: false }),
        );
      },
    );
  }, [selected, drafts, onLoadDraft]);

  const primary = useCallback(
    (entry: NeedsYouListEntry) => {
      if (entry.type === 'albatross') return void albatross(entry.item);
      const { obligation } = entry;
      if (isClosedObligation(obligation)) return;
      if (obligation.kind === 'code') return copy(obligation);
      if (obligation.kind === 'reply') return void sendReply(obligation);
      void done(obligation);
    },
    [albatross, copy, sendReply, done],
  );

  const actOnKey = useCallback(
    (event: KeyboardEvent<HTMLElement>, entry: NeedsYouListEntry | null): boolean => {
      if (!entry || entry.type !== 'obligation' || isClosedObligation(entry.obligation)) return false;
      if (event.key === 'e') {
        void done(entry.obligation);
        return true;
      }
      if (event.key === 'l') {
        if (entry.obligation.kind === 'code') return false;
        open(entry);
        setLaterOpen(true);
        return true;
      }
      return false;
    },
    [done, open],
  );

  const onRowKey = (event: KeyboardEvent<HTMLElement>, entry: NeedsYouListEntry) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        move(entry.id, 1);
        break;
      case 'ArrowUp':
      case 'k':
        move(entry.id, -1);
        break;
      case 'Home':
        move(entry.id, 'home');
        break;
      case 'End':
        move(entry.id, 'end');
        break;
      case 'Enter':
        open(entry);
        break;
      case 'Escape':
        if (selected) goBack();
        else handled = false;
        break;
      default:
        handled = actOnKey(event, entry);
    }
    if (handled) event.preventDefault();
  };

  const onDetailKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      goBack();
      return;
    }
    if (!selected) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      primary(selected);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
    if (actOnKey(event, selected)) event.preventDefault();
  };

  const busy = (id: string) => busyId === id;
  const retry = () => {
    const operation = retryRef.current;
    if (operation && selected)
      void perform(selected.id, operation, 'Still could not save this. Please try again.');
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-content)]" data-needs-you-workspace>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] bg-[var(--color-content)] px-5 py-3 sm:px-7">
        <h1 className="font-serif text-[20px] tracking-tight text-[var(--color-text)]">Needs you</h1>
        <p className="text-[12.5px] text-[var(--color-text-muted)]" aria-live="polite">
          {isLoading ? (
            'Finding what needs you'
          ) : (
            <>
              <b className="font-medium text-[var(--color-text)]">{summary.now} now</b> · {summary.open} open
              · {summary.closedToday} closed today
            </>
          )}
        </p>
        {onOpenActivity ? (
          <Button variant="outline" size="sm" onClick={onOpenActivity} className="ml-auto shrink-0">
            Activity history <ArrowUpRight className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          data-needs-you-list
          className={cn(
            'min-h-0 w-full shrink-0 overflow-y-auto overscroll-contain lg:block lg:w-[min(42%,440px)] lg:border-r lg:border-[var(--color-border)]',
            selected && 'hidden',
          )}
        >
          {isLoading ? (
            <div role="status" className="space-y-6 px-5 py-8">
              <span className="sr-only">Finding what needs you</span>
              {[0, 1, 2, 3, 4].map((key) => (
                <div key={key} className="space-y-2">
                  <div className="h-3 w-4/5 rounded bg-[var(--color-control)]" />
                  <div className="h-2.5 w-1/2 rounded bg-[var(--color-control)]" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {!hasOpenItems ? (
                <p className="px-5 py-7 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  Nothing needs you right now.
                </p>
              ) : null}
              {listGroups.map((group, index) => (
                <section key={group.id} aria-label={group.label}>
                  {group.id === 'closed_today' ? (
                    <ClosedGroupHead
                      count={group.entries.length}
                      open={closedOpen}
                      onToggle={() => setClosedOpen((value) => !value)}
                    />
                  ) : (
                    <GroupHead group={group} first={index === 0} />
                  )}
                  {group.shown.length ? (
                    <ul>
                      {group.shown.map((entry) => {
                        const obligation = entry.type === 'obligation' ? entry.obligation : null;
                        const openObligation =
                          obligation && !isClosedObligation(obligation) ? obligation : null;
                        return (
                          <NeedsYouRow
                            key={entry.id}
                            entry={entry}
                            now={now}
                            timezone={timezone}
                            selected={selectedId === entry.id}
                            focusable={focusable === entry.id}
                            draftReady={obligation ? drafts.get(obligation.id)?.status === 'ready' : false}
                            copied={copiedId === entry.id}
                            busy={busy(entry.id)}
                            onOpen={() => open(entry)}
                            onKeyDown={(event) => onRowKey(event, entry)}
                            onDone={openObligation ? () => void done(openObligation) : undefined}
                            onCopy={openObligation?.kind === 'code' ? () => copy(openObligation) : undefined}
                            registerRef={(node) => {
                              if (node) rowRefs.current.set(entry.id, node);
                              else rowRefs.current.delete(entry.id);
                            }}
                          />
                        );
                      })}
                    </ul>
                  ) : null}
                  {group.shown.length && group.shown.length < group.entries.length ? (
                    <div className="px-5 py-3">
                      <button
                        type="button"
                        onClick={() => setExpanded((current) => new Set([...current, group.id]))}
                        className="text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
                      >
                        Show {group.entries.length - group.shown.length} more
                      </button>
                    </div>
                  ) : null}
                </section>
              ))}
            </>
          )}
        </div>
        <section
          ref={detailRef}
          tabIndex={-1}
          aria-label="Details"
          onKeyDown={onDetailKey}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none lg:block',
            !selected && 'hidden',
          )}
        >
          {selected ? (
            <div className="mx-auto flex min-h-full max-w-[720px] flex-col px-5 py-5 sm:px-8 sm:py-7">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 mb-6 h-11 self-start lg:hidden"
                onClick={goBack}
              >
                Back to the list
              </Button>
              {selected.type === 'albatross' ? (
                <AlbatrossDetail
                  item={selected.item}
                  now={now}
                  timezone={timezone}
                  busy={busy(selected.id)}
                  error={error}
                  onAction={() => void albatross(selected.item)}
                  onRetry={retryRef.current ? retry : undefined}
                />
              ) : (
                <ObligationDetail
                  obligation={selected.obligation}
                  now={now}
                  timezone={timezone}
                  draft={drafts.get(selected.id)}
                  busy={busy(selected.id)}
                  error={error}
                  copied={copiedId === selected.id}
                  laterOpen={laterOpen}
                  laterOptions={later}
                  onLaterOpenChange={setLaterOpen}
                  onDone={() => void done(selected.obligation)}
                  onLater={(option) => void snooze(selected.obligation, option)}
                  onNotMine={() => void notMine(selected.obligation)}
                  onSendReply={() => void sendReply(selected.obligation)}
                  onDraftChange={(body) =>
                    setDrafts((current) => {
                      const draft = current.get(selected.id);
                      return new Map(current).set(selected.id, {
                        status: draft?.status === 'loading' ? 'ready' : (draft?.status ?? 'ready'),
                        to: draft?.to ?? [],
                        body,
                        edited: true,
                      });
                    })
                  }
                  onCopy={() => copy(selected.obligation)}
                  onOpenSource={() => onOpenSource(selected.obligation)}
                  onRetry={retryRef.current ? retry : undefined}
                />
              )}
            </div>
          ) : (
            <EmptyDetail hasItems={hasOpenItems} />
          )}
        </section>
      </div>
    </div>
  );
}
