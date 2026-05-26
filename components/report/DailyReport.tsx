'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, CheckCircle2, Inbox, RefreshCw, Sparkles, Target } from 'lucide-react';
import { Ring } from '@/components/loading-ui/ring';
import { TextShimmer } from '@/components/loading-ui/text-shimmer';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { formatDate } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

interface DailyReportItem {
  account: string;
  threadId: string;
  subject: string;
  people: string[];
  whyItMatters: string;
  nextAction?: string;
  dueAt?: number | null;
  unread: boolean;
  trackedThreadId?: string;
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
    dueSoon: number;
  };
  model?: string;
  errors?: string[];
}

const SECTION_LABELS: Array<[keyof DailyReportPayload['sections'], string]> = [
  ['urgent', 'Urgent'],
  ['needsReply', 'Needs Reply'],
  ['waiting', 'Waiting / Follow-Up'],
  ['dueSoon', 'Due Soon'],
  ['tracked', 'Tracked Conversations'],
  ['notable', 'Notable'],
];

export function DailyReport() {
  const queryClient = useQueryClient();
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);

  const reportQuery = useQuery({
    queryKey: ['daily-report', 'latest'],
    queryFn: async () => callTool<{ report: DailyReportPayload | null }>('get_latest_daily_report', {}),
    staleTime: 30_000,
  });
  const report = reportQuery.data?.report || null;

  const generate = useMutation({
    mutationFn: async () =>
      callTool<{ report: DailyReportPayload }>('generate_daily_report', { kind: 'manual' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['daily-report'] });
      queryClient.invalidateQueries({ queryKey: ['tracked-threads'] });
      queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
    },
  });

  const resolveTracked = useMutation({
    mutationFn: async (id: string) => callTool('resolve_tracked_thread', { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['daily-report'] });
      queryClient.invalidateQueries({ queryKey: ['tracked-threads'] });
      queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
    },
  });

  const openThread = (item: DailyReportItem) => {
    setThreadAccount(item.account);
    setSelectedThread(item.threadId);
  };

  return (
    <section className="flex h-full flex-col bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-[var(--color-accent)]" />
              <h1 className="truncate text-[18px] font-semibold tracking-tight text-[var(--color-text)]">
                Daily Report
              </h1>
            </div>
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
              {report
                ? `${report.title} · ${new Date(report.generatedAt).toLocaleString()}`
                : 'A narrative briefing from your email and calendar context.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPrimaryView('mail')}
              className="h-8 rounded-md border border-[var(--color-border)] px-2.5 text-[12px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
            >
              Inbox
            </button>
            <button
              type="button"
              disabled={generate.isPending}
              onClick={() => generate.mutate()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 text-[12px] text-[var(--color-accent-foreground)] disabled:opacity-60"
            >
              {generate.isPending ? <Ring className="size-3" /> : <RefreshCw className="size-3" />}
              Generate
            </button>
          </div>
        </div>
        {generate.isPending ? (
          <TextShimmer className="mt-3 text-[12px] text-[var(--color-accent)]">
            Building the narrative from mail, tracked threads, and calendar context
          </TextShimmer>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {reportQuery.isLoading ? (
          <ReportSkeleton />
        ) : !report ? (
          <Empty className="grid h-full place-items-center px-6 py-12 text-center">
            <EmptyHeader>
              <EmptyMedia>
                <Sparkles className="h-4 w-4 text-[var(--color-text-faint)]" />
              </EmptyMedia>
              <EmptyTitle>No Daily Report yet</EmptyTitle>
              <EmptyDescription>
                Generate one now. Scheduled morning and evening runs will write reports here once installed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-soft)]">
              <div className="mb-3 flex flex-wrap gap-1.5">
                <Badge variant="secondary">{report.stats.scannedThreads} scanned</Badge>
                <Badge variant="outline">{report.stats.trackedThreads} tracked</Badge>
                <Badge variant="outline">{report.stats.needsReply} need reply</Badge>
                <Badge variant="outline">{report.stats.dueSoon} due soon</Badge>
                {report.model ? <Badge variant="outline">{report.model}</Badge> : null}
              </div>
              <div className="whitespace-pre-line text-[14px] leading-6 text-[var(--color-text)]">
                {report.narrative}
              </div>
            </section>

            {SECTION_LABELS.map(([key, label]) => {
              const items = Array.isArray(report.sections[key]) ? report.sections[key] : [];
              return (
                <ReportSection
                  key={String(key)}
                  label={label}
                  items={items}
                  onOpen={openThread}
                  onResolve={(id) => resolveTracked.mutate(id)}
                  resolvingId={resolveTracked.variables as string | undefined}
                />
              );
            })}

            {typeof report.sections.noiseSummary === 'string' ? (
              <p className="pb-6 text-[12px] text-[var(--color-text-muted)]">
                {report.sections.noiseSummary}
              </p>
            ) : null}
            {report.errors?.length ? (
              <div className="rounded-md border border-[var(--color-border)] p-3 text-[12px] text-[var(--color-text-muted)]">
                Some sources failed: {report.errors.join('; ')}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function ReportSection({
  label,
  items,
  onOpen,
  onResolve,
  resolvingId,
}: {
  label: string;
  items: DailyReportItem[];
  onOpen: (item: DailyReportItem) => void;
  onResolve: (id: string) => void;
  resolvingId?: string;
}) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Target className="size-3.5 text-[var(--color-text-muted)]" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          {label}
        </h2>
      </div>
      <ItemGroup className="gap-2">
        {items.map((item) => (
          <Item
            key={`${label}:${item.account}:${item.threadId}:${item.trackedThreadId || ''}`}
            variant="outline"
            size="sm"
            className={cn(
              'cursor-pointer bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)] hover:bg-[var(--color-bg-subtle)]',
              item.unread && 'border-[var(--color-accent)]',
            )}
            onClick={() => onOpen(item)}
          >
            <ItemMedia variant="icon">
              {item.dueAt ? <AlarmClock className="size-4" /> : <Inbox className="size-4" />}
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="line-clamp-1">
                {item.people[0] ? `${item.people[0]} · ` : ''}
                {item.subject || '(no subject)'}
              </ItemTitle>
              <ItemDescription className="line-clamp-2">{item.whyItMatters}</ItemDescription>
              <div className="mt-1 flex flex-wrap gap-1">
                {item.nextAction ? <Badge variant="secondary">{item.nextAction}</Badge> : null}
                {item.dueAt ? <Badge variant="outline">Due {formatDate(item.dueAt)}</Badge> : null}
                {item.trackedThreadId ? <Badge variant="outline">tracked</Badge> : null}
                {item.unread ? <Badge variant="outline">unread</Badge> : null}
              </div>
            </ItemContent>
            <ItemActions>
              {item.trackedThreadId ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onResolve(item.trackedThreadId as string);
                  }}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] px-2 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
                >
                  {resolvingId === item.trackedThreadId ? (
                    <Ring className="size-3" />
                  ) : (
                    <CheckCircle2 className="size-3" />
                  )}
                  Resolve
                </button>
              ) : null}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}

function ReportSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div className="h-28 rounded-lg shimmer" />
      <div className="h-16 rounded-md shimmer" />
      <div className="h-16 rounded-md shimmer" />
      <div className="h-16 rounded-md shimmer" />
    </div>
  );
}
