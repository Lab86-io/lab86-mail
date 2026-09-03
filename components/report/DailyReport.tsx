'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useConvexAuth, useQuery as useConvexQuery } from 'convex/react';
import { CalendarDays, CheckCircle2, Inbox, Newspaper, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextVortex, type VortexSource } from '@/components/albatross/ContextVortex';
import { DailyCheckin, type DailyCheckinData } from '@/components/albatross/DailyCheckin';
import { ConnectionLogo, GmailLogo, ProviderLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { BriefSkeleton } from '@/components/report/BriefSkeleton';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/convex/_generated/api';
import { injectBriefArtifactReadyRuntime, isBriefArtifactReadyMessage } from '@/lib/albatross/artifact-ready';
import type { AlbatrossDailyReportContext } from '@/lib/albatross/daily-report';
import { briefFreshness, briefIsStale } from '@/lib/albatross/today';
import { isClosed } from '@/lib/albatross/work-state';
import { callTool } from '@/lib/api-client';
import { BRIEF_LETTER_FAILED_COPY, briefLetterFromReport } from '@/lib/brief/letter';
import { useClientStore } from '@/lib/client-state';
import {
  artifactFrameHeight,
  confirmDailyReportAction,
  DEFAULT_ARTIFACT_FRAME_HEIGHT,
} from '@/lib/daily-report-action-review';
import { handleDailyReportNavigationAction } from '@/lib/daily-report-navigation';
import { pushDocumentDeepLink } from '@/lib/documents/deep-link';
import { type BriefService, briefServicesFromIds } from '@/lib/mail/brief-services';
import { injectReportAreaBrief } from '@/lib/mail/report-area-brief';
import type { BriefDocumentV2 } from '@/lib/shared/brief-document';
import { stripEmoji } from '@/lib/shared/format';
import { postBriefTheme } from '@/lib/theme/brief-theme';
import { cn } from '@/lib/utils';

interface DailyReportItem {
  account: string;
  threadId: string;
  subject: string;
  people: string[];
  whyItMatters: string;
  nextAction?: string;
  openLoops?: string[];
  dueAt?: number | null;
  unread: boolean;
  trackedThreadId?: string;
  surfacedBecause?: string[];
  demotionReason?: string | null;
  isNewSender?: boolean;
  lane?: string;
  receivedAt?: number | null;
}

interface DailyReportTaskItem {
  cardId: string;
  boardId: string;
  columnId: string;
  boardTitle?: string;
  columnName?: string;
  title: string;
  description?: string;
  dueAt?: number | null;
  completedAt?: number | null;
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  assignees?: string[];
  sourceTitle?: string;
  sourceUrl?: string;
  source?: {
    accountId?: string;
    threadId?: string;
    calendarId?: string;
    eventId?: string;
    providerEventId?: string;
  };
  sourceThreadId?: string;
  sourceCalendarEventId?: string;
  sourceAccountId?: string;
  scope: 'week' | 'month';
}

interface DailyReportCalendarItem {
  account: string;
  eventId: string;
  calendarId?: string;
  calendarName?: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  location?: string;
  htmlLink?: string;
  description?: string;
  scope: 'week' | 'month';
}

interface DailyReportMcpItem {
  server: 'github' | 'bitbucket' | 'jira' | 'slack' | 'granola';
  kind: string;
  title: string;
  state?: string | null;
  author?: string | null;
  url?: string | null;
  updatedAt?: number | null;
}

interface DailyReportArtifactError {
  stage: 'ai_availability' | 'week_artifact' | 'month_artifact' | 'month_enrichment' | 'document_v2';
  message: string;
  at: number;
}

interface DailyReportPayload {
  _id: string;
  kind: 'morning' | 'evening' | 'manual';
  generatedAt: number;
  title: string;
  narrative: string;
  sections: Record<
    string,
    | DailyReportItem[]
    | DailyReportTaskItem[]
    | DailyReportCalendarItem[]
    | DailyReportMcpItem[]
    | string
    | AlbatrossDailyReportContext
    | undefined
  >;
  stats: {
    scannedThreads: number;
    trackedThreads: number;
    needsReply: number;
    replyOwed?: number;
    dueSoon: number;
    bulkTailCount?: number;
    openTasks?: number;
    completedTasks?: number;
    calendarEvents?: number;
    noise?: number;
    selected?: number;
  };
  model?: string;
  errors?: string[];
  services?: string[];
  tier?: 'free' | 'pro' | 'team';
  prose?: { lede: string; weekAhead: string; model: string };
  status?: 'partial' | 'ready';
  progress?: { stage: string; done: number; total: number };
  // Agent-authored self-contained HTML artifact (served in a sandboxed iframe).
  html?: string;
  document?: BriefDocumentV2;
  artifactStatus?: 'composing' | 'enriching' | 'rendered' | 'ready';
  artifactSource?: 'ai' | 'deterministic' | 'document-v2';
  artifactErrors?: DailyReportArtifactError[];
}

interface ReportSummary {
  _id: string;
  kind: 'morning' | 'evening' | 'manual';
  generatedAt: number;
  title?: string;
}

interface DailyReportThreadDismissalRecord {
  account: string;
  threadId: string;
  subject?: string;
  receivedAt?: number | null;
  dismissedAt: number;
  action: 'dismissed' | 'resolved';
  threadKey?: string;
}

const EDITION: Record<DailyReportPayload['kind'], string> = {
  morning: 'Morning Edition',
  evening: 'Evening Edition',
  manual: 'Latest Edition',
};

// "Tuesday, May 26 · Morning Edition" — the broadsheet dateline.
function formatDateline(report: DailyReportPayload): string {
  const date = new Date(report.generatedAt);
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
  return `${day} · ${EDITION[report.kind]}`;
}

// Compact label for the history dropdown: "May 26, 7:02 AM · Morning Edition".
function editionLabel(item: ReportSummary): string {
  const when = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(item.generatedAt));
  return `${when} · ${EDITION[item.kind]}`;
}

function asLane(value: DailyReportPayload['sections'][string]): DailyReportItem[] | undefined {
  return Array.isArray(value) ? (value as DailyReportItem[]) : undefined;
}

function asTasks(value: DailyReportPayload['sections'][string]): DailyReportTaskItem[] {
  return Array.isArray(value) ? (value as DailyReportTaskItem[]) : [];
}

function asEvents(value: DailyReportPayload['sections'][string]): DailyReportCalendarItem[] {
  return Array.isArray(value) ? (value as DailyReportCalendarItem[]) : [];
}

// The Albatross section is an object, not the array/string the other sections
// carry, so it needs its own coercion before the brief reads it.
function asAlbatrossContext(value: unknown): AlbatrossDailyReportContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AlbatrossDailyReportContext;
}

function dailyReportThreadKey(account: string, threadId: string): string {
  return JSON.stringify([account, threadId]);
}

function servicesForReport(report: DailyReportPayload): BriefService[] {
  const serviceIds = [
    ...(report.services || []),
    ...asMcpItems(report.sections.mcp).map((item) => item.server),
    ...(asEvents(report.sections.calendar).length ? ['calendar'] : []),
    ...(asTasks(report.sections.tasks).some((task) => !task.completedAt) ? ['tasks'] : []),
  ];
  if (!serviceIds.length) serviceIds.push('mail');
  return briefServicesFromIds(serviceIds);
}

function asMcpItems(value: DailyReportPayload['sections'][string]): DailyReportMcpItem[] {
  return Array.isArray(value) ? (value as DailyReportMcpItem[]) : [];
}

function BriefFooter({ report }: { report: DailyReportPayload }) {
  const services = servicesForReport(report);
  return (
    <footer className="relative mt-14 overflow-hidden py-10 text-center text-[var(--color-text-muted)] before:absolute before:left-1/2 before:top-0 before:h-px before:w-full before:max-w-3xl before:-translate-x-1/2 before:bg-gradient-to-r before:from-transparent before:via-[var(--color-border)] before:to-transparent after:absolute after:inset-x-0 after:bottom-0 after:h-1/2 after:bg-[radial-gradient(var(--color-border)_0.65px,transparent_0.65px)] after:bg-[length:10px_10px] after:opacity-35 after:[mask-image:linear-gradient(to_bottom,transparent,black)]">
      <div className="relative z-10 mx-auto max-w-full overflow-hidden text-ellipsis whitespace-nowrap px-3 font-display text-[clamp(0.72rem,1.18vw,1rem)] font-semibold leading-[1.25]">
        <span>Made for you by</span> <span className="whitespace-nowrap text-[var(--color-text)]">Lab86</span>{' '}
        <span>using your</span> <ServiceList services={services} />
        <span>.</span>
      </div>
    </footer>
  );
}

function ServiceList({ services }: { services: BriefService[] }) {
  return (
    <>
      {services.map((service, index) => (
        <span key={service.id}>
          <span className="text-[var(--color-text-muted)]">
            {index === 0
              ? ''
              : services.length === 2
                ? ' and '
                : index === services.length - 1
                  ? ', and '
                  : ', '}
          </span>
          <span className="inline-flex items-center gap-x-[0.14em] whitespace-nowrap text-[var(--color-text)]">
            <ServiceLogo service={service} />
            <span>{service.label}</span>
          </span>
        </span>
      ))}
    </>
  );
}

function ServiceLogo({ service }: { service: BriefService }) {
  const className = 'inline-block size-[0.88em] shrink-0 translate-y-[-0.04em]';
  if (service.id === 'gmail') return <GmailLogo className={className} />;
  if (service.id === 'outlook') return <ProviderLogo provider="microsoft" className={className} />;
  if (service.id === 'icloud') return <ProviderLogo provider="icloud" className={className} />;
  if (
    service.id === 'github' ||
    service.id === 'bitbucket' ||
    service.id === 'jira' ||
    service.id === 'slack' ||
    service.id === 'granola'
  ) {
    return <ConnectionLogo server={service.id} className={className} />;
  }
  if (service.id === 'calendar') return <CalendarDays className={className} />;
  if (service.id === 'tasks') return <CheckCircle2 className={className} />;
  return <Inbox className={className} />;
}

// Renders the agent-authored HTML artifact in a sandboxed iframe and bridges
// its interactions back to the app. The artifact runs WITHOUT same-origin
// access (it cannot read cookies, storage, or the Convex client) — every
// mutation flows through this allowlisted postMessage handler, which validates
// the message source and the action before touching app state.
const REPORT_ARTIFACT_RUNTIME_JS = `<script id="lab86-report-runtime-js">
(function(){
if(window.__lab86ReportRuntimeInstalled)return;
window.__lab86ReportRuntimeInstalled=true;
var hiddenCardIds={};
var hiddenThreadDismissals={};
function hideDismissedTasks(ids){
if(!Array.isArray(ids))return;
for(var i=0;i<ids.length;i++){hiddenCardIds[String(ids[i])]=true;}
var rows=document.querySelectorAll('[data-card-id]');
for(var j=0;j<rows.length;j++){var id=rows[j].getAttribute('data-card-id');if(id&&hiddenCardIds[id])rows[j].remove();}
}
function threadKeyFromPayload(payload){
if(!payload)return null;
if(payload.threadKey)return String(payload.threadKey);
if(payload.account&&payload.threadId)return JSON.stringify([String(payload.account),String(payload.threadId)]);
return null;
}
function threadCutoff(record){
if(!record)return null;
if(typeof record.receivedAt==='number')return record.receivedAt;
if(typeof record.dismissedAt==='number')return record.dismissedAt;
return null;
}
function rowReceivedAt(row){
var raw=row.getAttribute('data-received-at');
if(raw===null||raw==='')return null;
var value=Number(raw);
return isFinite(value)?value:null;
}
function applyThreadDismissals(){
var rows=document.querySelectorAll('[data-thread-key]');
for(var j=0;j<rows.length;j++){
var key=rows[j].getAttribute('data-thread-key');
var record=key&&hiddenThreadDismissals[key];
if(!record)continue;
var cutoff=threadCutoff(record);
var received=rowReceivedAt(rows[j]);
if(cutoff===null||received===null||received<=cutoff)rows[j].remove();
}
}
function recordThreadDismissals(records){
if(!Array.isArray(records))return;
for(var i=0;i<records.length;i++){
var record=records[i]||{};
var key=threadKeyFromPayload(record);
if(key)hiddenThreadDismissals[key]=record;
}
applyThreadDismissals();
}
function hideDismissedThreads(keys){
if(!Array.isArray(keys))return;
var records=[];
for(var i=0;i<keys.length;i++){records.push({threadKey:String(keys[i])});}
recordThreadDismissals(records);
}
window.addEventListener('message',function(e){
var d=e.data;
if(d&&d.source==='lab86-host'&&d.type==='dismissed_tasks')hideDismissedTasks(d.cardIds||[]);
	if(d&&d.source==='lab86-host'&&d.type==='dismissed_threads'){if(Array.isArray(d.dismissals)){recordThreadDismissals(d.dismissals);}else{hideDismissedThreads(d.threadKeys||[]);}}
	if(d&&d.source==='lab86-host'&&d.ok&&(d.action==='resolve_thread'||d.action==='dismiss_thread')){var payload=d.payload||{};var key=threadKeyFromPayload(payload);if(key)recordThreadDismissals([{threadKey:key,account:payload.account,threadId:payload.threadId,subject:payload.subject,receivedAt:typeof payload.receivedAt==='number'?payload.receivedAt:null,dismissedAt:Date.now(),action:d.action==='resolve_thread'?'resolved':'dismissed'}]);}
	});
	document.addEventListener('click',function(e){
	var el=e.target&&e.target.closest&&e.target.closest('[data-action]');
	if(!el)return;
	var action=el.getAttribute('data-action');
	if(!action)return;
	e.preventDefault();
	var payload={};
	try{payload=JSON.parse(el.getAttribute('data-payload')||'{}')||{};}catch(_){payload={};}
	window.parent.postMessage({source:'lab86-daily-report',action:action,payload:payload},'*');
	});
	/* Height bridge. Embedded in Today the artifact flows in the page scroll, so
	   the host has to be told how tall the document actually is. */
	function reportHeight(){
	var h=Math.max(document.documentElement.scrollHeight||0,document.body?document.body.scrollHeight:0);
	if(h>0)window.parent.postMessage({source:'lab86-daily-report',action:'__height',payload:{height:h}},'*');
	}
	window.addEventListener('load',reportHeight);
	window.addEventListener('resize',reportHeight);
	if(window.ResizeObserver&&document.body)new ResizeObserver(reportHeight).observe(document.body);
	setTimeout(reportHeight,300);
	})();
	</script>`;

function withReportArtifactRuntime(
  html: string,
  albatrossContext?: AlbatrossDailyReportContext | null,
): string {
  if (!html) return html;
  let next = injectReportAreaBrief(html, albatrossContext ?? null).replace(
    /<script\b(?=[^>]*\bid=(["'])lab86-report-runtime-js\1)[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );
  const bodyClose = next.toLowerCase().lastIndexOf('</body>');
  next =
    bodyClose >= 0
      ? `${next.slice(0, bodyClose)}${REPORT_ARTIFACT_RUNTIME_JS}${next.slice(bodyClose)}`
      : `${next}${REPORT_ARTIFACT_RUNTIME_JS}`;
  return injectBriefArtifactReadyRuntime(next);
}

function ReportArtifact({
  html,
  albatrossContext,
  dismissedTaskIds,
  dismissedThreadRecords,
  onChanged,
  autoHeight = false,
}: {
  html: string;
  albatrossContext?: AlbatrossDailyReportContext | null;
  dismissedTaskIds: string[];
  dismissedThreadRecords: DailyReportThreadDismissalRecord[];
  onChanged?: () => void;
  /** Grow to the artifact's own height instead of filling a fixed frame. */
  autoHeight?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [artifactReady, setArtifactReady] = useState(false);
  const [artifactHeight, setArtifactHeight] = useState<number | null>(null);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  // The brief is theme-agnostic HTML (CSS vars with fallbacks); the host injects
  // the user's actual theme so it matches the app and restyles live on change.
  // Subscribing to these slices re-runs the effect whenever customization moves.
  const appFont = useClientStore((s) => s.appFont);
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const accent2Hue = useClientStore((s) => s.accent2Hue);
  const accent2Chroma = useClientStore((s) => s.accent2Chroma);
  const bgHue = useClientStore((s) => s.bgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);

  // Mirror the app's resolved CSS variables (already reflect the live accent,
  // background, and light/dark) into the brief's --brief-* tokens. Posted on
  // iframe load and again whenever any customization slice changes.
  const postTheme = useCallback(() => {
    postBriefTheme(frameRef.current?.contentWindow, appFont);
  }, [appFont]);

  const postDismissedTasks = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ source: 'lab86-host', type: 'dismissed_tasks', cardIds: dismissedTaskIds }, '*');
  }, [dismissedTaskIds]);

  const postDismissedThreads = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      { source: 'lab86-host', type: 'dismissed_threads', dismissals: dismissedThreadRecords },
      '*',
    );
  }, [dismissedThreadRecords]);

  // Re-post on any customization change. The accent/background slices aren't
  // referenced directly (their resolved colors are read from computed CSS), but
  // they must still re-trigger the post, so they belong in the dependency list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme slices intentionally trigger a re-post; resolved values come from computed CSS.
  useEffect(() => {
    postTheme();
    postDismissedTasks();
    postDismissedThreads();
  }, [
    postTheme,
    postDismissedTasks,
    postDismissedThreads,
    accentHue,
    accentChroma,
    accent2Hue,
    accent2Chroma,
    bgHue,
    surfaceTint,
    html,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new artifact must be hidden before its own readiness handshake.
  useEffect(() => {
    setArtifactReady(false);
  }, [html]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data = event.data as { source?: string; action?: string; payload?: any } | null;
      if (
        frameRef.current &&
        event.source === frameRef.current.contentWindow &&
        isBriefArtifactReadyMessage(data)
      ) {
        setArtifactReady(true);
        return;
      }
      if (!data || data.source !== 'lab86-daily-report') return;
      // Only trust messages from our own iframe document.
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
      // The height bridge changes nothing but this frame's own size, so it does
      // not pass through the confirm gate below.
      if (data.action === '__height') {
        setArtifactHeight(artifactFrameHeight(data.payload?.height));
        return;
      }
      const payload = data.payload || {};
      const ack = (ok: boolean, error?: string) =>
        frameRef.current?.contentWindow?.postMessage(
          { source: 'lab86-host', action: data.action, ok, error, payload },
          '*',
        );
      // The artifact srcDoc is authored by the model from UNTRUSTED mailbox
      // content, so a prompt-injected script could post a state-changing action
      // with no user click. Gate EVERY mutating action behind a host-rendered
      // confirm() (a sandboxed iframe cannot suppress a top-window dialog).
      // Trusted in-app navigation and draft_reply (which only seeds the
      // composer) are exempt. open_url is still reviewed because it crosses
      // from model-authored iframe content into an external browser surface.
      if (!confirmDailyReportAction(data.action, payload, window.confirm)) {
        return ack(false, 'cancelled');
      }
      try {
        switch (data.action) {
          case 'open_thread':
            if (!payload.threadId) return ack(false, 'missing threadId');
            if (payload.account) setThreadAccount(String(payload.account));
            setSelectedThread(String(payload.threadId));
            setPrimaryView('mail');
            return ack(true);
          case 'open_event':
            setPrimaryView('calendar');
            return ack(true);
          case 'draft_reply':
            if (!payload.threadId) return ack(false, 'missing threadId');
            if (!payload.account) return ack(false, 'missing account');
            if (typeof payload.body !== 'string') return ack(false, 'missing body');
            setThreadAccount(String(payload.account));
            setSelectedThread(String(payload.threadId));
            setPendingReplyBody(payload.body);
            setPrimaryView('mail');
            return ack(true);
          case 'open_view':
            if (['mail', 'tasks', 'calendar', 'areas'].includes(payload.view)) {
              setPrimaryView(payload.view);
              return ack(true);
            }
            return ack(false, 'unknown view');
          case 'open_area':
            if (!payload.areaId) return ack(false, 'missing areaId');
            setSelectedAreaId(String(payload.areaId));
            setPrimaryView('areas');
            return ack(true);
          case 'open_work':
          case 'open_url': {
            const result = handleDailyReportNavigationAction(data.action, payload, {
              setSelectedAreaId,
              setSelectedWorkId,
              setPrimaryView,
              openExternal: (url, target, features) => window.open(url, target, features),
            });
            return ack(result.ok, result.ok ? undefined : result.error);
          }
          case 'toggle_task':
            if (!payload.cardId) return ack(false, 'missing cardId');
            {
              const completed = Boolean(payload.completed);
              const cardId = String(payload.cardId);
              const title = typeof payload.title === 'string' ? payload.title : undefined;
              await callTool('tasks_update_card', {
                cardId,
                completed,
              });
              if (completed) {
                await callTool('dismiss_daily_report_task', { cardId, title }).catch(() => undefined);
              }
            }
            onChanged?.();
            return ack(true);
          case 'dismiss_task':
            if (!payload.cardId) return ack(false, 'missing cardId');
            await callTool('dismiss_daily_report_task', {
              cardId: String(payload.cardId),
              title: typeof payload.title === 'string' ? payload.title : undefined,
            });
            onChanged?.();
            return ack(true);
          case 'resolve_thread':
          case 'dismiss_thread': {
            if (!payload.account) return ack(false, 'missing account');
            if (!payload.threadId) return ack(false, 'missing threadId');
            await callTool('dismiss_daily_report_thread', {
              account: String(payload.account),
              threadId: String(payload.threadId),
              subject: typeof payload.subject === 'string' ? payload.subject : undefined,
              receivedAt: typeof payload.receivedAt === 'number' ? payload.receivedAt : null,
              action: data.action === 'resolve_thread' ? 'resolved' : 'dismissed',
            });
            if (data.action === 'resolve_thread' && payload.trackedThreadId) {
              await callTool('resolve_tracked_thread', { id: String(payload.trackedThreadId) });
            }
            onChanged?.();
            return ack(true);
          }
          case 'create_task': {
            const title = String(payload.title || '').trim();
            if (!title) return ack(false, 'missing title');
            await callTool('tasks_create_card', {
              title: title.slice(0, 500),
              dueIso: typeof payload.dueAt === 'number' ? new Date(payload.dueAt).toISOString() : undefined,
            });
            onChanged?.();
            return ack(true);
          }
          case 'create_document': {
            const title = String(payload.title || '').trim();
            const kind = String(payload.kind || '');
            const instructions = String(payload.instructions || '').trim();
            if (!title) return ack(false, 'missing title');
            if (!['doc', 'sheet', 'deck'].includes(kind)) return ack(false, 'invalid file kind');
            if (!instructions) return ack(false, 'missing instructions');
            const response = await fetch('/api/documents', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kind,
                title: title.slice(0, 300),
                instructions: instructions.slice(0, 4_000),
                sourceContext:
                  typeof payload.sourceContext === 'string'
                    ? payload.sourceContext.slice(0, 20_000)
                    : undefined,
                sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs : [],
              }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || !body?.document?.documentId) {
              return ack(false, body?.error || 'file creation failed');
            }
            pushDocumentDeepLink(String(body.document.documentId));
            setPrimaryView('files');
            return ack(true);
          }
          // These three actions mutate mail/calendar state. The artifact is
          // authored by the model from UNTRUSTED mailbox content, so a
          // prompt-injected script could post them on load with no user click.
          // Require a host-rendered confirmation (top-window confirm() the
          // sandboxed iframe cannot suppress) as the intent gate.
          case 'archive_thread': {
            if (!payload.account) return ack(false, 'missing account');
            if (!payload.threadId) return ack(false, 'missing threadId');
            await callTool('archive_thread', {
              account: String(payload.account),
              threadId: String(payload.threadId),
            });
            // Archiving must also clear it from future briefs; let a failure
            // surface (ack false) rather than archive silently and let it return.
            await callTool('dismiss_daily_report_thread', {
              account: String(payload.account),
              threadId: String(payload.threadId),
              subject: typeof payload.subject === 'string' ? payload.subject : undefined,
              receivedAt: typeof payload.receivedAt === 'number' ? payload.receivedAt : null,
              action: 'dismissed',
            });
            onChanged?.();
            return ack(true);
          }
          case 'rsvp_event': {
            if (!payload.account) return ack(false, 'missing account');
            if (!payload.eventId) return ack(false, 'missing eventId');
            if (!payload.calendarId) return ack(false, 'missing calendarId');
            if (!['yes', 'no', 'maybe'].includes(payload.status))
              return ack(false, 'status must be yes/no/maybe');
            await callTool('calendar_rsvp_event', {
              account: String(payload.account),
              calendarId: String(payload.calendarId),
              eventId: String(payload.eventId),
              status: payload.status,
            });
            onChanged?.();
            return ack(true);
          }
          case 'create_event': {
            const title = String(payload.title || '').trim();
            if (!title) return ack(false, 'missing title');
            if (!payload.account) return ack(false, 'missing account');
            const startAt = payload.startAt;
            const endAt = payload.endAt;
            if (
              typeof startAt !== 'number' ||
              typeof endAt !== 'number' ||
              !Number.isFinite(startAt) ||
              !Number.isFinite(endAt) ||
              endAt <= startAt
            )
              return ack(false, 'invalid start/end window');
            await callTool('calendar_create_event', {
              account: String(payload.account),
              title: title.slice(0, 300),
              startIso: new Date(startAt).toISOString(),
              endIso: new Date(endAt).toISOString(),
              allDay: Boolean(payload.allDay),
              // Never invite attendees from the brief — holds only.
              location: typeof payload.location === 'string' ? payload.location : undefined,
              description: typeof payload.description === 'string' ? payload.description : undefined,
            });
            onChanged?.();
            return ack(true);
          }
          default:
            return ack(false, 'unknown action');
        }
      } catch (err: any) {
        ack(false, err?.message || 'action failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    setSelectedThread,
    setThreadAccount,
    setPrimaryView,
    setSelectedAreaId,
    setSelectedWorkId,
    setPendingReplyBody,
    onChanged,
  ]);

  return (
    <iframe
      ref={frameRef}
      title="The Daily Brief"
      srcDoc={withReportArtifactRuntime(html, albatrossContext)}
      aria-busy={!artifactReady}
      onLoad={() => {
        postTheme();
        postDismissedTasks();
        postDismissedThreads();
      }}
      // allow-scripts (for interactivity) WITHOUT allow-same-origin keeps the
      // artifact sandboxed from the app origin; allow-popups lets external
      // links open in a new tab.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      scrolling={autoHeight ? 'no' : undefined}
      style={autoHeight ? { height: artifactHeight ?? DEFAULT_ARTIFACT_FRAME_HEIGHT } : undefined}
      className={cn(
        'w-full border-0 bg-[var(--color-bg)] transition-opacity duration-300',
        autoHeight ? 'block overflow-hidden' : 'h-full',
        artifactReady ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

const STUCK_GENERATION_MS = 20 * 60_000;

// Context the brief actually reads; the vortex swallows these while composing.
const BRIEF_VORTEX_SOURCES: VortexSource[] = [
  { id: 'mail', label: 'Mail', kind: 'mail' },
  { id: 'calendar', label: 'Calendar', kind: 'calendar' },
  { id: 'tasks', label: 'Tasks', kind: 'tasks' },
  { id: 'areas', label: 'Areas', kind: 'areas' },
  { id: 'notes', label: 'Notes', kind: 'notes' },
];

// The "we're working on it" state: the shared context-vortex treatment —
// context cards fly into a growing singularity until the brief springs out.
function ReportGenerating({ report }: { report: DailyReportPayload | null }) {
  const stage =
    report?.artifactStatus === 'composing' ? 'Designing the layout' : report?.progress?.stage || null;
  const progressCount = report?.progress?.total
    ? ` — ${Math.min(report.progress.done, report.progress.total)} of ${report.progress.total}`
    : '';
  const subtitle = stage
    ? `${stripEmoji(stage)}${progressCount}…`
    : 'Reading the week’s mail, calendar, and tasks…';

  return (
    <div className="relative h-full min-h-[420px]">
      <ContextVortex title="Composing your brief" subtitle={subtitle} sources={BRIEF_VORTEX_SOURCES} />
    </div>
  );
}

export function DailyReport({
  embedded = false,
  onOpenLegacy,
}: {
  embedded?: boolean;
  onOpenLegacy?: () => void;
} = {}) {
  const queryClient = useQueryClient();
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);

  // Browse history; the freshest edition shows by default (selectedId = null).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Timestamp of the last manual Generate. We keep polling until an edition
  // newer than this appears — otherwise the post-click refetch lands on the OLD
  // report (the new one isn't saved yet), polling stops, and the fresh brief
  // never shows.
  const [generatingSince, setGeneratingSince] = useState<number | null>(null);

  const historyQuery = useQuery({
    queryKey: ['daily-report', 'history'],
    queryFn: async () => callTool<{ reports: ReportSummary[] }>('list_daily_reports', { limit: 30 }),
    staleTime: 30_000,
  });
  const history = historyQuery.data?.reports || [];

  const reportQuery = useQuery({
    queryKey: ['daily-report', selectedId ?? 'latest'],
    queryFn: async () =>
      selectedId
        ? callTool<{ report: DailyReportPayload | null }>('get_daily_report', { id: selectedId })
        : callTool<{ report: DailyReportPayload | null }>('get_latest_daily_report', {}),
    staleTime: 30_000,
    // Keep polling while an edition streams in (status: partial), while the
    // letter is composing, OR while we're waiting for a freshly-triggered
    // edition to land — so the page upgrades live.
    refetchInterval: (query) => {
      const r = query.state.data?.report;
      // A status that has sat past this cutoff is from a generation that died
      // mid-flight; stop polling it so we don't hammer a forever-stuck edition.
      const stuck = !r || Date.now() - (r.generatedAt || 0) > STUCK_GENERATION_MS;
      if (!stuck && (r?.status === 'partial' || r?.artifactStatus === 'composing')) return 2_000;
      if (!stuck && r?.artifactStatus === 'enriching') return 3_000;
      if (generatingSince && (!r || (r.generatedAt || 0) < generatingSince)) return 1_500;
      return false;
    },
  });
  // The legacy HTML artifact hides the tasks and threads the reader already
  // put away. The letter hides them through the canvas.
  const taskDismissalsQuery = useQuery({
    queryKey: ['daily-report', 'task-dismissals'],
    queryFn: async () => callTool<{ cardIds: string[] }>('list_daily_report_task_dismissals', {}),
    staleTime: 30_000,
  });
  const threadDismissalsQuery = useQuery({
    queryKey: ['daily-report', 'thread-dismissals'],
    queryFn: async () =>
      callTool<{ dismissals: DailyReportThreadDismissalRecord[] }>('list_daily_report_thread_dismissals', {}),
    staleTime: 30_000,
  });
  const report = reportQuery.data?.report || null;
  // A generation that errored partway leaves the stored edition stuck at
  // 'partial'/'composing' forever. Past this cutoff we treat such a status as
  // dead, so the in-progress UI clears and Generate is clickable again.
  const reportIsStale = !report || Date.now() - (report.generatedAt || 0) > STUCK_GENERATION_MS;
  const artifactSource = report?.html ? (report.artifactSource ?? 'ai') : null;
  const displayDocument = Boolean(report?.document && report.artifactSource === 'document-v2');
  // Embedded in Today, the brief sits under a live layer. It has to say when it
  // was written, and say so louder when it describes an older day.
  const embeddedFreshness = briefFreshness(report?.generatedAt ?? null, Date.now());
  const embeddedStale = briefIsStale(report?.generatedAt ?? null, Date.now());
  // The deterministic HTML is the interim save while the letter composes. If
  // it is still the final artifact, the letter did not write.
  const composingLetter =
    !reportIsStale &&
    artifactSource === 'deterministic' &&
    (report?.artifactStatus === 'composing' || report?.artifactStatus === 'enriching');
  const letterFailed =
    Boolean(report) && !displayDocument && artifactSource === 'deterministic' && !composingLetter;
  // Editions from before the letter carry a model-authored HTML page.
  const displayArtifact = Boolean(report?.html && artifactSource === 'ai' && !displayDocument);
  // True between clicking Generate and the new edition actually appearing.
  const waitingForNew = Boolean(generatingSince && (!report || (report.generatedAt || 0) < generatingSince));
  const generating =
    waitingForNew ||
    composingLetter ||
    (!reportIsStale && (report?.status === 'partial' || report?.artifactStatus === 'composing'));
  const showGeneratingState =
    generating && ((!displayArtifact && !displayDocument) || waitingForNew || composingLetter);
  // The letter from the stored sections, for editions without a document of
  // their own: older editions and the ones whose composition failed.
  const fallbackLetter = useMemo(() => {
    if (!report || displayDocument || displayArtifact) return null;
    return briefLetterFromReport(
      {
        generatedAt: report.generatedAt,
        narrative: report.narrative,
        tier: report.tier,
        prose: report.prose ?? null,
        // Absent lanes stay absent: the letter tells a budget edition from
        // a seven-lane one by which lanes the edition wrote.
        sections: {
          answer: asLane(report.sections.answer),
          today: asLane(report.sections.today),
          know: asLane(report.sections.know),
          replyOwed: asLane(report.sections.replyOwed),
          followUpOwed: asLane(report.sections.followUpOwed),
          timeSensitive: asLane(report.sections.timeSensitive),
          tracked: asLane(report.sections.tracked),
          newPeople: asLane(report.sections.newPeople),
          fyi: asLane(report.sections.fyi),
          calendar: asEvents(report.sections.calendar),
          albatross: asAlbatrossContext(report.sections.albatross),
        },
      },
      { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    );
  }, [report, displayDocument, displayArtifact]);
  const dismissedTaskIds = useMemo(
    () => taskDismissalsQuery.data?.cardIds || [],
    [taskDismissalsQuery.data?.cardIds],
  );
  const dismissedThreadRecords = useMemo(
    () =>
      (threadDismissalsQuery.data?.dismissals || [])
        .filter((dismissal) => dismissal.account && dismissal.threadId)
        .map((dismissal) => ({
          ...dismissal,
          threadKey: dailyReportThreadKey(dismissal.account, dismissal.threadId),
        })),
    [threadDismissalsQuery.data?.dismissals],
  );

  // Stop the "generating" state once an edition newer than the click has settled.
  useEffect(() => {
    if (!generatingSince || !report) return;
    if (
      (report.generatedAt || 0) >= generatingSince &&
      report.status !== 'partial' &&
      report.artifactStatus !== 'composing'
    ) {
      setGeneratingSince(null);
    }
  }, [report, generatingSince]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['daily-report'] });
    queryClient.invalidateQueries({ queryKey: ['tracked-threads'] });
  };

  const generate = useMutation({
    mutationFn: async () =>
      callTool<{ report: DailyReportPayload | null; started?: boolean }>('generate_daily_report', {
        kind: 'manual',
        wait: true,
      }),
    // Mark the moment so polling waits for the NEW edition, and jump to latest.
    onMutate: () => {
      setSelectedId(null);
      setGeneratingSince(Date.now());
    },
    onSuccess: (result) => {
      if (result.started === false && result.report?.generatedAt) {
        setGeneratingSince(result.report.generatedAt);
      }
      invalidate();
    },
    onError: () => setGeneratingSince(null),
  });

  const busy = generate.isPending || generating;
  const showsLetter = displayDocument || Boolean(fallbackLetter);
  const noiseCount = typeof report?.stats?.noise === 'number' ? report.stats.noise : null;

  return (
    <section className={cn('report-paper relative', embedded ? 'block' : 'flex h-full flex-col')}>
      {/* Embedded, the brief is a layer of Today rather than a page. Today has
          already said what day it is, so the brief states only who wrote it and
          when, and offers to write a new one in place. */}
      {embedded ? (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span aria-hidden className="h-px w-5 shrink-0 bg-[var(--color-border-strong)]" />
          <h2 className="font-serif text-[15px] font-semibold">The brief</h2>
          {/* The stamp is not decoration. This layer is generated, and the live
              layer above it is not, so the page has to say which is which. */}
          <p
            className={cn(
              'text-[12px]',
              embeddedStale ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-faint)]',
            )}
          >
            {!report
              ? 'Not written yet today.'
              : embeddedStale
                ? `${embeddedFreshness} — it describes an older day.`
                : `${embeddedFreshness}, from your mail and calendar.`}
          </p>
          <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
          <button
            type="button"
            disabled={busy}
            onClick={() => generate.mutate()}
            className="shrink-0 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-60"
          >
            {busy ? 'Writing…' : report ? 'Write it again' : "Write today's brief"}
          </button>
        </div>
      ) : null}

      {/* The letter and the legacy artifact carry their own masthead, so the
          app header is hidden for them and the controls move to a floating
          toolbar. */}
      {!embedded && !displayArtifact && !showsLetter ? (
        <header className="@container border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h1 className="font-serif text-[clamp(22px,6cqi,30px)] font-semibold italic leading-none tracking-tight text-[var(--color-text)]">
                The Daily Brief
              </h1>
              <p className="mt-2 font-serif text-[11px] text-[var(--color-text-muted)]">
                {report ? formatDateline(report) : 'From your mail and calendar'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {history.length > 1 ? (
                <Select
                  value={selectedId ?? 'latest'}
                  onValueChange={(value) => setSelectedId(value === 'latest' ? null : value)}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Browse past editions"
                    title="Browse past editions"
                    className="max-w-[180px] rounded-md border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  >
                    <SelectValue placeholder="Latest edition" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latest">Latest edition</SelectItem>
                    {history.map((item) => (
                      <SelectItem key={item._id} value={item._id}>
                        {editionLabel(item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPrimaryView('mail')}
                aria-label="Open inbox"
                title="Inbox"
                className="text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
              >
                <Inbox className="size-3.5" />
                <span className="hidden @[360px]:inline">Inbox</span>
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => generate.mutate()}
                aria-label="Write a new brief"
                title="Write"
              >
                {busy ? <Ring className="size-3" /> : <RefreshCw className="size-3" />}
                <span className="hidden @[360px]:inline">Write</span>
              </Button>
            </div>
          </div>
          {busy ? (
            <div className="mt-3 space-y-2">
              <p className="text-[12px] text-[var(--color-accent)]">
                {report?.artifactStatus === 'composing'
                  ? 'Writing your brief…'
                  : generating && report?.progress
                    ? `${report.progress.stage}${report.progress.total ? ` — ${Math.min(report.progress.done, report.progress.total)} of ${report.progress.total}` : ''}…`
                    : 'Reading your mail, tasks, and calendar to write today’s brief…'}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{
                    width: `${
                      report?.progress?.total
                        ? Math.max(6, Math.min(100, (report.progress.done / report.progress.total) * 100))
                        : 12
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </header>
      ) : null}

      {/* Floating toolbar for the letter and the artifact view — fades until
          hovered. Embedded, the same controls read as the section rule above. */}
      {!embedded && (displayArtifact || showsLetter) ? (
        <div className="group absolute right-4 top-4 z-20 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-1.5 py-1 opacity-40 shadow-[var(--shadow-soft)] backdrop-blur transition-opacity hover:opacity-100 focus-within:opacity-100">
          {history.length > 1 ? (
            <Select
              value={selectedId ?? 'latest'}
              onValueChange={(value) => setSelectedId(value === 'latest' ? null : value)}
            >
              <SelectTrigger
                size="sm"
                aria-label="Browse past editions"
                title="Browse past editions"
                className="h-7 max-w-[150px] rounded-full border-0 bg-transparent text-[11px] text-[var(--color-text-muted)] shadow-none hover:text-[var(--color-text)]"
              >
                <SelectValue placeholder="Latest" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Latest</SelectItem>
                {history.map((item) => (
                  <SelectItem key={item._id} value={item._id}>
                    {editionLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <button
            type="button"
            onClick={() => setPrimaryView('mail')}
            aria-label="Open inbox"
            title="Inbox"
            className="grid size-7 place-items-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
          >
            <Inbox className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => generate.mutate()}
            aria-label="Write a new brief"
            title="Write a new brief"
            className="grid size-7 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {busy ? <Ring className="size-3" /> : <RefreshCw className="size-3" />}
          </button>
        </div>
      ) : null}

      <DailyBriefLiveState />

      <div
        className={cn(
          embedded ? 'block' : 'min-h-0 flex-1',
          displayArtifact || showsLetter || showGeneratingState
            ? embedded
              ? ''
              : 'overflow-hidden'
            : cn('@container', embedded ? 'py-1' : 'scrollable px-5 py-5'),
        )}
      >
        {reportQuery.isLoading && !report ? (
          <BriefSkeleton masthead={!embedded} />
        ) : showGeneratingState || showsLetter || (displayArtifact && report?.html) ? (
          // Vortex while composing; when the brief lands, the vortex collapses
          // and the finished letter springs out of it.
          <AnimatePresence mode="wait" initial={false}>
            {showGeneratingState ? (
              <motion.div
                key="vortex"
                className={embedded ? undefined : 'h-full'}
                exit={{ opacity: 0, scale: 1.05 }}
                transition={{ duration: 0.25, ease: 'easeIn' }}
              >
                <ReportGenerating report={report} />
              </motion.div>
            ) : displayDocument && report?.document ? (
              <motion.div
                key="document-v2"
                className={embedded ? undefined : 'h-full'}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
              >
                <BriefCanvas
                  value={report.document}
                  composing={report.artifactStatus === 'composing'}
                  onChanged={invalidate}
                  // Today already carries the dateline masthead. A second one
                  // on the same scroll would say the date twice.
                  masthead={!embedded}
                  embedded={embedded}
                  noiseCount={noiseCount}
                  footer={embedded ? null : <BriefFooter report={report} />}
                />
              </motion.div>
            ) : fallbackLetter && report ? (
              <motion.div
                key="letter-fallback"
                className={embedded ? undefined : 'h-full'}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
              >
                <BriefCanvas
                  value={fallbackLetter}
                  onChanged={invalidate}
                  masthead={!embedded}
                  embedded={embedded}
                  noiseCount={noiseCount}
                  footer={
                    <>
                      {letterFailed ? (
                        <p
                          data-brief-letter-failed
                          className="mx-auto mt-6 flex max-w-[620px] flex-wrap items-baseline gap-x-3 text-[12.5px] text-[var(--color-text-muted)]"
                        >
                          <span>{BRIEF_LETTER_FAILED_COPY}</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => generate.mutate()}
                            className="text-[var(--color-accent)] hover:underline disabled:opacity-60"
                          >
                            Write it again
                          </button>
                        </p>
                      ) : null}
                      {report.errors?.length ? (
                        <p className="mx-auto mt-3 max-w-[620px] text-[11px] text-[var(--color-danger)]">
                          Some sources failed: {report.errors.join('; ')}
                        </p>
                      ) : null}
                      {embedded ? null : <BriefFooter report={report} />}
                    </>
                  }
                />
              </motion.div>
            ) : embedded && report?.html ? (
              // An edition from before the current format carries its own
              // full-bleed cover inside its HTML. Inlined under Today's plate
              // that is two mastheads and two dates on one page, so an old
              // edition is offered rather than unrolled.
              <motion.div key="artifact-legacy" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
                  <p className="text-[12.5px] text-[var(--color-text-muted)]">
                    This edition was written in the older format, with a cover of its own.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={onOpenLegacy}>
                    Open it
                  </Button>
                </div>
              </motion.div>
            ) : report?.html ? (
              <motion.div
                key="artifact"
                className={embedded ? undefined : 'h-full'}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 190, damping: 22, mass: 0.9 }}
              >
                <ReportArtifact
                  html={report.html}
                  albatrossContext={asAlbatrossContext(report.sections.albatross)}
                  dismissedTaskIds={dismissedTaskIds}
                  dismissedThreadRecords={dismissedThreadRecords}
                  onChanged={invalidate}
                  autoHeight={embedded}
                />
              </motion.div>
            ) : (
              <ReportGenerating report={report} />
            )}
          </AnimatePresence>
        ) : embedded ? (
          // Embedded, a missing brief thins the page. It never replaces the
          // live day above it with a full-height empty state.
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            Albatross writes this each morning from your mail and calendar. There is no edition for today yet.
          </p>
        ) : (
          <Empty className="grid h-full place-items-center px-6 py-12 text-center">
            <EmptyHeader>
              <EmptyMedia>
                <Newspaper className="h-4 w-4 text-[var(--color-text-faint)]" />
              </EmptyMedia>
              <EmptyTitle className="font-serif text-[18px] italic">No edition yet</EmptyTitle>
              <EmptyDescription>
                Press Write to get today&apos;s brief. The morning run files here each day.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  );
}

function DailyBriefLiveState() {
  const { isAuthenticated } = useConvexAuth();
  const checkin = useConvexQuery(api.albatrossNotifications.currentCheckin, isAuthenticated ? {} : 'skip') as
    | DailyCheckinData
    | null
    | undefined;
  const questions = useConvexQuery(
    api.albatrossWorkV2.livePendingQuestions,
    isAuthenticated ? { limit: 5 } : 'skip',
  ) as
    | Array<{
        question: { _id: string; prompt: string };
        work: null | { _id: string; title?: string; rawText: string; workState?: string; status?: string };
      }>
    | undefined;
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const [checkinOpen, setCheckinOpen] = useState(false);
  // The same needs-you definition Today, the rail and the list use. This bar
  // used to count questions on Albatrosses the user had already put down, so it
  // could claim three things needed you on a day when nothing did.
  const pending =
    questions?.filter(
      (row) => row.work && !isClosed({ workState: row.work.workState, status: row.work.status }),
    ) || [];
  if (!checkin && !pending.length) return null;
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const carryover = checkin && checkin.localDate !== today;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-5 py-2.5 text-[11.5px]">
        {checkin ? (
          <button
            type="button"
            onClick={() => setCheckinOpen(true)}
            className="font-medium text-[var(--color-warning)] hover:underline"
          >
            {carryover ? 'Yesterday’s check-in is still open' : 'Evening check-in is ready'}
          </button>
        ) : null}
        {pending.length ? (
          <button
            type="button"
            onClick={() => {
              setSelectedWorkId(String(pending[0].work!._id));
              setPrimaryView('albatrosses');
            }}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
          >
            {pending.length === 1 ? 'One question needs you' : `${pending.length} questions need you`}
          </button>
        ) : null}
        {/* This used to read "Live", on a page that could be describing a day
            three weeks old. Today owns the freshness stamp now. */}
      </div>
      <DailyCheckin checkin={checkin || null} open={checkinOpen} onOpenChange={setCheckinOpen} />
    </>
  );
}
