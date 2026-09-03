'use client';

import { useQuery as useReactQuery } from '@tanstack/react-query';
import { useConvexAuth, useQuery } from 'convex/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { BriefMasthead } from '@/components/report/brief-canvas/BriefMasthead';
import { DayRibbon } from '@/components/report/DayRibbon';
import { api } from '@/convex/_generated/api';
import {
  CAPACITY_LABEL,
  type Capacity,
  dayShapeLine,
  dayWindow,
  fixedSchedule,
  importantMailToday,
  needsYouToday,
  openWork,
  type TodayApproval,
  type TodayEvent,
  type TodayWork,
} from '@/lib/albatross/today';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

interface ExecutionMove {
  workId: string;
  workTitle: string;
  stepKey: string | null;
  stepTitle: string;
  detail: string | null;
  phase: 'active' | 'upcoming' | 'unscheduled' | 'missed';
  scheduledStartAt: number | null;
  scheduledEndAt: number | null;
  remainingSteps: number;
  totalSteps: number;
  areaName: string | null;
}

interface ExecutionSnapshot {
  currentMove: ExecutionMove | null;
  needsYou: TodayWork[];
}

export const TODAY_EMPTY_LINE = 'Nothing is scheduled. The day is yours.';
export const IMPORTANT_MAIL_MAX = 4;

/** The one line under "Do this next": where the move sits in the day. */
export function nextMoveWhen(move: Pick<ExecutionMove, 'phase' | 'scheduledStartAt'>): string | null {
  if (move.phase === 'active') return 'Now';
  if (move.phase === 'upcoming' && move.scheduledStartAt) {
    return new Intl.DateTimeFormat([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
      move.scheduledStartAt,
    );
  }
  return null;
}

/**
 * Today. The day, the important mail, and at most one next move.
 *
 * The page reads in one scroll: the plate, the capacity line, then a
 * two-column layer with the next move and the mail on the left and the day
 * drawn to scale on the right. The brief follows underneath. Nothing here
 * stacks Work above the calendar. Work lives on its own page.
 */
export function TodaySurface({ brief }: { brief?: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  // Selecting work only sets client state; the shell renders the detail on the
  // Albatrosses view. Without the second call a Today row looks dead.
  const openAlbatross = (workId: string) => {
    setSelectedWorkId(workId);
    setPrimaryView('albatrosses');
  };
  const capacity = useClientStore((s) => s.capacity);
  const setCapacity = useClientStore((s) => s.setCapacity);
  // One timestamp for the whole render, so the window and the dateline agree.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const window = useMemo(() => dayWindow(nowMs), [nowMs]);

  const work = useQuery(api.albatrossWorkV2.allWork, isAuthenticated ? {} : 'skip') as
    | TodayWork[]
    | undefined;
  const execution = useQuery(api.albatrossWorkV2.executionSnapshot, isAuthenticated ? { nowMs } : 'skip') as
    | ExecutionSnapshot
    | undefined;
  const events = useQuery(
    api.calendarData.dayEvents,
    isAuthenticated ? { startAt: window.startAt, endAt: window.endAt } : 'skip',
  ) as TodayEvent[] | undefined;
  const approvals = useQuery(api.albatrossWork.listApprovals, isAuthenticated ? { limit: 20 } : 'skip') as
    | TodayApproval[]
    | undefined;

  const rows = work || [];
  // Calendar holds expire while Today may remain open on a second monitor.
  // Refresh the clock on a bounded cadence so the current move stays honest
  // without a reload.
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const attention = needsYouToday(rows, approvals || [], nowMs);
  const schedule = fixedSchedule(events || []);
  const [dayChangedOpen, setDayChangedOpen] = useState(false);
  const loading = work === undefined || execution === undefined;
  const markSeen = useClientStore((s) => s.markSeen);
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  // Important mail rides on the brief's own attention index. The same source
  // decides what the brief leads with. Today does not build a second one.
  const latestBrief = useReactQuery({
    queryKey: ['daily-report', 'today-mail'],
    queryFn: async () =>
      callTool<{ report?: { sections?: Record<string, unknown> } | null }>('get_latest_daily_report'),
    staleTime: 120_000,
    retry: false,
  });
  const mail = importantMailToday(
    ((latestBrief.data?.report?.sections?.needsReply as any[]) || []).map((item: any) => ({
      id: String(item.id ?? item.threadId ?? item.subject),
      subject: String(item.subject || 'Untitled'),
      from: String(item.from || item.fromName || ''),
      reason: item.reason ?? item.why ?? null,
    })),
  ).slice(0, IMPORTANT_MAIL_MAX);

  const shape = dayShapeLine({
    needsYouCount: (execution?.needsYou || []).length + attention.approvals.length,
    eventCount: schedule.length,
    capacity,
    carryingCount: openWork(rows, nowMs).length,
  });

  const move = execution?.currentMove ?? null;
  const when = move ? nextMoveWhen(move) : null;
  const leftEmpty = !loading && !move && !mail.length;

  return (
    <section className="report-paper flex h-full min-h-0 flex-col">
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {/* The plate. It carries the day's art, its dateline and its edition
          title, and it derives all three from today rather than from the brief,
          so it is right on a morning when nothing has been written yet. */}
        <BriefMasthead generatedAt={nowMs} bleed={false} />

        <header className="border-b border-[var(--color-border)] px-5 pb-4">
          <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <p className="max-w-xl text-[13px] leading-relaxed text-[var(--color-text-muted)]">{shape}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* The user states their own capacity. Albatross does not
                diagnose anybody's day for them. */}
              <button
                type="button"
                aria-expanded={dayChangedOpen}
                onClick={() => setDayChangedOpen((value) => !value)}
                className={cn(
                  'mr-2 rounded-lg border border-dashed px-3 py-1 text-[12px] transition-colors',
                  dayChangedOpen
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]',
                )}
              >
                My day changed
              </button>
              <span aria-hidden className="mr-1 h-4 w-px bg-[var(--color-border)]" />
              {(['low', 'normal', 'high'] as Capacity[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={capacity === option}
                  onClick={() => setCapacity(option)}
                  className={cn(
                    'rounded-full px-3 py-1 text-[12px] transition-colors',
                    capacity === option
                      ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                      : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
                  )}
                >
                  {CAPACITY_LABEL[option]}
                </button>
              ))}
            </div>
          </div>
          {dayChangedOpen ? (
            <div className="mx-auto mt-3 max-w-5xl rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
              <p className="text-[13px] font-medium">What changed?</p>
              <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                Today's plan was a guess. Tell Albatross how the day looks now and it will use less of it.
                Nothing is lost either way.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {(
                  [
                    ['I have less time than I thought', 'low'],
                    ['I have more room than I thought', 'high'],
                    ['It is about what I expected', 'normal'],
                  ] as Array<[string, Capacity]>
                ).map(([label, next]) => (
                  <button
                    key={next}
                    type="button"
                    onClick={() => {
                      setCapacity(next);
                      setDayChangedOpen(false);
                    }}
                    className="rounded-full border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </header>

        <div className="px-5 pb-16 pt-6">
          <div className="mx-auto grid max-w-5xl gap-8 @container lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              {loading ? (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading today’s move…</p>
              ) : null}

              {move ? (
                <Section
                  title="Do this next"
                  note={when ? `Protected for ${when}.` : 'The clearest concrete move.'}
                >
                  {/* One line. The step in serif, the Work it belongs to after it. */}
                  <button
                    type="button"
                    onClick={() => openAlbatross(move.workId)}
                    className="flex w-full items-baseline gap-3 rounded-xl border border-[var(--color-accent)]/35 bg-[var(--color-bg-elevated)] px-4 py-3 text-left shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-bg-subtle)]"
                  >
                    <span className="min-w-0 flex-1 truncate font-serif text-[17px] font-semibold leading-snug">
                      {move.stepTitle}
                    </span>
                    <span className="shrink-0 truncate text-[12px] text-[var(--color-text-muted)]">
                      {move.workTitle}
                    </span>
                  </button>
                </Section>
              ) : null}

              {mail.length ? (
                <Section title="Important mail" note="Only what bears on today.">
                  <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                    {mail.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => setPrimaryView('mail')}
                          className="w-full px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                        >
                          <span className="block truncate text-[13.5px] font-medium">{item.subject}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-[var(--color-text-muted)]">
                            {item.reason || item.from}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {leftEmpty ? (
                <p className="text-[13px] text-[var(--color-text-muted)]">{TODAY_EMPTY_LINE}</p>
              ) : null}
            </div>

            <div className="min-w-0">
              <Section title="Your day" note="Solid is booked. Dashed is open air.">
                {schedule.length ? (
                  <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-3">
                    <DayRibbon events={schedule} nowMs={nowMs} />
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-[13px] text-[var(--color-text-muted)]">
                    Nothing is booked today. The whole day is open air.
                  </p>
                )}
              </Section>
            </div>
          </div>

          {/* The synthesis layer. It gets the full measure, because it is the
            longer read and not a footnote to the columns above it. */}
          {brief ? <div className="mx-auto mt-12 max-w-5xl">{brief}</div> : null}
        </div>
      </div>
    </section>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="mb-8">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h2 className="font-serif text-[15px] font-semibold">{title}</h2>
        <p className="text-[12px] text-[var(--color-text-faint)]">{note}</p>
      </div>
      {children}
    </div>
  );
}
