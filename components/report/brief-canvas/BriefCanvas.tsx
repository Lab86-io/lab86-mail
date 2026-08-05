'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';
import { briefQueryKeys, briefRefKey, collectBriefRefs, hydratedEntityKey } from '@/lib/brief/hydration';
import { useClientStore } from '@/lib/client-state';
import { pushDocumentDeepLink } from '@/lib/documents/deep-link';
import { briefActionTier, isKnownBriefAction } from '@/lib/shared/brief-actions';
import {
  type BriefActionV2,
  type BriefNode,
  type BriefSourceRefV2,
  parseBriefDocument,
} from '@/lib/shared/brief-document';
import type { BriefHydratedEntity } from '@/lib/shared/brief-hydration';
import type { PrimaryView } from '@/lib/shared/types';
import { safeExternalUrl } from '@/lib/shared/url';
import { cn } from '@/lib/utils';
import { BriefActions } from './BriefActions';
import { BriefMasthead } from './BriefMasthead';
import { type BriefNodeContext, BriefNodeView, briefNodePresentationClass } from './BriefNodeView';
import type { BriefActionPayload } from './brief-action-runtime';

const BRIEF_GRID_ROW_PX = 8;

/** Converts a measured story height into the editorial grid's row span. */
export function briefGridRowSpan(height: number, rowHeight = BRIEF_GRID_ROW_PX) {
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(rowHeight) || rowHeight <= 0) return 1;
  return Math.max(1, Math.ceil(height / rowHeight));
}

export function BriefCanvas({
  value,
  composing = false,
  onChanged,
  masthead = false,
  footer,
  embedded = false,
}: {
  value: unknown;
  composing?: boolean;
  onChanged?: () => void;
  masthead?: boolean;
  footer?: React.ReactNode;
  /** Flow inside a parent scroll instead of owning the viewport. Today reads as
   *  one page, so the brief cannot bring its own scrollbar to it. */
  embedded?: boolean;
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
  const setComposeRecoveredFiles = useClientStore((state) => state.setComposeRecoveredFiles);
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
        const result = await executeBriefAction(action.action, payload, setPendingOpenWorkId);
        let replyAttachFailed = false;
        if (
          action.action === 'create_document' &&
          result &&
          typeof result === 'object' &&
          'documentId' in result
        ) {
          if (payload.attachToReply === true) {
            try {
              await prepareDocumentReply(result.documentId, result.title, result.kind, payload, {
                setComposeRecoveredFiles,
                setPendingReplyBody,
                setPrimaryView,
                setSelectedThread,
                setThreadAccount,
              });
            } catch (error) {
              replyAttachFailed = true;
              pushDocumentDeepLink(result.documentId);
              setPrimaryView('files');
              toast.warning('The file was created, but its reply attachment needs another try.', {
                description: error instanceof Error ? error.message : 'The created file is open in Files.',
              });
            }
          } else {
            pushDocumentDeepLink(result.documentId);
            setPrimaryView('files');
          }
        }
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
        if (replyAttachFailed) {
          // The warning above is the complete result for this partial failure.
        } else if (briefActionTier(action.action) === 'immediate') {
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
      setComposeRecoveredFiles,
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
      className={cn(
        '@container px-4 @[680px]:px-7 @[1200px]:px-10',
        embedded ? 'py-2' : 'scrollable h-full overflow-y-auto bg-[var(--color-bg)] py-6',
      )}
      data-brief-document-version={document.version}
    >
      {masthead ? <BriefMasthead generatedAt={document.generatedAt} timezone={document.timezone} /> : null}
      <header className="mx-auto mb-7 max-w-[1760px] border-b border-[var(--color-border)] pb-5">
        {composing || hydration.isError ? (
          <div className="mb-3 flex items-center justify-end gap-2 text-[11px] font-medium text-[var(--color-text-muted)]">
            {composing ? (
              <span className="flex items-center gap-1.5 text-[var(--color-accent)]">
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                Adding regions…
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[var(--color-warning)]">
                <AlertTriangle className="size-3" />
                Saved details shown
              </span>
            )}
          </div>
        ) : null}
        {masthead ? null : (
          <h1 className="max-w-3xl text-balance font-display text-3xl font-semibold leading-[1.05] tracking-tight @[640px]:text-4xl">
            {document.title}
          </h1>
        )}
        <p
          className={
            masthead
              ? 'mt-3 max-w-4xl text-pretty font-display text-lg leading-relaxed text-[var(--color-text-muted)] first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-5xl first-letter:font-semibold first-letter:leading-[0.82] first-letter:text-[var(--color-accent-2)] @[640px]:text-xl'
              : 'mt-3 max-w-3xl text-pretty text-sm leading-relaxed text-[var(--color-text-muted)] @[640px]:text-[15px]'
          }
        >
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
      {/* Editorial masonry preserves authored visual order while measuring
          each story's real height. Wide concepts claim horizontal room, not
          a fixed vertical rectangle that leaves an empty hole beside them. */}
      <BriefEditorialGrid>
        {document.regions.map((region) => (
          <section key={region.id} data-brief-region={region.id} className="contents">
            {columnBlocks(region.tree).map((block, index) => (
              <BriefEditorialGridItem
                key={block.node.id ?? `${block.node.kind}-${index}`}
                className={cn('@container', block.wrapperClass)}
                spacing={block.spacing}
              >
                <div
                  data-brief-story-card
                  className={cn(
                    'min-w-0 rounded-[22px] border border-[var(--color-border)] bg-[var(--color-surface-float)] p-5 shadow-[var(--shadow-soft)] ring-1 ring-white/35 @[620px]:p-6 dark:ring-white/5',
                    block.cardClass,
                  )}
                >
                  <BriefNodeView
                    node={block.node}
                    context={context}
                    regionSummary={region.summary}
                    topLevel
                  />
                </div>
              </BriefEditorialGridItem>
            ))}
          </section>
        ))}
      </BriefEditorialGrid>
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

async function prepareDocumentReply(
  documentId: string,
  title: string,
  kind: 'doc' | 'sheet' | 'deck',
  payload: BriefActionPayload,
  navigation: {
    setComposeRecoveredFiles: (files: File[]) => void;
    setPendingReplyBody: (body: string | null) => void;
    setPrimaryView: (view: PrimaryView) => void;
    setSelectedThread: (threadId: string | null) => void;
    setThreadAccount: (account: string | null) => void;
  },
) {
  const account = required(payload, 'account');
  const threadId = required(payload, 'threadId');
  const exportResponse = await fetch(`/api/documents/${encodeURIComponent(documentId)}/export`, {
    cache: 'no-store',
  });
  if (!exportResponse.ok) {
    const error = await exportResponse.json().catch(() => ({}));
    throw new Error(error?.error || 'The file was created, but its attachment could not be prepared.');
  }
  const extension = kind === 'sheet' ? 'xlsx' : kind === 'deck' ? 'pptx' : 'docx';
  const contentType =
    exportResponse.headers.get('content-type') ||
    (kind === 'sheet'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : kind === 'deck'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const filename = `${title.replace(/[\\/:*?"<>|]/gu, '-').trim() || 'Untitled'}.${extension}`;
  const attachment = new File([await exportResponse.blob()], filename, { type: contentType });
  let body =
    optional(payload, 'body') || `I've attached the requested ${kindNameForReply(kind)} for your review.`;
  try {
    const draftResponse = await fetch('/api/compose/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: optional(payload, 'subject'),
        instructions: [
          `Draft a concise reply that says the requested ${kindNameForReply(kind)} “${title}” is attached for review.`,
          optional(payload, 'sourceContext'),
        ]
          .filter(Boolean)
          .join('\n'),
      }),
    });
    const draft = await draftResponse.json().catch(() => ({}));
    if (draftResponse.ok && typeof draft?.draft === 'string' && draft.draft.trim()) {
      body = draft.draft.trim();
    }
  } catch {
    // The grounded fallback still opens a complete reviewable reply.
  }
  navigation.setComposeRecoveredFiles([attachment]);
  navigation.setPendingReplyBody(body);
  navigation.setThreadAccount(account);
  navigation.setSelectedThread(threadId);
  navigation.setPrimaryView('mail');
}

function kindNameForReply(kind: 'doc' | 'sheet' | 'deck') {
  if (kind === 'sheet') return 'spreadsheet';
  if (kind === 'deck') return 'presentation';
  return 'document';
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
    case 'create_document': {
      const kind = required(payload, 'kind');
      if (!['doc', 'sheet', 'deck'].includes(kind)) {
        throw new Error('The brief requested an unsupported file type.');
      }
      const response = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          title: required(payload, 'title'),
          instructions: required(payload, 'instructions'),
          sourceContext: optional(payload, 'sourceContext'),
          sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs : [],
        }),
      });
      const body = await response.json();
      if (!response.ok || !body?.document?.documentId) {
        throw new Error(body?.error || 'File creation failed.');
      }
      return {
        documentId: String(body.document.documentId),
        title: String(body.document.title || required(payload, 'title')),
        kind: kind as 'doc' | 'sheet' | 'deck',
      };
    }
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
      if (['mail', 'tasks', 'calendar', 'areas', 'plans', 'files'].includes(view)) {
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

function BriefEditorialGrid({ children }: { children: ReactNode }) {
  const [packed, setPacked] = useState(false);
  useLayoutEffect(() => setPacked(true), []);

  return (
    <div
      data-brief-editorial-grid
      data-packed={packed ? 'true' : 'false'}
      className={cn(
        'mx-auto grid max-w-[1760px] grid-cols-1 gap-x-9 @[840px]:grid-cols-2 @[1200px]:grid-cols-3',
        packed ? 'auto-rows-[var(--brief-grid-row)] gap-y-0' : 'gap-y-6',
      )}
      style={{ '--brief-grid-row': `${BRIEF_GRID_ROW_PX}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}

function BriefEditorialGridItem({
  children,
  className,
  spacing,
}: {
  children: ReactNode;
  className?: string;
  spacing: 'airy' | 'standard' | 'dense';
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [rowSpan, setRowSpan] = useState<number>();

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const next = briefGridRowSpan(content.getBoundingClientRect().height);
      setRowSpan((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const style = rowSpan ? ({ gridRowEnd: `span ${rowSpan}` } satisfies CSSProperties) : undefined;
  return (
    <div className={className} style={style} data-brief-grid-span={rowSpan}>
      <div
        ref={contentRef}
        className={cn(spacing === 'airy' ? 'pb-6' : spacing === 'dense' ? 'pb-2.5' : 'pb-4')}
      >
        {children}
      </div>
    </div>
  );
}

/* Region roots that are plain stacks flatten so the packed grid can balance
 * at story granularity instead of treating a whole region as one slab. */
function columnBlocks(tree: BriefNode): Array<{
  node: BriefNode;
  wrapperClass: string;
  cardClass: string;
  spacing: 'airy' | 'standard' | 'dense';
}> {
  if (tree.kind === 'stack' && tree.children.length) {
    return tree.children.map((node) => ({
      node,
      wrapperClass: footprintClass(node),
      cardClass: cn(briefNodePresentationClass(tree), briefNodePresentationClass(node)),
      spacing: tree.density,
    }));
  }
  return [
    {
      node: tree,
      wrapperClass: footprintClass(tree),
      cardClass: briefNodePresentationClass(tree),
      spacing: 'airy',
    },
  ];
}

function footprintClass(node: BriefNode): string {
  if (node.footprint === 'feature') return '@[840px]:col-span-2 @[1200px]:col-span-3';
  if (node.footprint === 'wide') return '@[840px]:col-span-2';
  return '';
}

function humanizeAction(action: string) {
  return action
    .split('_')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}
