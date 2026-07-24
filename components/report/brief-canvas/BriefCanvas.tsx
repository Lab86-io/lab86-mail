'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Newspaper } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';
import { briefQueryKeys, briefRefKey, collectBriefRefs, hydratedEntityKey } from '@/lib/brief/hydration';
import { useClientStore } from '@/lib/client-state';
import { briefActionTier, isKnownBriefAction } from '@/lib/shared/brief-actions';
import {
  type BriefActionV2,
  type BriefNode,
  type BriefSourceRefV2,
  parseBriefDocument,
} from '@/lib/shared/brief-document';
import type { BriefHydratedEntity } from '@/lib/shared/brief-hydration';
import { safeExternalUrl } from '@/lib/shared/url';
import { BriefActions } from './BriefActions';
import { BriefMasthead } from './BriefMasthead';
import { type BriefNodeContext, BriefNodeView } from './BriefNodeView';
import type { BriefActionPayload } from './brief-action-runtime';

export function BriefCanvas({
  value,
  composing = false,
  onChanged,
  masthead = false,
  footer,
}: {
  value: unknown;
  composing?: boolean;
  onChanged?: () => void;
  masthead?: boolean;
  footer?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const document = useMemo(() => parseBriefDocument(value), [value]);
  const refs = useMemo(() => collectBriefRefs(document), [document]);
  const [hiddenRefs, setHiddenRefs] = useState<Set<string>>(() => new Set());
  const [completedRefs, setCompletedRefs] = useState<Map<string, boolean>>(() => new Map());
  const [canvasReview, setCanvasReview] = useState<BriefActionV2 | null>(null);
  const setSelectedThread = useClientStore((state) => state.setSelectedThread);
  const setThreadAccount = useClientStore((state) => state.setThreadAccount);
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setPendingOpenWorkId = useClientStore((state) => state.setPendingOpenWorkId);
  const setPendingReplyBody = useClientStore((state) => state.setPendingReplyBody);
  const setChatScope = useClientStore((state) => state.setChatScope);
  const setAiBarOpen = useClientStore((state) => state.setAiBarOpen);

  const hydration = useQuery({
    queryKey: briefQueryKeys.refBatch(refs),
    enabled: refs.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch('/api/mobile/briefs/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || 'Brief hydration failed.');
      return body.entities as BriefHydratedEntity[];
    },
  });
  const entities = useMemo(
    () => new Map((hydration.data ?? []).map((entity) => [hydratedEntityKey(entity), entity])),
    [hydration.data],
  );

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['brief-v2'] });
    queryClient.invalidateQueries({ queryKey: ['daily-report'] });
    onChanged?.();
  }, [onChanged, queryClient]);

  const runAction = useCallback(
    async (action: BriefActionV2, payload: BriefActionPayload, sourceRef?: BriefSourceRefV2) => {
      if (!isKnownBriefAction(action.action)) return;
      if (briefActionTier(action.action) === 'navigation') {
        navigateBriefAction(action.action, payload, {
          setSelectedThread,
          setThreadAccount,
          setPrimaryView,
          setSelectedAreaId,
          setSelectedWorkId,
          setPendingReplyBody,
          setChatScope,
          setAiBarOpen,
          openExternal: (url, target, features) => window.open(url, target, features),
        });
        return;
      }

      const key = sourceRef ? briefRefKey(sourceRef) : payloadRefKey(payload);
      const hides = ['dismiss_task', 'resolve_thread', 'dismiss_thread', 'archive_thread'].includes(
        action.action,
      );
      const previousCompleted = key ? completedRefs.get(key) : undefined;
      if (hides && key) setHiddenRefs((current) => new Set(current).add(key));
      if (action.action === 'toggle_task' && key) {
        setCompletedRefs((current) => new Map(current).set(key, Boolean(payload.completed)));
      }

      try {
        await executeBriefAction(action.action, payload, setPendingOpenWorkId);
        if (action.action === 'draft_reply') {
          navigateBriefAction(action.action, payload, {
            setSelectedThread,
            setThreadAccount,
            setPrimaryView,
            setSelectedAreaId,
            setSelectedWorkId,
            setPendingReplyBody,
            setChatScope,
            setAiBarOpen,
            openExternal: (url, target, features) => window.open(url, target, features),
          });
        }
        refresh();
        if (briefActionTier(action.action) === 'immediate') {
          toast.success(action.label, {
            description: 'Applied to the live item.',
            action: {
              label: 'Undo',
              onClick: () => {
                void undoBriefAction(action.action, payload).then(() => {
                  if (hides && key) {
                    setHiddenRefs((current) => {
                      const next = new Set(current);
                      next.delete(key);
                      return next;
                    });
                  }
                  if (action.action === 'toggle_task' && key) {
                    setCompletedRefs((current) => {
                      const next = new Map(current);
                      if (previousCompleted === undefined) next.delete(key);
                      else next.set(key, previousCompleted);
                      return next;
                    });
                  }
                  refresh();
                });
              },
            },
          });
        } else {
          toast.success(`${action.label} completed`);
        }
      } catch (error) {
        if (hides && key) {
          setHiddenRefs((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
        if (action.action === 'toggle_task' && key) {
          setCompletedRefs((current) => {
            const next = new Map(current);
            if (previousCompleted === undefined) next.delete(key);
            else next.set(key, previousCompleted);
            return next;
          });
        }
        toast.error(error instanceof Error ? error.message : 'The brief action failed.');
        throw error;
      }
    },
    [
      completedRefs,
      refresh,
      setAiBarOpen,
      setChatScope,
      setPendingOpenWorkId,
      setPendingReplyBody,
      setPrimaryView,
      setSelectedAreaId,
      setSelectedThread,
      setSelectedWorkId,
      setThreadAccount,
    ],
  );

  const context: BriefNodeContext = {
    entities,
    hiddenRefs,
    completedRefs,
    onAction: runAction,
    onCanvasAction: (actionName, payload) => {
      if (!isKnownBriefAction(actionName)) return;
      const action: BriefActionV2 = {
        action: actionName,
        label: humanizeAction(actionName),
        payload,
        style: 'secondary',
      };
      if (briefActionTier(actionName) === 'review') {
        setCanvasReview(action);
      } else {
        void runAction(action, payload);
      }
    },
  };

  return (
    <article
      className="scrollable @container h-full overflow-y-auto bg-[var(--color-bg)] px-4 py-6 @[680px]:px-7 @[1200px]:px-10"
      data-brief-document-version={document.version}
    >
      {masthead ? <BriefMasthead title={document.title} generatedAt={document.generatedAt} /> : null}
      <header className="mx-auto mb-7 max-w-[1760px] border-b border-[var(--color-border)] pb-5">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          <Newspaper className="size-3.5" />
          Native live brief
          {composing ? (
            <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal text-[var(--color-accent)]">
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
              Adding regions…
            </span>
          ) : hydration.isError ? (
            <span className="ml-auto flex items-center gap-1 normal-case tracking-normal text-[var(--color-warning)]">
              <AlertTriangle className="size-3" />
              Saved details shown
            </span>
          ) : (
            <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
              <CheckCircle2 className="size-3" />
              Live
            </span>
          )}
        </div>
        {masthead ? null : (
          <h1 className="max-w-3xl text-balance font-display text-3xl font-semibold leading-[1.05] tracking-tight @[640px]:text-4xl">
            {document.title}
          </h1>
        )}
        <p className="mt-3 max-w-3xl text-pretty text-sm leading-relaxed text-[var(--color-text-muted)] @[640px]:text-[15px]">
          {document.summary}
        </p>
        {masthead ? null : (
          <time className="mt-3 block text-[11px] text-[var(--color-text-faint)]">
            {new Intl.DateTimeFormat(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }).format(new Date(document.generatedAt))}
          </time>
        )}
      </header>
      {/* Newspaper flow: one column on narrow panes, two from ~840px, three
          on a rail-closed 16:9 display (~1200px of container). Each top-level
          block is a column unit — unbreakable, and its own container-query
          context so nested grids respond to the column width, not the page. */}
      <div className="mx-auto max-w-[1760px] gap-x-9 @[840px]:columns-2 @[1200px]:columns-3">
        {document.regions.map((region) => (
          <section key={region.id} data-brief-region={region.id} className="contents">
            {columnBlocks(region.tree).map((block, index) => (
              <div key={block.id ?? `${block.kind}-${index}`} className="@container mb-6 break-inside-avoid">
                <BriefNodeView node={block} context={context} regionSummary={region.summary} />
              </div>
            ))}
          </section>
        ))}
      </div>
      {footer}
      {canvasReview ? (
        <div className="sticky bottom-3 z-20 mx-auto mt-4 flex max-w-xl items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/95 p-3 shadow-[var(--shadow-pop)] backdrop-blur">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
            The visual canvas requested “{canvasReview.label}”. Review it in the native control.
          </p>
          <BriefActions
            actions={[canvasReview]}
            onAction={async (action, payload) => {
              await runAction(action, payload);
              setCanvasReview(null);
            }}
            compact
          />
          <button
            type="button"
            onClick={() => setCanvasReview(null)}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </article>
  );
}

async function executeBriefAction(
  action: string,
  payload: BriefActionPayload,
  setPendingOpenWorkId: (value: string | null) => void,
) {
  switch (action) {
    case 'toggle_task': {
      const cardId = required(payload, 'cardId');
      const completed = Boolean(payload.completed);
      await callTool('tasks_update_card', { cardId, completed });
      if (completed) {
        await callTool('dismiss_daily_report_task', { cardId, title: optional(payload, 'title') });
      } else {
        await callTool('restore_daily_report_task', { cardId }).catch(() => undefined);
      }
      return;
    }
    case 'dismiss_task':
      return callTool('dismiss_daily_report_task', {
        cardId: required(payload, 'cardId'),
        title: optional(payload, 'title'),
      });
    case 'resolve_thread':
    case 'dismiss_thread': {
      await callTool('dismiss_daily_report_thread', {
        account: required(payload, 'account'),
        threadId: required(payload, 'threadId'),
        subject: optional(payload, 'subject'),
        receivedAt: typeof payload.receivedAt === 'number' ? payload.receivedAt : null,
        action: action === 'resolve_thread' ? 'resolved' : 'dismissed',
      });
      if (action === 'resolve_thread' && optional(payload, 'trackedThreadId')) {
        await callTool('resolve_tracked_thread', { id: optional(payload, 'trackedThreadId') });
      }
      return;
    }
    case 'archive_thread':
      await callTool('archive_thread', {
        account: required(payload, 'account'),
        threadId: required(payload, 'threadId'),
      });
      await callTool('dismiss_daily_report_thread', {
        account: required(payload, 'account'),
        threadId: required(payload, 'threadId'),
        subject: optional(payload, 'subject'),
        action: 'dismissed',
      });
      return;
    case 'rsvp_event':
      return callTool('calendar_rsvp_event', {
        account: required(payload, 'account'),
        calendarId: required(payload, 'calendarId'),
        eventId: required(payload, 'eventId'),
        status: required(payload, 'status'),
      });
    case 'create_task':
      return callTool('tasks_create_card', {
        title: required(payload, 'title').slice(0, 500),
        dueIso: typeof payload.dueAt === 'number' ? new Date(payload.dueAt).toISOString() : undefined,
      });
    case 'create_event':
      return callTool('calendar_create_event', {
        account: required(payload, 'account'),
        title: required(payload, 'title'),
        startAt: payload.startAt,
        endAt: payload.endAt,
        allDay: Boolean(payload.allDay),
        location: optional(payload, 'location'),
        description: optional(payload, 'description'),
      });
    case 'capture_intent': {
      const response = await fetch('/api/albatross/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rawText: required(payload, 'text'),
          source: 'chat',
          areaId: optional(payload, 'areaId'),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Capture failed.');
      const firstWork = Array.isArray(body.workIds) ? body.workIds.map(String)[0] : undefined;
      if (firstWork) setPendingOpenWorkId(firstWork);
      return;
    }
    case 'answer_question': {
      const questionId = required(payload, 'questionId');
      const response = await fetch(`/api/albatross/work/questions/${encodeURIComponent(questionId)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          answer: required(payload, 'text'),
          answeredOptionId: optional(payload, 'answeredOptionId'),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Answer failed.');
      return;
    }
    case 'draft_reply':
      return;
  }
}

async function undoBriefAction(action: string, payload: BriefActionPayload) {
  switch (action) {
    case 'toggle_task': {
      const cardId = required(payload, 'cardId');
      await callTool('tasks_update_card', { cardId, completed: !payload.completed });
      if (payload.completed) await callTool('restore_daily_report_task', { cardId });
      return;
    }
    case 'dismiss_task':
      return callTool('restore_daily_report_task', { cardId: required(payload, 'cardId') });
    case 'resolve_thread':
    case 'dismiss_thread':
      await callTool('restore_daily_report_thread', {
        account: required(payload, 'account'),
        threadId: required(payload, 'threadId'),
      });
      if (action === 'resolve_thread' && optional(payload, 'trackedThreadId')) {
        await callTool('update_tracked_thread', {
          id: optional(payload, 'trackedThreadId'),
          status: optional(payload, 'previousStatus') ?? 'open',
        });
      }
      return;
    case 'archive_thread':
      await callTool('restore_from_trash', {
        account: required(payload, 'account'),
        threadId: required(payload, 'threadId'),
      });
      await callTool('restore_daily_report_thread', {
        account: required(payload, 'account'),
        threadId: required(payload, 'threadId'),
      });
      return;
  }
}

export function navigateBriefAction(
  action: string,
  payload: BriefActionPayload,
  navigation: {
    setSelectedThread: (value: string | null) => void;
    setThreadAccount: (value: string | null) => void;
    setPrimaryView: (value: any) => void;
    setSelectedAreaId: (value: string | null) => void;
    setSelectedWorkId: (value: string | null) => void;
    setPendingReplyBody: (value: string | null) => void;
    setChatScope: (value: { kind: 'area'; areaId: string }) => void;
    setAiBarOpen: (value: boolean) => void;
    openExternal: (url: string, target: '_blank', features: 'noopener,noreferrer') => void;
  },
) {
  switch (action) {
    case 'open_thread':
      navigation.setThreadAccount(optional(payload, 'account') ?? null);
      navigation.setSelectedThread(required(payload, 'threadId'));
      navigation.setPrimaryView('mail');
      break;
    case 'open_event':
      navigation.setPrimaryView('calendar');
      break;
    case 'open_view': {
      const view = required(payload, 'view');
      if (['mail', 'tasks', 'calendar', 'areas', 'plans'].includes(view)) {
        navigation.setPrimaryView(view);
      }
      break;
    }
    case 'open_area':
      navigation.setSelectedAreaId(required(payload, 'areaId'));
      navigation.setPrimaryView('areas');
      break;
    case 'open_work':
      if (optional(payload, 'areaId')) navigation.setSelectedAreaId(optional(payload, 'areaId')!);
      navigation.setSelectedWorkId(required(payload, 'workId'));
      navigation.setPrimaryView('areas');
      break;
    case 'open_url': {
      const url = safeExternalUrl(required(payload, 'url'));
      if (url) navigation.openExternal(url, '_blank', 'noopener,noreferrer');
      break;
    }
    case 'discuss_area': {
      const areaId = required(payload, 'areaId');
      navigation.setChatScope({ kind: 'area', areaId });
      navigation.setAiBarOpen(true);
      break;
    }
    case 'draft_reply':
      navigation.setThreadAccount(required(payload, 'account'));
      navigation.setSelectedThread(required(payload, 'threadId'));
      navigation.setPendingReplyBody(optional(payload, 'body') ?? '');
      navigation.setPrimaryView('mail');
      break;
  }
}

function required(payload: BriefActionPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The brief omitted ${key}.`);
  return value.trim();
}

function optional(payload: BriefActionPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function payloadRefKey(payload: BriefActionPayload) {
  if (optional(payload, 'threadId'))
    return ['thread', optional(payload, 'account') ?? '', optional(payload, 'threadId')].join(':');
  if (optional(payload, 'cardId')) return ['card', '', optional(payload, 'cardId')].join(':');
  if (optional(payload, 'eventId'))
    return ['event', optional(payload, 'account') ?? '', optional(payload, 'eventId')].join(':');
  return '';
}

/* Column units for the newspaper layout: region roots that are plain stacks
 * flatten so the columns balance at block granularity instead of treating a
 * whole region as one unbreakable slab. */
function columnBlocks(tree: BriefNode): BriefNode[] {
  return tree.kind === 'stack' && tree.children.length ? tree.children : [tree];
}

function humanizeAction(action: string) {
  return action
    .split('_')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}
