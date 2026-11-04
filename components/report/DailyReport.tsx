'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Inbox, Newspaper, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextVortex, type VortexSource } from '@/components/albatross/ContextVortex';
import { ConnectionLogo, GmailLogo, ProviderLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { requestNeedsYouItem } from '@/components/needs-you/data';
import { WorthKnowing } from '@/components/needs-you/WorthKnowing';
import { BriefMailBacklog } from '@/components/report/BriefMailBacklog';
import { BriefNewEditionLine } from '@/components/report/BriefNewEditionLine';
import { BriefSkeleton } from '@/components/report/BriefSkeleton';
import { BriefSourceLine, briefEditionNotes } from '@/components/report/BriefSourceLine';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { useBriefEditionRequest } from '@/components/report/brief-edition-request';
import { useBriefLiveLayer } from '@/components/report/live-layer';
import { PreparedWork } from '@/components/report/PreparedWork';
import { ReadyForYou } from '@/components/report/ReadyForYou';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBriefFrameCspOptions, useFrameNonce } from '@/hooks/use-frame-nonce';
import { useSurfaceReady } from '@/hooks/use-surface-ready';
import { injectBriefArtifactReadyRuntime, isBriefArtifactReadyMessage } from '@/lib/albatross/artifact-ready';
import type { AlbatrossDailyReportContext } from '@/lib/albatross/daily-report';
import { briefFreshness, briefIsStale, briefStaleNote } from '@/lib/albatross/today';
import { callTool } from '@/lib/api-client';
import { hasLiveBriefSection } from '@/lib/brief/editorial';
import {
  BRIEF_LAST_EDITION_FAILED_NOTE,
  BRIEF_RETRY_NOTE,
  isBriefEditionRetrying,
} from '@/lib/brief/generation';
import { BRIEF_LETTER_FAILED_COPY, briefLetterFromReport } from '@/lib/brief/letter';
import {
  BRIEF_LIVE_REFRESH_MS,
  type BriefPendingEdition,
  type BriefViewResponse,
  type BriefWebEdition,
  briefHeadPollInterval,
} from '@/lib/brief/web-view';
import { fetchBriefHead, fetchBriefView } from '@/lib/brief/web-view-client';
import { useClientStore } from '@/lib/client-state';
import {
  artifactFrameHeight,
  confirmDailyReportAction,
  DEFAULT_ARTIFACT_FRAME_HEIGHT,
} from '@/lib/daily-report-action-review';
import { handleDailyReportNavigationAction, openBriefMailThread } from '@/lib/daily-report-navigation';
import { pushDocumentDeepLink } from '@/lib/documents/deep-link';
import { type BriefService, briefServicesFromIds } from '@/lib/mail/brief-services';
import { injectReportAreaBrief } from '@/lib/mail/report-area-brief';
import { type BriefFrameCspOptions, withBriefFrameCsp } from '@/lib/security/brief-frame-csp';
import { withFrameNonce } from '@/lib/security/frame-nonce';
import { stripEmoji } from '@/lib/shared/format';
import { postBriefTheme } from '@/lib/theme/brief-theme';
import { cn } from '@/lib/utils';

// The page reads the slim web view of an edition (lib/brief/web-view.ts).
type DailyReportPayload = BriefWebEdition;

interface ReportSummary {
  _id: string;
  kind: 'morning' | 'evening' | 'manual' | 'weekly';
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
  weekly: 'Weekly Review',
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

// The Albatross section is an object, not the array/string the other sections
// carry, so it needs its own coercion before the brief reads it.
function asAlbatrossContext(value: unknown): AlbatrossDailyReportContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AlbatrossDailyReportContext;
}

function dailyReportThreadKey(account: string, threadId: string): string {
  return JSON.stringify([account, threadId]);
}

// The server merges the source ids of the edition into `services`.
function servicesForReport(report: DailyReportPayload): BriefService[] {
  return briefServicesFromIds(report.services?.length ? report.services : ['mail']);
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
    service.id === 'confluence' ||
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

/* The frame scrolls on its own, so the room for the floating launcher has to
   be inside it. The style goes last in the body, after the edition's own
   styles, so a reset in the edition cannot remove it. */
const REPORT_ARTIFACT_LAUNCHER_CLEARANCE = `<style id="lab86-launcher-clearance">html:root{padding-bottom:88px}</style>`;

export function withReportArtifactRuntime(
  html: string,
  albatrossContext?: AlbatrossDailyReportContext | null,
  options: { launcherClearance?: boolean; frameCsp?: BriefFrameCspOptions } = {},
): string {
  if (!html) return html;
  let next = injectReportAreaBrief(html, albatrossContext ?? null).replace(
    /<script\b(?=[^>]*\bid=(["'])lab86-report-runtime-js\1)[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );
  const bodyClose = next.toLowerCase().lastIndexOf('</body>');
  const tail = options.launcherClearance
    ? `${REPORT_ARTIFACT_LAUNCHER_CLEARANCE}${REPORT_ARTIFACT_RUNTIME_JS}`
    : REPORT_ARTIFACT_RUNTIME_JS;
  next = bodyClose >= 0 ? `${next.slice(0, bodyClose)}${tail}${next.slice(bodyClose)}` : `${next}${tail}`;
  // The edition is model-written: the frame policy stops it from sending
  // brief text to another host (lib/security/brief-frame-csp.ts).
  return withBriefFrameCsp(injectBriefArtifactReadyRuntime(next), options.frameCsp);
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
  // The srcdoc frame inherits the page CSP; its scripts need the page nonce.
  const frameNonce = useFrameNonce();
  const { appOrigin, storageUrl } = useBriefFrameCspOptions();
  // The frame re-renders on each height message; the document passes stay done.
  const srcDoc = useMemo(
    () =>
      withFrameNonce(
        withReportArtifactRuntime(html, albatrossContext, {
          launcherClearance: !autoHeight,
          frameCsp: { appOrigin, storageUrl },
        }),
        frameNonce,
      ),
    [html, albatrossContext, autoHeight, frameNonce, appOrigin, storageUrl],
  );
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
            // Needs you: the page, open at the item that the brief names.
            if (payload.view === 'notifications') {
              if (typeof payload.obligationId === 'string' && payload.obligationId)
                requestNeedsYouItem(payload.obligationId);
              setPrimaryView('notifications');
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
      // A frame that grows to its own height scrolls with the page, and the
      // page leaves the room; a frame that fills the pane leaves it inside.
      srcDoc={srcDoc}
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
        'w-full border-0 bg-[var(--color-content)] transition-opacity duration-300',
        autoHeight ? 'block overflow-hidden' : 'h-full',
        artifactReady ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

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
function ReportGenerating({ pending }: { pending: BriefPendingEdition | null }) {
  const stage = pending?.phase === 'composing' ? 'Designing the layout' : pending?.progress?.stage || null;
  const progressCount = pending?.progress?.total
    ? ` — ${Math.min(pending.progress.done, pending.progress.total)} of ${pending.progress.total}`
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

function openBacklogThread(account: string, threadId: string) {
  openBriefMailThread(account, threadId, useClientStore.getState());
}

const LATEST_EDITION_KEY = ['daily-report', 'latest'];

// The list of past editions costs one full row each to read, so it loads only
// when the reader opens the menu.
function EditionPicker({
  selectedId,
  onSelect,
  report,
  pendingReportId,
  latestLabel,
  triggerClassName,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  report: DailyReportPayload | null;
  pendingReportId: string | null;
  latestLabel: string;
  triggerClassName: string;
}) {
  const [opened, setOpened] = useState(false);
  const historyQuery = useQuery({
    queryKey: ['daily-report', 'history'],
    queryFn: async () =>
      callTool<{ reports: ReportSummary[] }>('list_daily_reports', { limit: 30, summaryOnly: true }),
    staleTime: 30_000,
    enabled: opened,
  });
  // The row of the edition in writing is not an edition to read yet.
  const history = (historyQuery.data?.reports || []).filter((item) => item._id !== pendingReportId);
  // A deep link can select an edition before the list loads.
  const selectedOutsideList = Boolean(
    selectedId && report?._id === selectedId && !history.some((item) => item._id === selectedId),
  );
  return (
    <Select
      value={selectedId ?? 'latest'}
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
      onValueChange={(value) => onSelect(value === 'latest' ? null : value)}
    >
      <SelectTrigger
        size="sm"
        aria-label="Browse past editions"
        title="Browse past editions"
        className={triggerClassName}
      >
        <SelectValue placeholder={latestLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="latest">{latestLabel}</SelectItem>
        {selectedOutsideList && report ? (
          <SelectItem value={report._id}>{editionLabel(report)}</SelectItem>
        ) : null}
        {history.map((item) => (
          <SelectItem key={item._id} value={item._id}>
            {editionLabel(item)}
          </SelectItem>
        ))}
        {historyQuery.isLoading ? (
          <div data-brief-history-loading aria-hidden className="space-y-1.5 px-2 py-1.5">
            <div className="h-3.5 w-36 rounded shimmer" />
            <div className="h-3.5 w-32 rounded shimmer" />
          </div>
        ) : null}
        {historyQuery.isError ? (
          <p role="status" className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
            Past editions did not load.
          </p>
        ) : null}
      </SelectContent>
    </Select>
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
  // The live Today page replaces the stored stories on the current edition only.
  const liveLayer = useBriefLiveLayer();
  const livePage = !selectedId && Boolean(liveLayer?.replacesDocument);

  // A notification or the /brief?id= deep link names one edition. The latest
  // edition still renders as "latest", so the live overlay stays on.
  const requestedReportId = useBriefEditionRequest((s) => s.reportId);
  const clearRequestedReportId = useBriefEditionRequest((s) => s.clear);
  useEffect(() => {
    if (!requestedReportId) return;
    let current = true;
    // Notifications can name an edition newer than the page has. Decide whether
    // it is "latest" only after this request's read finishes. One row is enough.
    void callTool<{ reports: ReportSummary[] }>('list_daily_reports', { limit: 1, summaryOnly: true })
      .then((data) => {
        if (!current) return;
        const shown = queryClient.getQueryData<BriefViewResponse>(LATEST_EDITION_KEY)?.report?._id;
        const latest = requestedReportId === data.reports[0]?._id || requestedReportId === shown;
        setSelectedId(latest ? null : requestedReportId);
        if (latest) void queryClient.invalidateQueries({ queryKey: LATEST_EDITION_KEY });
        clearRequestedReportId();
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [clearRequestedReportId, queryClient, requestedReportId]);

  // The edition and its live facts. The read is heavy, so it runs on mount,
  // after a change, when the head below moves, and at a slow interval. When
  // nothing changed the server sends no edition and the page keeps its copy.
  const reportQuery = useQuery({
    queryKey: ['daily-report', selectedId ?? 'latest'],
    queryFn: async ({ queryKey, signal }): Promise<BriefViewResponse> => {
      const previous = queryClient.getQueryData<BriefViewResponse>(queryKey);
      const next = await fetchBriefView(
        { ...(selectedId ? { id: selectedId } : {}), known: previous?.revision ?? null },
        signal,
      );
      return next.unchanged && previous ? { ...previous, stamp: next.stamp, pending: next.pending } : next;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: !selectedId,
    refetchInterval: selectedId ? false : BRIEF_LIVE_REFRESH_MS,
  });
  const report = reportQuery.data?.report || null;

  // The small poll: which edition the writer works on now. It reads no edition.
  const headQuery = useQuery({
    queryKey: ['daily-report', 'head'],
    queryFn: ({ signal }) => fetchBriefHead(signal),
    staleTime: 5_000,
    retry: false,
    refetchOnWindowFocus: !selectedId,
    refetchInterval: (query) =>
      briefHeadPollInterval({
        selected: Boolean(selectedId),
        pending: Boolean(query.state.data?.pending),
        retrying: Boolean(report?.retrying),
        readable: Boolean(report),
      }),
  });
  const headStamp = headQuery.data?.stamp;
  const viewStamp = reportQuery.data?.stamp;
  const headIsNewer = headQuery.dataUpdatedAt > reportQuery.dataUpdatedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each newer head read re-checks a mismatch, so a read that raced a state change converges.
  useEffect(() => {
    if (selectedId || !headStamp || !viewStamp || headStamp === viewStamp || !headIsNewer) return;
    void queryClient.invalidateQueries(
      { queryKey: LATEST_EDITION_KEY, exact: true },
      { cancelRefetch: false },
    );
  }, [headIsNewer, headQuery.dataUpdatedAt, headStamp, queryClient, selectedId, viewStamp]);
  const pending = selectedId ? null : ((headIsNewer ? headQuery.data : reportQuery.data)?.pending ?? null);

  const artifactSource = report?.artifactSource ?? (report?.html ? 'ai' : null);
  const displayDocument = Boolean(report?.document && report.artifactSource === 'document-v2');
  // Every edition says so when it describes an older day. Embedded in Today,
  // the stamp in the section rule carries it; on its own page the note sits
  // with the source line, in every format.
  const now = Date.now();
  const embeddedFreshness = briefFreshness(report?.generatedAt ?? null, now);
  const stale = briefIsStale(report?.generatedAt ?? null, now);
  const staleNote = embedded ? null : briefStaleNote(report?.generatedAt ?? null, now);
  // The plain letter is the interim save while the full edition composes. If it
  // is still the final artifact, the full edition did not write.
  const composingLetter = artifactSource === 'deterministic' && pending?.reportId === report?._id;
  const letterFailed =
    Boolean(report) && !displayDocument && artifactSource === 'deterministic' && !composingLetter;
  // Editions from before the letter carry a model-authored HTML page.
  const displayArtifact = Boolean(report?.html && artifactSource === 'ai' && !displayDocument);
  const retrying = isBriefEditionRetrying(report);
  // The legacy HTML artifact hides the tasks and threads the reader already
  // put away. The letter hides them through the canvas.
  const taskDismissalsQuery = useQuery({
    queryKey: ['daily-report', 'task-dismissals'],
    queryFn: async () => callTool<{ cardIds: string[] }>('list_daily_report_task_dismissals', {}),
    staleTime: 30_000,
    enabled: displayArtifact,
  });
  const threadDismissalsQuery = useQuery({
    queryKey: ['daily-report', 'thread-dismissals'],
    queryFn: async () =>
      callTool<{ dismissals: DailyReportThreadDismissalRecord[] }>('list_daily_report_thread_dismissals', {}),
    staleTime: 30_000,
    enabled: displayArtifact,
  });
  // The letter from the stored sections, for editions without a document of
  // their own: older editions, the ones whose composition failed, and the plain
  // letter that a new edition shows while it composes.
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
          answer: report.sections.answer,
          today: report.sections.today,
          know: report.sections.know,
          replyOwed: report.sections.replyOwed,
          followUpOwed: report.sections.followUpOwed,
          timeSensitive: report.sections.timeSensitive,
          tracked: report.sections.tracked,
          newPeople: report.sections.newPeople,
          fyi: report.sections.fyi,
          calendar: report.sections.calendar,
          albatross: asAlbatrossContext(report.sections.albatross),
          // Needs you (phase 3): a flag user's lane takes the place of Answer.
          needsYou: report.sections.needsYou,
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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tracked-threads'] });
    return queryClient.invalidateQueries({ queryKey: ['daily-report'] });
  };

  const generate = useMutation({
    mutationFn: async () =>
      callTool<{ report: unknown; started?: boolean }>('generate_daily_report', {
        kind: 'manual',
        wait: false,
      }),
    // Jump to latest. The reader keeps the edition on the page while the new one
    // is written; the mutation stays pending until the page knows about the job.
    onMutate: () => setSelectedId(null),
    onSuccess: () => invalidate(),
  });

  const busy = generate.isPending || Boolean(pending);
  // The vortex is only for a user with nothing to read.
  const showVortex = !report && busy;
  useSurfaceReady('today', reportQuery.isSuccess && !showVortex);
  const showsLetter = displayDocument || Boolean(fallbackLetter);
  const noiseCount = typeof report?.stats?.noise === 'number' ? report.stats.noise : null;
  const showPicker = Boolean(report && (selectedId || !report.first));

  // The new edition takes the place of the old one in the same scroll. A short
  // fade says that the text changed.
  const letterRef = useRef<HTMLDivElement>(null);
  const shownEdition = useRef<string | null>(null);
  const editionKey = report ? `${report._id}:${displayDocument}` : null;
  useEffect(() => {
    const previous = shownEdition.current;
    shownEdition.current = editionKey;
    const node = letterRef.current;
    if (!previous || !editionKey || previous === editionKey || !node?.animate) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    node.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
  }, [editionKey]);

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
              stale ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-faint)]',
            )}
          >
            {!report
              ? 'Not written yet today.'
              : stale
                ? briefStaleNote(report.generatedAt ?? null, now)
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

      {retrying && !busy ? (
        <p
          role="status"
          className={cn('text-[12px] text-[var(--color-text-muted)]', !embedded && 'px-5 pt-3')}
        >
          {BRIEF_RETRY_NOTE}
        </p>
      ) : null}

      {reportQuery.data?.failedNewer && !retrying && !busy && !selectedId ? (
        <p
          role="status"
          className={cn('text-[12px] text-[var(--color-text-muted)]', !embedded && 'px-5 pt-3')}
        >
          {BRIEF_LAST_EDITION_FAILED_NOTE}
        </p>
      ) : null}

      {/* The letter and the legacy artifact carry their own masthead, so the
          app header is hidden for them and the controls move to a floating
          toolbar. */}
      {/* While the first read loads, the skeleton holds the shape of the letter,
          which has no app header. */}
      {!embedded && !displayArtifact && !showsLetter && !(reportQuery.isLoading && !report) ? (
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
              {showPicker ? (
                <EditionPicker
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  report={report}
                  pendingReportId={pending?.reportId ?? null}
                  latestLabel="Latest edition"
                  triggerClassName="max-w-[180px] rounded-md border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                />
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
                {/* Icon when narrow, the word when wide: never an icon before text. */}
                <Inbox className="size-3.5 @[360px]:hidden" />
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
                {busy ? (
                  <Ring className="size-3 @[360px]:hidden" />
                ) : (
                  <RefreshCw className="size-3 @[360px]:hidden" />
                )}
                <span className="hidden @[360px]:inline">{busy ? 'Writing…' : 'Write'}</span>
              </Button>
            </div>
          </div>
          {busy ? (
            <div className="mt-3 space-y-2">
              <p className="text-[12px] text-[var(--color-accent)]">
                {pending?.phase === 'composing'
                  ? 'Writing your brief…'
                  : pending?.progress
                    ? `${pending.progress.stage}${pending.progress.total ? ` — ${Math.min(pending.progress.done, pending.progress.total)} of ${pending.progress.total}` : ''}…`
                    : 'Reading your mail, tasks, and calendar to write today’s brief…'}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{
                    width: `${
                      pending?.progress?.total
                        ? Math.max(6, Math.min(100, (pending.progress.done / pending.progress.total) * 100))
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
        <div className="group absolute right-4 top-4 z-20 flex items-center gap-1 rounded-ui border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-1.5 py-1 opacity-40 shadow-[var(--shadow-soft)] backdrop-blur transition-opacity hover:opacity-100 focus-within:opacity-100">
          {showPicker ? (
            <EditionPicker
              selectedId={selectedId}
              onSelect={setSelectedId}
              report={report}
              pendingReportId={pending?.reportId ?? null}
              latestLabel="Latest"
              triggerClassName="h-7 max-w-[150px] rounded-ui border-0 bg-transparent text-[11px] text-[var(--color-text-muted)] shadow-none hover:text-[var(--color-text)]"
            />
          ) : null}
          <button
            type="button"
            onClick={() => setPrimaryView('mail')}
            aria-label="Open inbox"
            title="Inbox"
            className="grid size-7 place-items-center rounded-ui text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
          >
            <Inbox className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => generate.mutate()}
            aria-label="Write a new brief"
            title="Write a new brief"
            className="grid size-7 place-items-center rounded-ui bg-[var(--color-accent)] text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {busy ? <Ring className="size-3" /> : <RefreshCw className="size-3" />}
          </button>
        </div>
      ) : null}

      <div
        className={cn(
          embedded ? 'block' : 'min-h-0 flex-1',
          displayArtifact || showsLetter || showVortex || (reportQuery.isLoading && !report)
            ? embedded
              ? ''
              : 'overflow-hidden'
            : cn('@container', embedded ? 'py-1' : 'scrollable assistant-launcher-clearance px-5 pt-5'),
        )}
      >
        {reportQuery.isError && !report ? (
          <div role="alert" className="px-6 py-12 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">Your brief couldn’t load. Try again.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void reportQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : reportQuery.isLoading && !report ? (
          <BriefSkeleton masthead={!embedded} />
        ) : showVortex || showsLetter || (displayArtifact && report?.html) ? (
          // The vortex shows only with nothing to read; when the first brief
          // lands, the vortex collapses and the letter springs out of it.
          <AnimatePresence key={showVortex ? 'generating' : 'edition'} mode="wait" initial={false}>
            {showVortex ? (
              <motion.div
                key="vortex"
                className={embedded ? undefined : 'h-full'}
                exit={{ opacity: 0, scale: 1.05 }}
                transition={{ duration: 0.25, ease: 'easeIn' }}
              >
                <ReportGenerating pending={pending} />
              </motion.div>
            ) : report && (displayDocument || fallbackLetter) ? (
              // One canvas across a swap: the plain letter, the full edition, and
              // the next edition all keep the reader's scroll position. A past
              // edition from the menu is a new page.
              <motion.div
                key="letter"
                ref={letterRef}
                className={embedded ? undefined : 'h-full'}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
              >
                <BriefCanvas
                  key={selectedId ?? 'latest'}
                  hideInactive={!selectedId}
                  reportId={report._id}
                  value={displayDocument ? report.document : fallbackLetter}
                  liveSections={!selectedId}
                  composing={displayDocument && report.artifactStatus === 'composing'}
                  onChanged={invalidate}
                  // Today already carries the dateline masthead. A second one
                  // on the same scroll would say the date twice.
                  masthead={!embedded}
                  embedded={embedded}
                  noiseCount={noiseCount}
                  belowMasthead={
                    selectedId || livePage ? null : (
                      <>
                        <BriefSourceLine
                          reportId={report._id}
                          notes={briefEditionNotes(report)}
                          staleNote={staleNote}
                          lead={<BriefNewEditionLine pending={pending} reportId={report._id} />}
                          className="daily-brief-layout"
                        />
                        {/* Live, not part of the edition: a handoff after 7:00 still shows. */}
                        <ReadyForYou className="daily-brief-layout" />
                      </>
                    )
                  }
                  footer={
                    livePage ? (
                      <div className="daily-brief-layout mt-2">
                        <WorthKnowing items={report.worthKnowing} />
                        {/* Live, not part of the edition: a handoff after 7:00 still shows. */}
                        <ReadyForYou className="mt-8" />
                        <PreparedWork />
                        <BriefSourceLine reportId={report._id} className="mt-8" />
                      </div>
                    ) : (
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
                        {!displayDocument && report.errors?.length ? (
                          <p className="mx-auto mt-3 max-w-[620px] text-[11px] text-[var(--color-danger)]">
                            Some sources failed: {report.errors.join('; ')}
                          </p>
                        ) : null}
                        {!selectedId &&
                        !(
                          displayDocument &&
                          report.document &&
                          hasLiveBriefSection(report.document, 'prepared_work')
                        ) ? (
                          <PreparedWork />
                        ) : null}
                        <BriefMailBacklog
                          items={report.sections.overflow || []}
                          total={report.stats?.overflow}
                          onOpen={openBacklogThread}
                        />
                        {embedded ? null : <BriefFooter report={report} />}
                      </>
                    )
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
                className={embedded ? undefined : 'flex h-full flex-col'}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 190, damping: 22, mass: 0.9 }}
              >
                {/* An edition in the older format carries its own cover inside
                    the frame, so the source line and the stale note sit in a
                    strip above it. The strip keeps clear of the floating
                    toolbar: under it on a phone, beside it from sm up. */}
                {selectedId ? null : (
                  <BriefSourceLine
                    reportId={report._id}
                    notes={briefEditionNotes(report)}
                    staleNote={staleNote}
                    lead={<BriefNewEditionLine pending={pending} reportId={report._id} />}
                    className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-content)] px-5 pb-2.5 pt-[3.75rem] sm:pr-64 sm:pt-2.5"
                  />
                )}
                <div className={embedded ? undefined : 'min-h-0 flex-1'}>
                  <ReportArtifact
                    html={report.html}
                    albatrossContext={asAlbatrossContext(report.sections.albatross)}
                    dismissedTaskIds={dismissedTaskIds}
                    dismissedThreadRecords={dismissedThreadRecords}
                    onChanged={invalidate}
                    autoHeight={embedded}
                  />
                </div>
              </motion.div>
            ) : (
              <ReportGenerating pending={pending} />
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
            {/* With no edition, the source line still says when a source is broken. */}
            <BriefSourceLine className="mt-3 max-w-md" />
          </Empty>
        )}
      </div>
    </section>
  );
}
