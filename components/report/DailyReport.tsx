'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  Newspaper,
  RefreshCw,
  User,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Ring } from '@/components/loading-ui/ring';
import { TextShimmer } from '@/components/loading-ui/text-shimmer';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { formatDate, stripEmoji } from '@/lib/shared/format';
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

interface DailyReportPayload {
  _id: string;
  kind: 'morning' | 'evening' | 'manual';
  generatedAt: number;
  title: string;
  narrative: string;
  sections: Record<
    string,
    DailyReportItem[] | DailyReportTaskItem[] | DailyReportCalendarItem[] | string | undefined
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
  status?: 'partial' | 'ready';
  progress?: { stage: string; done: number; total: number };
  // Agent-authored self-contained HTML artifact (served in a sandboxed iframe).
  html?: string;
  artifactStatus?: 'composing' | 'enriching' | 'rendered';
}

interface ReportSummary {
  _id: string;
  kind: 'morning' | 'evening' | 'manual';
  generatedAt: number;
  title?: string;
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

// Gmail-Nudge-style framing: "Received 4 days ago — reply?".
function elapsedFraming(item: DailyReportItem): string {
  if (!item.receivedAt) return '';
  const days = Math.floor((Date.now() - item.receivedAt) / 86_400_000);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  if (item.lane === 'reply_owed') return `Received ${when} — reply?`;
  if (item.lane === 'follow_up_owed') return `You wrote ${when === 'today' ? 'today' : when} — nudge?`;
  return '';
}

// Renders the agent-authored HTML artifact in a sandboxed iframe and bridges
// its interactions back to the app. The artifact runs WITHOUT same-origin
// access (it cannot read cookies, storage, or the Convex client) — every
// mutation flows through this allowlisted postMessage handler, which validates
// the message source and the action before touching app state.
const FONT_FAMILIES: Record<string, string> = {
  sans: "'Geist', system-ui, sans-serif",
  grotesk: "'Hanken Grotesk', system-ui, sans-serif",
  serif: "'Fraunces', Georgia, serif",
  instrument: "'Instrument Serif', Georgia, serif",
  news: "'Averia Serif Libre', Georgia, serif",
};

function ReportArtifact({ html, onChanged }: { html: string; onChanged?: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  // The brief is theme-agnostic HTML (CSS vars with fallbacks); the host injects
  // the user's actual theme so it matches the app and restyles live on change.
  // Subscribing to these slices re-runs the effect whenever customization moves.
  const appFont = useClientStore((s) => s.appFont);
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const bgHue = useClientStore((s) => s.bgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);

  // Mirror the app's resolved CSS variables (already reflect the live accent,
  // background, and light/dark) into the brief's --brief-* tokens. Posted on
  // iframe load and again whenever any customization slice changes.
  const postTheme = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const theme: Record<string, string> = {
      '--brief-bg': v('--color-bg') || '#faf9f6',
      '--brief-ink': v('--color-text') || '#1a1a1a',
      '--brief-muted': v('--color-text-muted') || '#6b6b6b',
      '--brief-hairline': v('--color-border') || '#e6e3dc',
      '--brief-accent': v('--color-accent') || '#c2683c',
      '--brief-accent-soft': v('--color-accent-soft') || 'rgba(194,104,60,0.14)',
      // Two fonts, like the rest of the app: the picked face drives the display
      // layer (headings/masthead); body copy stays sans.
      '--brief-font-display': FONT_FAMILIES[appFont ?? 'serif'] ?? FONT_FAMILIES.serif,
      '--brief-font-body': FONT_FAMILIES.sans,
    };
    win.postMessage({ source: 'lab86-host', type: 'theme', theme }, '*');
  }, [appFont]);

  // Re-post on any customization change. The accent/background slices aren't
  // referenced directly (their resolved colors are read from computed CSS), but
  // they must still re-trigger the post, so they belong in the dependency list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme slices intentionally trigger a re-post; resolved values come from computed CSS.
  useEffect(() => {
    postTheme();
  }, [postTheme, accentHue, accentChroma, bgHue, surfaceTint, html]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data = event.data as { source?: string; action?: string; payload?: any } | null;
      if (!data || data.source !== 'lab86-daily-report') return;
      // Only trust messages from our own iframe document.
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
      const payload = data.payload || {};
      const ack = (ok: boolean, error?: string) =>
        frameRef.current?.contentWindow?.postMessage(
          { source: 'lab86-host', action: data.action, ok, error },
          '*',
        );
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
            if (['mail', 'tasks', 'calendar'].includes(payload.view)) {
              setPrimaryView(payload.view);
              return ack(true);
            }
            return ack(false, 'unknown view');
          case 'toggle_task':
            if (!payload.cardId) return ack(false, 'missing cardId');
            await callTool('tasks_update_card', {
              cardId: String(payload.cardId),
              completed: Boolean(payload.completed),
            });
            onChanged?.();
            return ack(true);
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
          default:
            return ack(false, 'unknown action');
        }
      } catch (err: any) {
        ack(false, err?.message || 'action failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [setSelectedThread, setThreadAccount, setPrimaryView, setPendingReplyBody, onChanged]);

  return (
    <iframe
      ref={frameRef}
      title="The Daily Brief"
      srcDoc={html}
      onLoad={postTheme}
      // allow-scripts (for interactivity) WITHOUT allow-same-origin keeps the
      // artifact sandboxed from the app origin; allow-popups lets external
      // links open in a new tab.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      className="h-full w-full border-0 bg-[var(--color-bg)]"
    />
  );
}

const GENERATING_PHRASES = [
  'Reading the last week of mail…',
  'Sorting who actually needs a reply…',
  'Folding in your tasks and calendar…',
  "Choosing today's painting…",
  'Composing the narrative…',
  'Laying out the charts and to-dos…',
];

// The "we're working on it" state: a shimmering masthead, a typewriter cycling
// reassuring lines (token-by-token feel), and a stage-aware progress bar driven
// by the report's live progress when available.
function ReportGenerating({ report }: { report: DailyReportPayload | null }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const phrase = GENERATING_PHRASES[phraseIdx % GENERATING_PHRASES.length];
    if (typed.length < phrase.length) {
      const t = setTimeout(() => setTyped(phrase.slice(0, typed.length + 1)), 34);
      return () => clearTimeout(t);
    }
    const hold = setTimeout(() => {
      setTyped('');
      setPhraseIdx((i) => (i + 1) % GENERATING_PHRASES.length);
    }, 1300);
    return () => clearTimeout(hold);
  }, [typed, phraseIdx]);

  const stage =
    report?.artifactStatus === 'composing'
      ? 'Designing the layout'
      : report?.progress?.stage || 'Gathering the last week';
  const pct = report?.progress?.total
    ? Math.max(8, Math.min(100, (report.progress.done / report.progress.total) * 100))
    : null;

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-md text-center">
        <div className="relative mx-auto mb-6 h-40 w-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[var(--color-accent-soft)] via-transparent to-[var(--color-accent-soft)]" />
          <div className="absolute inset-0 grid place-items-center">
            <Newspaper className="size-8 text-[var(--color-text-faint)]" />
          </div>
        </div>
        <h1 className="font-serif text-[26px] font-semibold italic leading-none text-[var(--color-text)]">
          The Daily Brief
        </h1>
        <p className="mt-3 min-h-[1.5em] font-serif text-[15px] italic text-[var(--color-accent)]">
          {typed}
          <span className="ml-0.5 inline-block animate-pulse">▍</span>
        </p>
        <div className="mt-5">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
            {pct != null ? (
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--color-accent)]" />
            )}
          </div>
          <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
            {stripEmoji(stage)}
            {report?.progress?.total
              ? ` · ${Math.min(report.progress.done, report.progress.total)}/${report.progress.total}`
              : ''}
          </p>
        </div>
      </div>
    </div>
  );
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
      if (r?.status === 'partial' || r?.artifactStatus === 'composing') return 2_000;
      // The month pass enriches an already-shown edition in the background.
      if (r?.artifactStatus === 'enriching') return 3_000;
      if (generatingSince && (!r || (r.generatedAt || 0) < generatingSince)) return 1_500;
      return false;
    },
  });
  const report = reportQuery.data?.report || null;
  // True between clicking Generate and the new edition actually appearing.
  const waitingForNew = Boolean(generatingSince && (!report || (report.generatedAt || 0) < generatingSince));
  const generating = report?.status === 'partial' || report?.artifactStatus === 'composing' || waitingForNew;
  // The artifact is already shown; the broader month pass is filling in behind it.
  const enriching = report?.artifactStatus === 'enriching';

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
      }),
    // Mark the moment so polling waits for the NEW edition, and jump to latest.
    onMutate: () => {
      setSelectedId(null);
      setGeneratingSince(Date.now());
    },
    onSuccess: invalidate,
    onError: () => setGeneratingSince(null),
  });

  const resolveTracked = useMutation({
    mutationFn: async (id: string) => callTool('resolve_tracked_thread', { id }),
    onSuccess: invalidate,
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

  const openThread = (item: DailyReportItem) => {
    setThreadAccount(item.account);
    setSelectedThread(item.threadId);
  };

  const rowHandlers = {
    onOpen: openThread,
    onResolve: (id: string) => resolveTracked.mutate(id),
    resolvingId: resolveTracked.variables as string | undefined,
    onDismiss: (item: DailyReportItem) => dismissSender.mutate(item),
    onMarkPerson: (item: DailyReportItem) => markPerson.mutate(item),
    dismissingId: dismissSender.isPending ? dismissSender.variables?.threadId : undefined,
    markingId: markPerson.isPending ? markPerson.variables?.threadId : undefined,
  };

  return (
    <section className="report-paper relative flex h-full flex-col">
      {/* The agent-authored brief carries its own art masthead, so the app
          header is hidden for it and the controls move to a floating toolbar. */}
      {!report?.html ? (
        <header className="@container border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h1 className="font-serif text-[clamp(22px,6cqi,30px)] font-semibold italic leading-none tracking-tight text-[var(--color-text)]">
                The Daily Brief
              </h1>
              <p className="mt-2 font-serif text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                {report ? formatDateline(report) : 'From your mail & calendar'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {history.length > 1 ? (
                <select
                  value={selectedId ?? ''}
                  onChange={(event) => setSelectedId(event.target.value || null)}
                  aria-label="Browse past editions"
                  title="Browse past editions"
                  className="h-8 max-w-[170px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  <option value="">Latest edition</option>
                  {history.map((item) => (
                    <option key={item._id} value={item._id}>
                      {editionLabel(item)}
                    </option>
                  ))}
                </select>
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
                disabled={generate.isPending || generating}
                onClick={() => generate.mutate()}
                aria-label="Generate a fresh report"
                title="Generate"
              >
                {generate.isPending || generating ? (
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
              <TextShimmer className="text-[12px] text-[var(--color-accent)]">
                {report?.artifactStatus === 'composing'
                  ? 'Designing your brief — laying out the narrative, charts, and to-dos…'
                  : generating && report?.progress
                    ? `${report.progress.stage}${report.progress.total ? ` — ${Math.min(report.progress.done, report.progress.total)} of ${report.progress.total}` : ''}…`
                    : 'Reading your mail, tasks, and calendar to write today’s brief…'}
              </TextShimmer>
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
      {report?.html ? (
        <div className="group absolute right-4 top-4 z-20 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]/70 px-1.5 py-1 opacity-40 shadow-[var(--shadow-soft)] backdrop-blur transition-opacity hover:opacity-100 focus-within:opacity-100">
          {enriching ? (
            <span className="flex items-center gap-1 pl-1.5 pr-1 text-[10px] text-[var(--color-text-muted)]">
              <Ring className="size-2.5" />
              <span className="hidden @[420px]:inline">Adding the past month…</span>
            </span>
          ) : null}
          {history.length > 1 ? (
            <select
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(event.target.value || null)}
              aria-label="Browse past editions"
              title="Browse past editions"
              className="h-7 max-w-[140px] rounded-full bg-transparent px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <option value="">Latest</option>
              {history.map((item) => (
                <option key={item._id} value={item._id}>
                  {editionLabel(item)}
                </option>
              ))}
            </select>
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
          report?.html || (generating && (!report?.html || waitingForNew))
            ? 'overflow-hidden'
            : 'scrollable @container px-5 py-5',
        )}
      >
        {reportQuery.isLoading && !report ? (
          <ReportSkeleton />
        ) : generating && (!report?.html || waitingForNew) ? (
          <ReportGenerating report={report} />
        ) : !report ? (
          <Empty className="grid h-full place-items-center px-6 py-12 text-center">
            <EmptyHeader>
              <EmptyMedia>
                <Newspaper className="h-4 w-4 text-[var(--color-text-faint)]" />
              </EmptyMedia>
              <EmptyTitle className="font-serif text-[18px] italic">No edition yet</EmptyTitle>
              <EmptyDescription>
                Press Generate to print today&apos;s brief. Scheduled morning and evening runs will file here
                once installed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : report.html ? (
          <ReportArtifact html={report.html} onChanged={invalidate} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-7">
            {/* Lede — the narrative as an editorial pull-quote. */}
            {report.narrative ? (
              <blockquote
                className="blur-in border-l-2 border-[var(--color-accent)] pl-4 font-serif text-[clamp(15px,3.6cqi,19px)] italic leading-[1.55] text-[var(--color-text)]"
                style={{ animationDelay: '60ms' }}
              >
                {stripEmoji(report.narrative)}
              </blockquote>
            ) : null}

            {/* Front-page lanes. */}
            <div
              className="blur-in grid grid-cols-1 gap-3 @[480px]:grid-cols-3"
              style={{ animationDelay: '120ms' }}
            >
              {summaryKeys.map(([key, label]) => {
                const items = asItems(report.sections[key]);
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
              tasks={asTasks(report.sections.tasks)}
              events={asEvents(report.sections.calendar)}
              delay={170}
              onOpenTasks={() => setPrimaryView('tasks')}
              onOpenCalendar={() => setPrimaryView('calendar')}
            />

            {/* Sections. */}
            {SECTION_LABELS.map(([key, label, limit, roomy], i) => (
              <ReportSection
                key={String(key)}
                label={label}
                items={asItems(report.sections[key])}
                limit={limit}
                roomy={roomy}
                delay={240 + i * 60}
                {...rowHandlers}
              />
            ))}

            {/* Bulk & automated tail — collapsed by default, humans never here. */}
            <BulkTail
              items={asItems(report.sections.bulkTail)}
              delay={240 + SECTION_LABELS.length * 60}
              onOpen={openThread}
            />

            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-4 pb-6 text-[11px] text-[var(--color-text-faint)]">
              <span>Filed {new Date(report.generatedAt).toLocaleString()}</span>
              {report.model ? <span>· Composed by {report.model}</span> : null}
              {typeof report.sections.noiseSummary === 'string' ? (
                <span className="basis-full text-[var(--color-text-muted)]">
                  {stripEmoji(report.sections.noiseSummary)}
                </span>
              ) : null}
              {report.errors?.length ? (
                <span className="basis-full text-[var(--color-danger)]">
                  Some sources failed: {report.errors.join('; ')}
                </span>
              ) : null}
            </footer>
          </div>
        )}
      </div>
    </section>
  );
}

interface RowHandlers {
  onOpen: (item: DailyReportItem) => void;
  onResolve: (id: string) => void;
  resolvingId?: string;
  onDismiss: (item: DailyReportItem) => void;
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
}: {
  tasks: DailyReportTaskItem[];
  events: DailyReportCalendarItem[];
  delay: number;
  onOpenTasks: () => void;
  onOpenCalendar: () => void;
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
              <li key={task.cardId} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2">
                <span
                  className={cn(
                    'mt-1 grid size-3.5 place-items-center rounded-sm border',
                    task.completedAt
                      ? 'border-[var(--color-success)] bg-[var(--color-success)]'
                      : 'border-[var(--color-border-strong)]',
                  )}
                  aria-hidden
                />
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
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-[var(--color-text-faint)]">
            No active task context in the last month.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3.5 shadow-[var(--shadow-soft)]">
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
            <table className="w-full table-fixed border-collapse text-left">
              <tbody>
                {visibleEvents.map((event) => (
                  <tr
                    key={`${event.account}:${event.eventId}:${event.startAt}`}
                    className="border-b border-[var(--color-border)] last:border-b-0"
                  >
                    <td className="w-24 px-2.5 py-2 align-top text-[10.5px] font-medium tabular-nums text-[var(--color-text-faint)]">
                      {formatEventWindow(event)}
                    </td>
                    <td className="px-2.5 py-2 align-top">
                      {safeExternalHref(event.htmlLink) ? (
                        <a
                          href={safeExternalHref(event.htmlLink) as string}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="line-clamp-1 text-[12.5px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                        >
                          {stripEmoji(event.title)}
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={onOpenCalendar}
                          className="line-clamp-1 text-left text-[12.5px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                        >
                          {stripEmoji(event.title)}
                        </button>
                      )}
                      {event.location ? (
                        <p className="mt-0.5 line-clamp-1 text-[10.5px] text-[var(--color-text-faint)]">
                          {stripEmoji(event.location)}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[12px] text-[var(--color-text-faint)]">No calendar context in the last month.</p>
        )}
      </div>
    </section>
  );
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
  onResolve,
  resolvingId,
  onDismiss,
  onMarkPerson,
  dismissingId,
  markingId,
  roomy,
}: { item: DailyReportItem; index: number; roomy: boolean } & RowHandlers) {
  const person = item.people[0] ? stripEmoji(item.people[0]) : '';
  const subject = stripEmoji(item.subject || '(no subject)');
  const framing = elapsedFraming(item);
  const pills = (item.surfacedBecause || []).filter((code) => PILL_LABELS[code]).slice(0, 4);
  const correcting = dismissingId === item.threadId || markingId === item.threadId;
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
                onDismiss(item);
              }}
              className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              {dismissingId === item.threadId ? <Ring className="size-3.5" /> : <Ban className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Not for me</TooltipContent>
        </Tooltip>
        {item.trackedThreadId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Resolve tracked thread"
                onClick={(event) => {
                  event.stopPropagation();
                  onResolve(item.trackedThreadId as string);
                }}
                className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-success)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                {resolvingId === item.trackedThreadId ? (
                  <Ring className="size-3.5" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Resolve</TooltipContent>
          </Tooltip>
        ) : (
          <span className="grid size-7 place-items-center" aria-hidden>
            <ChevronRight className="size-3.5 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100" />
          </span>
        )}
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
    <div className="mx-auto flex max-w-3xl flex-col gap-7">
      <div className="grid grid-cols-2 gap-3 @[420px]:grid-cols-4">
        <div className="h-12 rounded-md shimmer" />
        <div className="h-12 rounded-md shimmer" />
        <div className="h-12 rounded-md shimmer" />
        <div className="h-12 rounded-md shimmer" />
      </div>
      <div className="h-16 rounded-md shimmer" />
      <div className="grid grid-cols-1 gap-3 @[480px]:grid-cols-3">
        <div className="h-24 rounded-lg shimmer" />
        <div className="h-24 rounded-lg shimmer" />
        <div className="h-24 rounded-lg shimmer" />
      </div>
      <div className="space-y-2">
        <div className="h-4 w-32 rounded shimmer" />
        <div className="h-10 rounded-md shimmer" />
        <div className="h-10 rounded-md shimmer" />
      </div>
    </div>
  );
}
