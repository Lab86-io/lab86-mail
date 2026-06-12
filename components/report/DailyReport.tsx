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
import { useState } from 'react';
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

interface DailyReportPayload {
  _id: string;
  kind: 'morning' | 'evening' | 'manual';
  generatedAt: number;
  title: string;
  narrative: string;
  sections: Record<string, DailyReportItem[] | string | undefined>;
  stats: {
    scannedThreads: number;
    trackedThreads: number;
    needsReply: number;
    replyOwed?: number;
    dueSoon: number;
    bulkTailCount?: number;
  };
  model?: string;
  errors?: string[];
  status?: 'partial' | 'ready';
  progress?: { stage: string; done: number; total: number };
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

function asItems(value: DailyReportPayload['sections'][string]): DailyReportItem[] {
  return Array.isArray(value) ? value : [];
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

export function DailyReport() {
  const queryClient = useQueryClient();
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);

  const reportQuery = useQuery({
    queryKey: ['daily-report', 'latest'],
    queryFn: async () => callTool<{ report: DailyReportPayload | null }>('get_latest_daily_report', {}),
    staleTime: 30_000,
    // While an edition is streaming in (status: partial), poll so lanes fill
    // in live instead of the report appearing all at once at the end.
    refetchInterval: (query) => (query.state.data?.report?.status === 'partial' ? 2_000 : false),
  });
  const report = reportQuery.data?.report || null;
  const generating = report?.status === 'partial';

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['daily-report'] });
    queryClient.invalidateQueries({ queryKey: ['tracked-threads'] });
  };

  const generate = useMutation({
    mutationFn: async () =>
      callTool<{ report: DailyReportPayload | null; started?: boolean }>('generate_daily_report', {
        kind: 'manual',
      }),
    onSuccess: invalidate,
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

  const stats = report
    ? [
        [report.stats.scannedThreads, 'Scanned'],
        [report.stats.replyOwed ?? report.stats.needsReply ?? 0, 'Reply owed'],
        [report.stats.trackedThreads, 'Tracked'],
        [report.stats.bulkTailCount ?? 0, 'Bulk'],
      ]
    : [];

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
    <section className="report-paper flex h-full flex-col">
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
          <TextShimmer className="mt-3 text-[12px] text-[var(--color-accent)]">
            {generating && report?.progress
              ? `${report.progress.stage}${report.progress.total ? ` — ${Math.min(report.progress.done, report.progress.total)} of ${report.progress.total} threads` : ''}…`
              : 'Reading your mail, tracked threads, and calendar to write today’s brief…'}
          </TextShimmer>
        ) : null}
      </header>

      <div className="scrollable @container min-h-0 flex-1 px-5 py-5">
        {reportQuery.isLoading ? (
          <ReportSkeleton />
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
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-7">
            {/* Stat strip — serif numerals over tiny labels, hairline-divided when wide. */}
            <dl
              className="blur-in grid grid-cols-2 gap-y-3 divide-[var(--color-border)] @[420px]:grid-cols-4 @[420px]:divide-x"
              style={{ animationDelay: '0ms' }}
            >
              {stats.map(([value, label], i) => (
                <div key={String(label)} className={cn('px-4', i === 0 && '@[420px]:pl-0')}>
                  <dd className="font-serif text-[clamp(20px,5cqi,28px)] leading-none text-[var(--color-text)]">
                    {value}
                  </dd>
                  <dt className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                    {label}
                  </dt>
                </div>
              ))}
            </dl>

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

            {/* Sections. */}
            {SECTION_LABELS.map(([key, label, limit, roomy], i) => (
              <ReportSection
                key={String(key)}
                label={label}
                items={asItems(report.sections[key])}
                limit={limit}
                roomy={roomy}
                delay={180 + i * 60}
                {...rowHandlers}
              />
            ))}

            {/* Bulk & automated tail — collapsed by default, humans never here. */}
            <BulkTail
              items={asItems(report.sections.bulkTail)}
              delay={180 + SECTION_LABELS.length * 60}
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
