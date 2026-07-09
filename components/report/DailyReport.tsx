'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  FileText,
  Inbox,
  Newspaper,
  RefreshCw,
  User,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextVortex, type VortexSource } from '@/components/albatross/ContextVortex';
import { ConnectionLogo, GmailLogo, ProviderLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Markdown } from '@/components/ui/markdown';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AlbatrossDailyReportContext } from '@/lib/albatross/daily-report';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { type BriefService, briefServicesFromIds } from '@/lib/mail/brief-services';
import { injectReportAreaBrief } from '@/lib/mail/report-area-brief';
import { formatDate, stripEmoji } from '@/lib/shared/format';
import { taskSourceColor } from '@/lib/shared/task-colors';
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
  server: 'github' | 'bitbucket' | 'jira' | 'slack';
  kind: string;
  title: string;
  state?: string | null;
  author?: string | null;
  url?: string | null;
  updatedAt?: number | null;
}

interface DailyReportArtifactError {
  stage: 'ai_availability' | 'week_artifact' | 'month_artifact' | 'month_enrichment';
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
  };
  model?: string;
  errors?: string[];
  services?: string[];
  status?: 'partial' | 'ready';
  progress?: { stage: string; done: number; total: number };
  // Agent-authored self-contained HTML artifact (served in a sandboxed iframe).
  html?: string;
  artifactStatus?: 'composing' | 'enriching' | 'rendered';
  artifactSource?: 'ai' | 'deterministic';
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

// Sections, in reading order. The report leads with what the user owes other
// people, then who's new, then anything time-boxed, then quieter context.
const SECTION_LABELS: Array<[string, string, number, boolean]> = [
  ['replyOwed', 'Needs You — Reply Owed', 5, true],
  ['followUpOwed', 'Follow-Up Owed', 5, true],
  ['newPeople', 'New People', 3, false],
  ['timeSensitive', 'Time-Sensitive', 3, true],
  ['tracked', 'Tracked Conversations', 5, false],
  ['fyi', 'FYI', 3, false],
];

const BULK_TAIL_DISPLAY_LIMIT = 8;

const summaryKeys: Array<[string, string]> = [
  ['replyOwed', 'Reply'],
  ['followUpOwed', 'Follow Up'],
  ['newPeople', 'New'],
];

// Provenance pills — why the floor surfaced a thread, in plain language.
const PILL_LABELS: Record<string, string> = {
  reply_owed: 'Reply owed',
  follow_up_owed: 'Follow-up',
  category_personal: 'Personal',
  important: 'Important',
  new_sender: 'New sender',
  known_contact: 'Known contact',
  due_soon: 'Due soon',
};

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

function asItems(value: DailyReportPayload['sections'][string]): DailyReportItem[] {
  return Array.isArray(value) ? (value as DailyReportItem[]) : [];
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

function stripEmojiPreservingMarkdown(value: string) {
  return String(value || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .trim();
}

function dailyReportItemThreadKey(item: DailyReportItem): string {
  return dailyReportThreadKey(item.account, item.threadId);
}

function dailyReportThreadDismissalForItem(
  item: DailyReportItem,
  action: DailyReportThreadDismissalRecord['action'],
): DailyReportThreadDismissalRecord {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject,
    receivedAt: item.receivedAt ?? null,
    dismissedAt: Date.now(),
    action,
  };
}

function threadDismissalCutoff(dismissal: DailyReportThreadDismissalRecord): number {
  return typeof dismissal.receivedAt === 'number' ? dismissal.receivedAt : dismissal.dismissedAt;
}

function isHiddenByThreadDismissal(
  item: DailyReportItem,
  dismissals: Map<string, DailyReportThreadDismissalRecord>,
): boolean {
  const dismissal = dismissals.get(dailyReportItemThreadKey(item));
  if (!dismissal) return false;
  return (item.receivedAt ?? 0) <= threadDismissalCutoff(dismissal);
}

// Gmail-Nudge-style framing: "Received 4 days ago — reply?".
function elapsedFraming(item: DailyReportItem): string {
  if (!item.receivedAt) return '';
  const days = Math.floor((Date.now() - item.receivedAt) / 86_400_000);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  if (item.lane === 'reply_owed') return `Received ${when} — reply?`;
  if (item.lane === 'follow_up_owed') return `You wrote ${when === 'today' ? 'today' : when} — nudge?`;
  return '';
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
    service.id === 'slack'
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
  return next;
}

function ReportArtifact({
  html,
  albatrossContext,
  dismissedTaskIds,
  dismissedThreadRecords,
  onChanged,
}: {
  html: string;
  albatrossContext?: AlbatrossDailyReportContext | null;
  dismissedTaskIds: string[];
  dismissedThreadRecords: DailyReportThreadDismissalRecord[];
  onChanged?: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
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

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data = event.data as { source?: string; action?: string; payload?: any } | null;
      if (!data || data.source !== 'lab86-daily-report') return;
      // Only trust messages from our own iframe document.
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
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
      // Read-only actions (open_*, draft_reply only seeds the composer) are exempt.
      const confirmFor: Record<string, string> = {
        toggle_task: payload.completed
          ? `Mark “${payload.title || 'this task'}” complete?`
          : `Reopen “${payload.title || 'this task'}”?`,
        dismiss_task: `Remove “${payload.title || 'this task'}” from future briefs?`,
        resolve_thread: `Mark “${payload.subject || 'this thread'}” resolved and remove it from future briefs?`,
        dismiss_thread: `Remove “${payload.subject || 'this conversation'}” from future briefs?`,
        create_task: `Add “${payload.title || 'this task'}” to your tasks?`,
        archive_thread: `Archive “${payload.subject || 'this conversation'}” and remove it from future briefs?`,
        rsvp_event: `Send a “${payload.status}” RSVP for this event?`,
        create_event: `Add “${payload.title || 'this event'}” to your calendar?`,
      };
      const confirmMsg = data.action ? confirmFor[data.action] : undefined;
      if (confirmMsg && !window.confirm(confirmMsg)) return ack(false, 'cancelled');
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
    setPendingReplyBody,
    onChanged,
  ]);

  return (
    <iframe
      ref={frameRef}
      title="The Daily Brief"
      srcDoc={withReportArtifactRuntime(html, albatrossContext)}
      onLoad={() => {
        postTheme();
        postDismissedTasks();
        postDismissedThreads();
      }}
      // allow-scripts (for interactivity) WITHOUT allow-same-origin keeps the
      // artifact sandboxed from the app origin; allow-popups lets external
      // links open in a new tab.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      className="h-full w-full border-0 bg-[var(--color-bg)]"
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

function FullArtifactUnavailable({
  artifactErrors,
  retrying,
  onRetry,
  onShowFallback,
}: {
  artifactErrors?: DailyReportArtifactError[];
  retrying: boolean;
  onRetry: () => void;
  onShowFallback: () => void;
}) {
  const failures = (artifactErrors || []).slice(-3).reverse();
  return (
    <Empty className="grid h-full place-items-center px-6 py-12 text-center">
      <EmptyHeader>
        <EmptyMedia>
          <Ban className="h-4 w-4 text-[var(--color-danger)]" />
        </EmptyMedia>
        <EmptyTitle className="font-serif text-[18px] italic">Full artifact unavailable</EmptyTitle>
        <EmptyDescription>
          The AI artifact was not saved for this edition. The exact recorded failure is below.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="w-full space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-left shadow-[var(--shadow-soft)]">
          {failures.length ? (
            failures.map((failure) => (
              <div key={`${failure.stage}-${failure.at}`} className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">
                  {artifactStageLabel(failure.stage)}
                </div>
                <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
                  {stripEmojiPreservingMarkdown(failure.message)}
                </p>
              </div>
            ))
          ) : (
            <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
              No artifact failure detail was saved for this older edition. Generate again to capture the exact
              failure.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? <Ring className="size-3" /> : <RefreshCw className="size-3" />}
            Generate again
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onShowFallback}>
            <FileText className="size-3" />
            View structured fallback
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}

function artifactStageLabel(stage: DailyReportArtifactError['stage']) {
  switch (stage) {
    case 'ai_availability':
      return 'AI availability';
    case 'week_artifact':
      return 'Week artifact composition';
    case 'month_artifact':
      return 'Month artifact composition';
    case 'month_enrichment':
      return 'Month report enrichment';
  }
}

export function DailyReport() {
  const queryClient = useQueryClient();
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);

  // Browse history; the freshest edition shows by default (selectedId = null).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Timestamp of the last manual Generate. We keep polling until an edition
  // newer than this appears — otherwise the post-click refetch lands on the OLD
  // report (the new one isn't saved yet), polling stops, and the fresh brief
  // never shows.
  const [generatingSince, setGeneratingSince] = useState<number | null>(null);
  const [showStructuredFallback, setShowStructuredFallback] = useState(false);
  const [hiddenTaskIds, setHiddenTaskIds] = useState<Set<string>>(() => new Set());
  const [hiddenThreadDismissals, setHiddenThreadDismissals] = useState<
    Map<string, DailyReportThreadDismissalRecord>
  >(() => new Map());

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
    // agent is composing its HTML artifact, OR while we're waiting for a
    // freshly-triggered edition to land — so the page upgrades live.
    refetchInterval: (query) => {
      const r = query.state.data?.report;
      // A status that has sat past this cutoff is from a generation that died
      // mid-flight; stop polling it so we don't hammer a forever-stuck edition.
      const stuck = !r || Date.now() - (r.generatedAt || 0) > STUCK_GENERATION_MS;
      if (!stuck && (r?.status === 'partial' || r?.artifactStatus === 'composing')) return 2_000;
      // The month pass enriches an already-shown edition in the background.
      if (!stuck && r?.artifactStatus === 'enriching') return 3_000;
      if (generatingSince && (!r || (r.generatedAt || 0) < generatingSince)) return 1_500;
      return false;
    },
  });
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
  const reportArtifactKey = report ? [report._id, report.artifactSource ?? ''].join(':') : '';
  // A generation that errored partway leaves the stored edition stuck at
  // 'partial'/'composing'/'enriching' forever. Past this cutoff we treat such a
  // status as dead, so the in-progress UI clears and the Generate button is
  // clickable again to force a fresh run.
  const reportIsStale = !report || Date.now() - (report.generatedAt || 0) > STUCK_GENERATION_MS;
  const artifactSource = report?.html ? (report.artifactSource ?? 'ai') : null;
  const structuredArtifactHidden =
    Boolean(report?.html) && artifactSource === 'deterministic' && !showStructuredFallback;
  const waitingForAiArtifact =
    structuredArtifactHidden &&
    !reportIsStale &&
    (report?.artifactStatus === 'composing' || report?.artifactStatus === 'enriching');
  const structuredArtifactUnavailable =
    structuredArtifactHidden && !waitingForAiArtifact && (reportIsStale || report?.status !== 'partial');
  const displayArtifact = Boolean(report?.html && !structuredArtifactHidden);
  // True between clicking Generate and the new edition actually appearing.
  const waitingForNew = Boolean(generatingSince && (!report || (report.generatedAt || 0) < generatingSince));
  const generating =
    waitingForNew ||
    waitingForAiArtifact ||
    (!reportIsStale && (report?.status === 'partial' || report?.artifactStatus === 'composing'));
  // The artifact is already shown; the broader month pass is filling in behind it.
  const enriching = !reportIsStale && report?.artifactStatus === 'enriching';
  const showGeneratingState = generating && (!displayArtifact || waitingForNew || waitingForAiArtifact);
  const persistedHiddenTaskIds = useMemo(
    () => new Set(taskDismissalsQuery.data?.cardIds || []),
    [taskDismissalsQuery.data?.cardIds],
  );
  const combinedHiddenTaskIds = useMemo(() => {
    const ids = new Set(persistedHiddenTaskIds);
    for (const id of hiddenTaskIds) ids.add(id);
    return ids;
  }, [persistedHiddenTaskIds, hiddenTaskIds]);
  const dismissedTaskIds = useMemo(() => [...combinedHiddenTaskIds], [combinedHiddenTaskIds]);
  const persistedHiddenThreadDismissals = useMemo(() => {
    const dismissals = new Map<string, DailyReportThreadDismissalRecord>();
    for (const dismissal of threadDismissalsQuery.data?.dismissals || []) {
      if (!dismissal.account || !dismissal.threadId) continue;
      dismissals.set(dailyReportThreadKey(dismissal.account, dismissal.threadId), dismissal);
    }
    return dismissals;
  }, [threadDismissalsQuery.data?.dismissals]);
  const combinedHiddenThreadDismissals = useMemo(() => {
    const dismissals = new Map(persistedHiddenThreadDismissals);
    for (const [key, dismissal] of hiddenThreadDismissals) dismissals.set(key, dismissal);
    return dismissals;
  }, [persistedHiddenThreadDismissals, hiddenThreadDismissals]);
  const dismissedThreadRecords = useMemo(
    () =>
      [...combinedHiddenThreadDismissals.entries()].map(([threadKey, dismissal]) => ({
        ...dismissal,
        threadKey,
      })),
    [combinedHiddenThreadDismissals],
  );
  const visibleReportTasks = report
    ? asTasks(report.sections.tasks).filter(
        (task) => !task.completedAt && !combinedHiddenTaskIds.has(task.cardId),
      )
    : [];
  const visibleReportItems = (items: DailyReportItem[]) =>
    items.filter((item) => !isHiddenByThreadDismissal(item, combinedHiddenThreadDismissals));

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

  useEffect(() => {
    if (!reportArtifactKey) return;
    setShowStructuredFallback(false);
  }, [reportArtifactKey]);

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

  // Correction loop — both feed the classifier's user-rule short-circuit, so the
  // next report self-corrects. "Not for me" routes the sender to noise; "This is
  // a person" pins the sender to Main.
  const dismissSender = useMutation({
    mutationFn: async (item: DailyReportItem) =>
      callTool('apply_smart_correction', {
        account: item.account,
        threadId: item.threadId,
        action: 'always_noise',
        scope: 'sender',
      }),
    onSuccess: invalidate,
  });

  const markPerson = useMutation({
    mutationFn: async (item: DailyReportItem) =>
      callTool('mark_sender_human', { account: item.account, threadId: item.threadId }),
    onSuccess: invalidate,
  });

  const completeTask = useMutation({
    mutationFn: async (task: DailyReportTaskItem) => {
      await callTool('tasks_update_card', { cardId: task.cardId, completed: true });
      await callTool('dismiss_daily_report_task', { cardId: task.cardId, title: task.title }).catch(
        () => undefined,
      );
    },
    onMutate: (task) => {
      const previous = hiddenTaskIds;
      setHiddenTaskIds((current) => new Set(current).add(task.cardId));
      return { previous };
    },
    onError: (_error, _task, context) => {
      if (context?.previous) setHiddenTaskIds(context.previous);
    },
    onSuccess: invalidate,
  });

  const dismissTask = useMutation({
    mutationFn: async (task: DailyReportTaskItem) =>
      callTool('dismiss_daily_report_task', { cardId: task.cardId, title: task.title }),
    onMutate: (task) => {
      const previous = hiddenTaskIds;
      setHiddenTaskIds((current) => new Set(current).add(task.cardId));
      return { previous };
    },
    onError: (_error, _task, context) => {
      if (context?.previous) setHiddenTaskIds(context.previous);
    },
    onSuccess: invalidate,
  });

  const resolveThread = useMutation({
    mutationFn: async (item: DailyReportItem) => {
      await callTool('dismiss_daily_report_thread', {
        account: item.account,
        threadId: item.threadId,
        subject: item.subject,
        receivedAt: item.receivedAt ?? null,
        action: 'resolved',
      });
      if (item.trackedThreadId) await callTool('resolve_tracked_thread', { id: item.trackedThreadId });
    },
    onMutate: (item) => {
      const previous = hiddenThreadDismissals;
      setHiddenThreadDismissals((current) => {
        const next = new Map(current);
        next.set(dailyReportItemThreadKey(item), dailyReportThreadDismissalForItem(item, 'resolved'));
        return next;
      });
      return { previous };
    },
    onError: (_error, _item, context) => {
      if (context?.previous) setHiddenThreadDismissals(context.previous);
    },
    onSuccess: invalidate,
  });

  const hideThread = useMutation({
    mutationFn: async (item: DailyReportItem) =>
      callTool('dismiss_daily_report_thread', {
        account: item.account,
        threadId: item.threadId,
        subject: item.subject,
        receivedAt: item.receivedAt ?? null,
        action: 'dismissed',
      }),
    onMutate: (item) => {
      const previous = hiddenThreadDismissals;
      setHiddenThreadDismissals((current) => {
        const next = new Map(current);
        next.set(dailyReportItemThreadKey(item), dailyReportThreadDismissalForItem(item, 'dismissed'));
        return next;
      });
      return { previous };
    },
    onError: (_error, _item, context) => {
      if (context?.previous) setHiddenThreadDismissals(context.previous);
    },
    onSuccess: invalidate,
  });

  const openThread = (item: DailyReportItem) => {
    setThreadAccount(item.account);
    setSelectedThread(item.threadId);
  };

  const rowHandlers = {
    onOpen: openThread,
    onResolveThread: (item: DailyReportItem) => resolveThread.mutate(item),
    onHideThread: (item: DailyReportItem) => hideThread.mutate(item),
    resolvingThreadKey: resolveThread.isPending
      ? dailyReportItemThreadKey(resolveThread.variables as DailyReportItem)
      : undefined,
    hidingThreadKey: hideThread.isPending
      ? dailyReportItemThreadKey(hideThread.variables as DailyReportItem)
      : undefined,
    onDismissSender: (item: DailyReportItem) => dismissSender.mutate(item),
    onMarkPerson: (item: DailyReportItem) => markPerson.mutate(item),
    dismissingId: dismissSender.isPending ? dismissSender.variables?.threadId : undefined,
    markingId: markPerson.isPending ? markPerson.variables?.threadId : undefined,
  };

  return (
    <section className="report-paper relative flex h-full flex-col">
      {/* The agent-authored brief carries its own art masthead, so the app
          header is hidden for it and the controls move to a floating toolbar. */}
      {!displayArtifact ? (
        <header className="@container border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h1 className="font-serif text-[clamp(22px,6cqi,30px)] font-semibold italic leading-none tracking-tight text-[var(--color-text)]">
                The Daily Brief
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="font-serif text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                  {report ? formatDateline(report) : 'From your mail & calendar'}
                </p>
                {report && report.status !== 'partial' ? (
                  <span
                    title="The rich artifact is not present for this edition."
                    className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
                  >
                    Fallback view
                  </span>
                ) : null}
              </div>
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
                disabled={generate.isPending || generating || enriching}
                onClick={() => generate.mutate()}
                aria-label="Generate a fresh report"
                title="Generate"
              >
                {generate.isPending || generating || enriching ? (
                  <Ring className="size-3" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                <span className="hidden @[360px]:inline">Generate</span>
              </Button>
            </div>
          </div>
          {generate.isPending || generating ? (
            <div className="mt-3 space-y-2">
              <p className="text-[12px] text-[var(--color-accent)]">
                {report?.artifactStatus === 'composing'
                  ? 'Designing your brief — laying out the narrative, charts, and to-dos…'
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

      {/* Floating toolbar for the artifact view — fades until hovered. */}
      {displayArtifact ? (
        <div className="group absolute right-4 top-4 z-20 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-1.5 py-1 opacity-40 shadow-[var(--shadow-soft)] backdrop-blur transition-opacity hover:opacity-100 focus-within:opacity-100">
          {artifactSource === 'deterministic' ? (
            <span
              title="AI composition was unavailable, so this edition is using the structured artifact fallback."
              className="flex items-center gap-1 pl-1.5 pr-1 text-[10px] text-[var(--color-text-muted)]"
            >
              <FileText className="size-2.5" />
              <span className="hidden @[520px]:inline">Structured fallback</span>
            </span>
          ) : (
            <span
              title="This edition is using the AI-composed artifact."
              className="flex items-center gap-1 pl-1.5 pr-1 text-[10px] text-[var(--color-text-muted)]"
            >
              <Newspaper className="size-2.5" />
              <span className="hidden @[520px]:inline">AI rendered</span>
            </span>
          )}
          {enriching ? (
            <span className="flex items-center gap-1 pl-1.5 pr-1 text-[10px] text-[var(--color-text-muted)]">
              <Ring className="size-2.5" />
              <span className="hidden @[420px]:inline">Adding the past month…</span>
            </span>
          ) : null}
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
            disabled={generate.isPending || generating || enriching}
            onClick={() => generate.mutate()}
            aria-label="Generate a fresh report"
            title="Generate a fresh brief"
            className="grid size-7 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {generate.isPending || generating ? (
              <Ring className="size-3" />
            ) : (
              <RefreshCw className="size-3" />
            )}
          </button>
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1',
          displayArtifact || showGeneratingState ? 'overflow-hidden' : 'scrollable @container px-5 py-5',
        )}
      >
        {reportQuery.isLoading && !report ? (
          <ReportSkeleton />
        ) : showGeneratingState || (displayArtifact && report?.html) ? (
          // Vortex while composing; when the brief lands, the vortex collapses
          // and the finished artifact springs out of it.
          <AnimatePresence mode="wait" initial={false}>
            {showGeneratingState || !report?.html ? (
              <motion.div
                key="vortex"
                className="h-full"
                exit={{ opacity: 0, scale: 1.05 }}
                transition={{ duration: 0.25, ease: 'easeIn' }}
              >
                <ReportGenerating report={report} />
              </motion.div>
            ) : (
              <motion.div
                key="artifact"
                className="h-full"
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
                />
              </motion.div>
            )}
          </AnimatePresence>
        ) : !report ? (
          <Empty className="grid h-full place-items-center px-6 py-12 text-center">
            <EmptyHeader>
              <EmptyMedia>
                <Newspaper className="h-4 w-4 text-[var(--color-text-faint)]" />
              </EmptyMedia>
              <EmptyTitle className="font-serif text-[18px] italic">No edition yet</EmptyTitle>
              <EmptyDescription>
                Press Generate to print today&apos;s brief. Scheduled morning runs will file here once
                installed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : structuredArtifactUnavailable ? (
          <FullArtifactUnavailable
            artifactErrors={report.artifactErrors}
            retrying={generate.isPending}
            onRetry={() => generate.mutate()}
            onShowFallback={() => setShowStructuredFallback(true)}
          />
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-7">
            {/* Narrative. */}
            {report.narrative ? (
              <section
                className="blur-in rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-5 py-5 shadow-[var(--shadow-soft)]"
                style={{ animationDelay: '60ms' }}
              >
                <Markdown className="space-y-3 text-[13px] leading-6 text-[var(--color-text-muted)] [&_h1]:font-serif [&_h1]:text-[20px] [&_h1]:font-semibold [&_h1]:italic [&_h1]:leading-tight [&_h1]:text-[var(--color-text)] [&_h2]:mt-4 [&_h2]:font-serif [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:leading-tight [&_h2]:text-[var(--color-text)] [&_h3]:mt-3 [&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.12em] [&_h3]:text-[var(--color-accent)] [&_li]:ml-4 [&_li]:list-disc [&_p]:m-0 [&_strong]:font-semibold [&_strong]:text-[var(--color-text)]">
                  {stripEmojiPreservingMarkdown(report.narrative)}
                </Markdown>
              </section>
            ) : null}

            {/* Front-page lanes. */}
            <div
              className="blur-in grid grid-cols-1 gap-3 @[480px]:grid-cols-3"
              style={{ animationDelay: '120ms' }}
            >
              {summaryKeys.map(([key, label]) => {
                const items = visibleReportItems(asItems(report.sections[key]));
                const first = items[0];
                return (
                  <button
                    key={String(key)}
                    type="button"
                    disabled={!first}
                    onClick={() => first && openThread(first)}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3.5 text-left shadow-[var(--shadow-soft)] enabled:hover:border-[var(--color-border-strong)] enabled:hover:bg-[var(--color-hover-soft)] disabled:opacity-55"
                  >
                    <div className="flex items-baseline justify-between">
                      <div className="font-serif text-[11px] uppercase tracking-[0.16em] text-[var(--color-accent)]">
                        {label}
                      </div>
                      <div className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
                        {items.length || ''}
                      </div>
                    </div>
                    <div className="mt-2 line-clamp-2 font-serif text-[15px] leading-snug font-medium text-[var(--color-text)]">
                      {first ? stripEmoji(first.subject || first.people[0] || 'Nothing active') : 'All clear'}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--color-text-muted)]">
                      {first ? stripEmoji(first.whyItMatters) : 'Nothing needs this lane right now.'}
                    </div>
                  </button>
                );
              })}
            </div>

            <TaskCalendarBrief
              tasks={visibleReportTasks}
              events={asEvents(report.sections.calendar)}
              delay={170}
              onOpenTasks={() => setPrimaryView('tasks')}
              onOpenCalendar={() => setPrimaryView('calendar')}
              onCompleteTask={(task) => completeTask.mutate(task)}
              onDismissTask={(task) => dismissTask.mutate(task)}
              completingTaskId={completeTask.isPending ? completeTask.variables?.cardId : undefined}
              dismissingTaskId={dismissTask.isPending ? dismissTask.variables?.cardId : undefined}
            />

            <AlbatrossBrief context={asAlbatrossContext(report.sections.albatross)} delay={205} />

            {/* Sections. */}
            {SECTION_LABELS.map(([key, label, limit, roomy], i) => (
              <ReportSection
                key={String(key)}
                label={label}
                items={visibleReportItems(asItems(report.sections[key]))}
                limit={limit}
                roomy={roomy}
                delay={240 + i * 60}
                {...rowHandlers}
              />
            ))}

            {/* Bulk & automated tail — collapsed by default, humans never here. */}
            <BulkTail
              items={visibleReportItems(asItems(report.sections.bulkTail))}
              delay={240 + SECTION_LABELS.length * 60}
              onOpen={openThread}
            />

            <BriefFooter report={report} />
            {(typeof report.sections.noiseSummary === 'string' || report.errors?.length) && (
              <div className="pb-6 text-[11px] text-[var(--color-text-faint)]">
                {typeof report.sections.noiseSummary === 'string' ? (
                  <div className="text-[var(--color-text-muted)]">
                    {stripEmoji(report.sections.noiseSummary)}
                  </div>
                ) : null}
                {report.errors?.length ? (
                  <div className="text-[var(--color-danger)]">
                    Some sources failed: {report.errors.join('; ')}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface RowHandlers {
  onOpen: (item: DailyReportItem) => void;
  onResolveThread: (item: DailyReportItem) => void;
  resolvingThreadKey?: string;
  onHideThread: (item: DailyReportItem) => void;
  hidingThreadKey?: string;
  onDismissSender: (item: DailyReportItem) => void;
  onMarkPerson: (item: DailyReportItem) => void;
  dismissingId?: string;
  markingId?: string;
}

// Report links come from synced provider data (task sources, calendar
// htmlLinks). Allow only http(s) into an href so a stored javascript:/data:
// scheme can't execute when the link is clicked.
function safeExternalHref(value?: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function formatEventWindow(event: DailyReportCalendarItem): string {
  const start = new Date(event.startAt);
  if (event.allDay) {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(start);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(start);
}

function TaskCalendarBrief({
  tasks,
  events,
  delay,
  onOpenTasks,
  onOpenCalendar,
  onCompleteTask,
  onDismissTask,
  completingTaskId,
  dismissingTaskId,
}: {
  tasks: DailyReportTaskItem[];
  events: DailyReportCalendarItem[];
  delay: number;
  onOpenTasks: () => void;
  onOpenCalendar: () => void;
  onCompleteTask: (task: DailyReportTaskItem) => void;
  onDismissTask: (task: DailyReportTaskItem) => void;
  completingTaskId?: string;
  dismissingTaskId?: string;
}) {
  if (!tasks.length && !events.length) return null;
  const visibleTasks = tasks.slice(0, 8);
  const visibleEvents = events.slice(0, 8);
  return (
    <section className="blur-in grid gap-3 @[700px]:grid-cols-2" style={{ animationDelay: `${delay}ms` }}>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3.5 shadow-[var(--shadow-soft)]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-serif text-[13px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text)]">
            Task Board
          </h2>
          <button
            type="button"
            onClick={onOpenTasks}
            className="text-[11px] font-medium text-[var(--color-accent)] hover:underline"
          >
            Open tasks
          </button>
        </div>
        {visibleTasks.length ? (
          <ul className="space-y-2">
            {visibleTasks.map((task) => (
              <li
                key={task.cardId}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-[var(--task-border,var(--color-border))] bg-[var(--color-bg-elevated)] px-3 py-2.5 shadow-[var(--shadow-soft)]"
                style={taskBriefSurfaceStyle(task)}
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={onOpenTasks}
                    className={cn(
                      'block max-w-full truncate text-left text-[13px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]',
                      task.completedAt && 'text-[var(--color-text-faint)] line-through',
                    )}
                  >
                    {stripEmoji(task.title)}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--color-text-faint)]">
                    <span>{task.scope === 'week' ? 'Last week' : 'Last month'}</span>
                    {task.columnName ? <span>{task.columnName}</span> : null}
                    {task.dueAt ? <span>Due {formatDate(task.dueAt)}</span> : null}
                    {task.priority ? <span>{task.priority}</span> : null}
                    {safeExternalHref(task.sourceUrl) ? (
                      <a
                        href={safeExternalHref(task.sourceUrl) as string}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[var(--color-accent)] hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {task.sourceTitle || 'Source'}
                      </a>
                    ) : null}
                  </div>
                  {task.description ? (
                    <p className="mt-1 line-clamp-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                      {stripEmoji(task.description)}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-start gap-0.5 pt-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Complete task"
                        onClick={() => onCompleteTask(task)}
                        className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-success)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                      >
                        {completingTaskId === task.cardId ? (
                          <Ring className="size-3.5" />
                        ) : (
                          <CheckCircle2 className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Complete</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Remove from future briefs"
                        onClick={() => onDismissTask(task)}
                        className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-danger)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                      >
                        {dismissingTaskId === task.cardId ? (
                          <Ring className="size-3.5" />
                        ) : (
                          <X className="size-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Remove from briefs</TooltipContent>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-[var(--color-text-faint)]">
            No active task context in the last month.
          </p>
        )}
      </div>

      <div className="@container rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3.5 shadow-[var(--shadow-soft)] @[700px]:col-span-2">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-serif text-[13px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text)]">
            Calendar
          </h2>
          <button
            type="button"
            onClick={onOpenCalendar}
            className="text-[11px] font-medium text-[var(--color-accent)] hover:underline"
          >
            Open calendar
          </button>
        </div>
        {visibleEvents.length ? (
          <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <ul className="divide-y divide-[var(--color-border)]">
              {visibleEvents.map((event) => (
                <li
                  key={`${event.account}:${event.eventId}:${event.startAt}`}
                  className="grid gap-1.5 px-2.5 py-2 @[520px]:grid-cols-[10.5rem_minmax(0,1fr)]"
                >
                  <div className="whitespace-nowrap text-[10.5px] font-medium tabular-nums text-[var(--color-text-faint)]">
                    {formatEventWindow(event)}
                  </div>
                  <div className="min-w-0">
                    {safeExternalHref(event.htmlLink) ? (
                      <a
                        href={safeExternalHref(event.htmlLink) as string}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="line-clamp-2 break-words text-[12.5px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                      >
                        {stripEmoji(event.title)}
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={onOpenCalendar}
                        className="line-clamp-2 max-w-full break-words text-left text-[12.5px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                      >
                        {stripEmoji(event.title)}
                      </button>
                    )}
                    {event.location ? (
                      <p className="mt-0.5 line-clamp-2 break-words text-[10.5px] text-[var(--color-text-faint)]">
                        {stripEmoji(event.location)}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-[12px] text-[var(--color-text-faint)]">No calendar context in the last month.</p>
        )}
      </div>
    </section>
  );
}

// Issue #85: the brief carries active Albatross intents and projects even when
// the inbox is quiet, and asks - rather than assumes - about loud-but-undeclared
// areas. Kept compact: one operational strip in the report's voice, never a
// second dashboard.
function AreaReportMark({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    // biome-ignore lint/performance/noImgElement: report area marks use arbitrary favicon/image URLs.
    <img
      src={src}
      alt=""
      className="mt-0.5 size-5 shrink-0 rounded object-cover"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function AlbatrossBrief({ context, delay }: { context: AlbatrossDailyReportContext | null; delay: number }) {
  if (!context) return null;
  const {
    activeProjects,
    activeIntents,
    askBeforeCentering,
    includedAreas,
    contextReview,
    completions,
    monthlyPrompt,
  } = context;
  const hasActive = activeProjects.length > 0 || activeIntents.length > 0;
  const contextItems = [
    ...includedAreas.map((area) => ({
      id: `area:${area.areaId}`,
      title: area.name,
      meta: area.reason,
      imageUrl: area.imageUrl ?? area.faviconUrl ?? null,
    })),
    ...contextReview.map((item) => ({
      id: `review:${item.id}`,
      title: item.title,
      meta: item.reason || 'Needs context review',
      imageUrl: null,
    })),
    ...completions.map((event) => ({
      id: `completion:${event.id}`,
      title: event.summary,
      meta: event.completedAt ? formatDate(event.completedAt) : 'Completed',
      imageUrl: null,
    })),
  ].slice(0, 6);
  if (!hasActive && askBeforeCentering.length === 0 && contextItems.length === 0 && !monthlyPrompt) {
    return null;
  }

  return (
    <section className="blur-in @container" style={{ animationDelay: `${delay}ms` }}>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3.5 shadow-[var(--shadow-soft)]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-serif text-[14px] font-semibold text-[var(--color-text)]">
            Areas &amp; Intents
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
            {activeProjects.length + activeIntents.length + askBeforeCentering.length + contextItems.length ||
              ''}
          </span>
        </div>

        {monthlyPrompt ? (
          <p className="mb-2.5 rounded-lg border border-[var(--color-accent)]/25 bg-[var(--color-accent-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-text)]">
            {stripEmoji(monthlyPrompt)}
          </p>
        ) : null}

        <div className="grid gap-x-5 gap-y-3 @[640px]:grid-cols-2">
          <div className="min-w-0">
            {hasActive ? (
              <>
                <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Active now</h3>
                <ul className="mt-1.5 space-y-2">
                  {activeProjects.map((project) => (
                    <li key={project.id} className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                        {stripEmoji(project.title)}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                        {project.outcome
                          ? stripEmoji(project.outcome)
                          : `Project / ${project.status ?? 'active'}`}
                      </p>
                    </li>
                  ))}
                  {activeIntents.map((intent) => (
                    <li key={intent.id} className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text)]">
                        {stripEmoji(intent.text)}
                      </span>
                      {intent.status ? (
                        <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
                          {intent.status.replace(/_/g, ' ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-[12px] text-[var(--color-text-faint)]">
                No active intents or projects declared for today.
              </p>
            )}
          </div>

          {askBeforeCentering.length ? (
            <div className="min-w-0">
              <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Worth a check?</h3>
              <ul className="mt-1.5 space-y-2">
                {askBeforeCentering.map((area) => (
                  <li key={area.areaId} className="flex min-w-0 gap-2">
                    <AreaReportMark src={area.imageUrl ?? area.faviconUrl ?? null} />
                    <div className="min-w-0">
                      <p className="text-[12.5px] leading-5 text-[var(--color-text-muted)]">
                        {stripEmoji(area.prompt)}
                      </p>
                      <p className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-faint)]">
                        {area.name}
                        {typeof area.loudness === 'number' ? ` / loud in your inbox` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {contextItems.length ? (
          <div className="mt-3 border-t border-[var(--color-border)] pt-2.5">
            <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Context carried in</h3>
            <ul className="mt-1.5 grid gap-x-5 gap-y-1.5 @[640px]:grid-cols-2">
              {contextItems.map((item) => (
                <li key={item.id} className="flex min-w-0 gap-2">
                  <AreaReportMark src={item.imageUrl ?? null} />
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] text-[var(--color-text)]">
                      {stripEmoji(item.title)}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-faint)]">
                      {stripEmoji(item.meta)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function taskBriefSurfaceStyle(task: DailyReportTaskItem): CSSProperties | undefined {
  const color = taskSourceColor(task);
  if (!color) return undefined;
  return {
    '--task-border': `color-mix(in oklab, ${color} 34%, var(--color-border))`,
    backgroundColor: `color-mix(in oklab, ${color} 14%, var(--color-bg-elevated))`,
    borderColor: `color-mix(in oklab, ${color} 34%, var(--color-border))`,
  } as CSSProperties;
}

function ReportSection({
  label,
  items,
  limit,
  roomy,
  delay,
  ...handlers
}: {
  label: string;
  items: DailyReportItem[];
  limit: number;
  roomy: boolean;
  delay: number;
} & RowHandlers) {
  if (!items.length) return null;
  const visibleItems = items.slice(0, limit);
  const countLabel =
    visibleItems.length < items.length ? `${visibleItems.length}/${items.length}` : items.length;
  return (
    <section className="blur-in" style={{ animationDelay: `${delay}ms` }}>
      <div className="mb-1.5 flex items-center gap-3">
        <h2 className="font-serif text-[13px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text)]">
          {label}
        </h2>
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{countLabel}</span>
        <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
      </div>
      <div className={cn(roomy ? 'space-y-2.5' : 'space-y-2')}>
        {visibleItems.map((item, index) => (
          <ReportRow
            key={`${label}:${item.account}:${item.threadId}:${item.trackedThreadId || ''}`}
            item={item}
            index={index}
            roomy={roomy && index < 5}
            {...handlers}
          />
        ))}
      </div>
    </section>
  );
}

function ReportRow({
  item,
  index,
  onOpen,
  onResolveThread,
  resolvingThreadKey,
  onHideThread,
  hidingThreadKey,
  onDismissSender,
  onMarkPerson,
  dismissingId,
  markingId,
  roomy,
}: { item: DailyReportItem; index: number; roomy: boolean } & RowHandlers) {
  const person = item.people[0] ? stripEmoji(item.people[0]) : '';
  const subject = stripEmoji(item.subject || '(no subject)');
  const framing = elapsedFraming(item);
  const pills = (item.surfacedBecause || []).filter((code) => PILL_LABELS[code]).slice(0, 4);
  const itemKey = dailyReportItemThreadKey(item);
  const clearing = resolvingThreadKey === itemKey || hidingThreadKey === itemKey;
  const correcting = dismissingId === item.threadId || markingId === item.threadId || clearing;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <button> can't contain the nested action <button>s; role+keydown keep it accessible.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(item);
        }
      }}
      className={cn(
        'group grid cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 text-left shadow-[var(--shadow-soft)]',
        roomy ? 'py-4' : 'py-3',
        'hover:border-[var(--color-border-strong)] hover:bg-[var(--color-hover-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]',
        correcting && 'opacity-50',
      )}
    >
      {/* Col 1 — index numeral, set in the serif for editorial character. */}
      <span className="pt-0.5 text-right font-serif text-[12px] tabular-nums text-[var(--color-text-faint)]">
        {String(index + 1).padStart(2, '0')}
      </span>

      {/* Col 2 — the only flexible column. */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {item.unread ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" aria-hidden />
              <span className="sr-only">Unread</span>
            </>
          ) : null}
          <span className="truncate text-[13px] font-medium leading-tight text-[var(--color-text)]">
            {person ? `${person} · ` : ''}
            {subject}
          </span>
        </div>
        <span
          className={cn(
            'mt-0.5 block text-[12px] text-[var(--color-text-muted)]',
            roomy ? 'line-clamp-3 leading-5' : 'truncate leading-tight',
          )}
        >
          {stripEmoji(item.whyItMatters)}
        </span>
        {roomy && (item.nextAction || item.openLoops?.length) ? (
          <div className="mt-2 space-y-1 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            {item.nextAction ? (
              <div>
                <span className="font-medium text-[var(--color-text)]">{item.nextAction}</span>
                {item.people[0] ? <span> with {stripEmoji(item.people[0])}</span> : null}
              </div>
            ) : null}
            {item.openLoops?.slice(0, 2).map((loop) => (
              <div key={loop} className="line-clamp-2">
                {stripEmoji(loop)}
              </div>
            ))}
          </div>
        ) : null}
        {framing ? (
          <span className="mt-0.5 block text-[11px] font-medium leading-tight text-[var(--color-accent)]">
            {framing}
          </span>
        ) : null}
        {pills.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {pills.map((code) => (
              <span
                key={code}
                className="rounded-sm bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
              >
                {PILL_LABELS[code]}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Col 3 — trailing column: due date + one-tap correction / resolve controls. */}
      <div className="flex shrink-0 items-center gap-1 justify-self-end pt-0.5">
        {item.dueAt ? (
          <time className="hidden text-[11px] tabular-nums text-[var(--color-text-muted)] @[360px]:inline">
            {formatDate(item.dueAt)}
          </time>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Resolve conversation"
              onClick={(event) => {
                event.stopPropagation();
                onResolveThread(item);
              }}
              className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-success)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              {resolvingThreadKey === itemKey ? (
                <Ring className="size-3.5" />
              ) : (
                <CheckCircle2 className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Mark resolved</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Remove from future briefs"
              onClick={(event) => {
                event.stopPropagation();
                onHideThread(item);
              }}
              className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              {hidingThreadKey === itemKey ? <Ring className="size-3.5" /> : <X className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Remove from briefs</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="This is a real person — always Main"
              onClick={(event) => {
                event.stopPropagation();
                onMarkPerson(item);
              }}
              className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-accent)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              {markingId === item.threadId ? <Ring className="size-3.5" /> : <User className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">This is a person</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Not for me — stop surfacing this sender"
              onClick={(event) => {
                event.stopPropagation();
                onDismissSender(item);
              }}
              className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              {dismissingId === item.threadId ? <Ring className="size-3.5" /> : <Ban className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Not for me</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function BulkTail({
  items,
  delay,
  onOpen,
}: {
  items: DailyReportItem[];
  delay: number;
  onOpen: (item: DailyReportItem) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const visibleItems = items.slice(0, BULK_TAIL_DISPLAY_LIMIT);
  return (
    <section className="blur-in" style={{ animationDelay: `${delay}ms` }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-1.5 flex w-full items-center gap-3 text-left"
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            'size-3.5 text-[var(--color-text-faint)] transition-transform',
            !open && '-rotate-90',
          )}
        />
        <h2 className="font-serif text-[13px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          Bulk &amp; automated
        </h2>
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{items.length}</span>
        <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
      </button>
      {open ? (
        <div>
          {visibleItems.map((item, index) => (
            <button
              key={`bulk:${item.account}:${item.threadId}`}
              type="button"
              onClick={() => onOpen(item)}
              className="grid cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md border-b border-[var(--color-border)] px-1.5 py-1.5 text-left last:border-b-0 hover:bg-[var(--color-hover-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            >
              <span className="text-right font-serif text-[11px] tabular-nums text-[var(--color-text-faint)]">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="truncate text-[12px] leading-tight text-[var(--color-text-muted)]">
                {item.people[0] ? `${stripEmoji(item.people[0])} · ` : ''}
                {stripEmoji(item.subject || '(no subject)')}
              </span>
              <span className="shrink-0 justify-self-end text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-faint)]">
                {item.demotionReason || 'Bulk'}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ReportSkeleton() {
  return (
    <div className="h-full overflow-hidden bg-[var(--color-bg)]">
      <div className="relative h-[min(46vh,460px)] min-h-[280px] overflow-hidden bg-[var(--color-bg-subtle)]">
        <div className="absolute inset-0 shimmer" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/10 to-black/25" />
        <div className="absolute left-4 top-6 bottom-6 hidden w-3 rounded-full bg-white/25 @[520px]:block" />
        <div className="absolute right-4 top-6 bottom-6 hidden w-3 rounded-full bg-white/20 @[520px]:block" />
        <div className="absolute inset-0 grid place-items-center px-8 text-center">
          <div className="space-y-3">
            <div className="mx-auto h-14 w-[min(70vw,520px)] rounded-md bg-white/28" />
            <div className="mx-auto h-14 w-[min(58vw,420px)] rounded-md bg-white/22" />
          </div>
        </div>
      </div>
      <div className="mx-auto mt-2 h-3 w-[min(70vw,460px)] rounded shimmer" />
      <div className="mx-auto w-full max-w-5xl px-5 py-10">
        <div className="mb-10 space-y-3">
          <div className="h-8 w-[min(88vw,780px)] rounded shimmer" />
          <div className="h-8 w-[min(76vw,620px)] rounded shimmer" />
        </div>
        <div className="grid gap-8 @[860px]:grid-cols-[minmax(0,1fr)_minmax(18rem,0.48fr)]">
          <section className="min-w-0">
            <div className="mb-4 flex items-center gap-3">
              <div className="h-4 w-28 rounded shimmer" />
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <div className="space-y-4">
              <div className="border-t border-[var(--color-border)] pt-4">
                <div className="mb-2 h-3 w-20 rounded shimmer" />
                <div className="mb-2 h-6 w-3/4 rounded shimmer" />
                <div className="h-4 w-full rounded shimmer" />
              </div>
              <div className="border-t border-[var(--color-border)] pt-4">
                <div className="mb-2 h-3 w-24 rounded shimmer" />
                <div className="mb-2 h-6 w-2/3 rounded shimmer" />
                <div className="h-4 w-5/6 rounded shimmer" />
              </div>
            </div>
          </section>
          <aside className="min-w-0">
            <div className="mb-4 flex items-center gap-3">
              <div className="h-4 w-20 rounded shimmer" />
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <div className="space-y-3">
              <div className="h-12 rounded shimmer" />
              <div className="h-12 rounded shimmer" />
              <div className="h-12 rounded shimmer" />
            </div>
          </aside>
          <section className="min-w-0 @[860px]:col-span-2">
            <div className="mb-4 flex items-center gap-3">
              <div className="h-4 w-32 rounded shimmer" />
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
              <div className="grid gap-3 @[520px]:grid-cols-[8rem_minmax(0,1fr)_4rem]">
                <div className="h-4 rounded shimmer" />
                <div className="h-4 rounded shimmer" />
                <div className="h-4 rounded shimmer" />
              </div>
              <div className="grid gap-3 @[520px]:grid-cols-[8rem_minmax(0,1fr)_4rem]">
                <div className="h-4 rounded shimmer" />
                <div className="h-4 rounded shimmer" />
                <div className="h-4 rounded shimmer" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
