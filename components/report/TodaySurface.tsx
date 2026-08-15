'use client';

import { useQuery as useReactQuery } from '@tanstack/react-query';
import { useConvexAuth, useQuery } from 'convex/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DailyCheckin, type DailyCheckinData } from '@/components/albatross/DailyCheckin';
import { LapsePrompt, ReEntry, ReviewBatch } from '@/components/albatross/Forgiveness';
import { AlbatrossRow } from '@/components/albatross/primitives';
import { BriefMasthead } from '@/components/report/brief-canvas/BriefMasthead';
import { DayRibbon } from '@/components/report/DayRibbon';
import { api } from '@/convex/_generated/api';
import { reEntryDaysAway, reviewBatch, shouldOfferReEntry } from '@/lib/albatross/forgiveness';
import {
  CAPACITY_LABEL,
  type Capacity,
  dayShapeLine,
  dayWindow,
  fixedSchedule,
  importantMailToday,
  needsYouToday,
  openWork,
  practiceLine,
  type TodayApproval,
  type TodayEvent,
  type TodayPractice,
  type TodayWork,
  waitingOnSomebody,
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
  missedMoves: ExecutionMove[];
  needsYou: TodayWork[];
}

/** Recovery requires the stable server step key used by the recovery mutation. */
export function keyedMissedMoves<T extends { stepKey: string | null }>(
  moves: T[],
): Array<T & { stepKey: string }> {
  return moves.filter((move): move is T & { stepKey: string } => Boolean(move.stepKey));
}

export function MissedMovesRecoverySection({
  moves,
}: {
  moves: Array<Pick<ExecutionMove, 'workId' | 'stepKey' | 'stepTitle' | 'scheduledStartAt'>>;
}) {
  const keyedMoves = keyedMissedMoves(moves);
  if (!keyedMoves.length) return null;
  return (
    <Section title="The plan slipped" note="Choose what should happen now.">
      <div className="space-y-3">
        {keyedMoves.map((move) => (
          <LapsePrompt
            key={`${move.workId}:${move.stepKey || move.stepTitle}`}
            workId={move.workId}
            stepKey={move.stepKey}
            stepTitle={move.stepTitle}
            plannedAt={move.scheduledStartAt || undefined}
          />
        ))}
      </div>
    </Section>
  );
}

/**
 * Today. What deserves attention today, given the life this person actually
 * has today — not a magazine about it.
 *
 * It reads in layers down one scroll. The live layer comes first: what needs
 * the user and what could move on the left, the day drawn to scale on the
 * right. The brief's synthesis follows underneath, in the same scroll.
 *
 * The live layer is queried on every load, so the top of the page can never be
 * stale. The brief is generated, and says so.
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
  const setCaptureOpen = useClientStore((s) => s.setCaptureOpen);
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
  // Refresh the eligibility clock on a bounded cadence so the authoritative
  // current move and missed-block recovery stay honest without a reload.
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const clientAttention = needsYouToday(rows, approvals || []);
  const attention = {
    work: execution?.needsYou || [],
    approvals: clientAttention.approvals,
  };
  const schedule = fixedSchedule(events || []);
  const [dayChangedOpen, setDayChangedOpen] = useState(false);
  const waiting = waitingOnSomebody(rows);
  const loading = work === undefined || execution === undefined;

  const checkin = useQuery(api.albatrossNotifications.currentCheckin, isAuthenticated ? {} : 'skip') as
    | DailyCheckinData
    | null
    | undefined;
  const [checkinOpen, setCheckinOpen] = useState(false);
  const carryoverCheckin = Boolean(
    checkin && checkin.localDate !== new Intl.DateTimeFormat('en-CA').format(new Date(nowMs)),
  );

  const practices = useQuery(
    api.albatrossRoutines.activePractices,
    isAuthenticated ? { limit: 2 } : 'skip',
  ) as TodayPractice[] | undefined;

  // Important mail rides on the brief's own attention index — the same source
  // that decides what the brief leads with. Today does not build a second one.
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
  );

  // Re-entry and the staleness review both live at the top of Today, above
  // everything else, because they change what the rest of the page means.
  const lastSeenAt = useClientStore((s) => s.lastSeenAt);
  const markSeen = useClientStore((s) => s.markSeen);
  const [reEntryDismissed, setReEntryDismissed] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [awayDays] = useState(() => reEntryDaysAway(lastSeenAt, Date.now()));
  const [showReEntry] = useState(() => shouldOfferReEntry(lastSeenAt, Date.now()));
  useEffect(() => {
    markSeen();
  }, [markSeen]);
  const stale = useMemo(() => reviewBatch(rows, nowMs), [rows, nowMs]);

  const shape = dayShapeLine({
    needsYouCount: attention.work.length + attention.approvals.length,
    eventCount: schedule.length,
    capacity,
    carryingCount: openWork(rows).length,
  });

  return (
    <section className="report-paper flex h-full min-h-0 flex-col">
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {/* The plate. It carries the day's art, its dateline and its edition
          title, and it derives all three from today rather than from the brief
          — so it is right on a morning when nothing has been written yet, and
          there is only ever one of it on the page. It scrolls away with the
          page; a plate this size pinned to the top would eat the day. */}
        <BriefMasthead generatedAt={nowMs} bleed={false} />

        <header className="border-b border-[var(--color-border)] px-5 pb-4">
          <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <p className="max-w-xl text-[13px] leading-relaxed text-[var(--color-text-muted)]">{shape}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* The user states their own capacity. Albatross may later notice a
                pattern, but it does not diagnose anybody's day for them. */}
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
                Today's plan was a guess. Tell Albatross how the day actually looks and it will use less of it
                — nothing is lost either way.
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
              {showReEntry && !reEntryDismissed ? (
                <div className="mb-8">
                  <ReEntry
                    days={awayDays}
                    onShowUrgent={() => {
                      setCapacity('low');
                      setReEntryDismissed(true);
                    }}
                    onReviewOld={() => {
                      setReviewDismissed(false);
                      setReEntryDismissed(true);
                    }}
                    onDismiss={() => setReEntryDismissed(true)}
                  />
                </div>
              ) : null}

              {stale.length && !reviewDismissed ? (
                <div className="mb-8">
                  <ReviewBatch items={stale} />
                </div>
              ) : null}

              {loading ? (
                <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading today’s move…</p>
              ) : null}

              {execution?.currentMove ? (
                <Section
                  title="Do this next"
                  note={
                    execution.currentMove.phase === 'active'
                      ? 'This block is happening now.'
                      : execution.currentMove.phase === 'upcoming' && execution.currentMove.scheduledStartAt
                        ? `Protected for ${new Intl.DateTimeFormat([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(execution.currentMove.scheduledStartAt)}.`
                        : 'The clearest concrete move.'
                  }
                >
                  <button
                    type="button"
                    onClick={() => openAlbatross(execution.currentMove!.workId)}
                    className="w-full rounded-xl border border-[var(--color-accent)]/35 bg-[var(--color-bg-elevated)] px-5 py-5 text-left shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-bg-subtle)]"
                  >
                    <span className="block text-[11.5px] text-[var(--color-text-faint)]">
                      {execution.currentMove.workTitle}
                      {execution.currentMove.areaName ? ` · ${execution.currentMove.areaName}` : ''}
                    </span>
                    <span className="mt-1 block font-serif text-[20px] font-semibold leading-tight">
                      {execution.currentMove.stepTitle}
                    </span>
                    {execution.currentMove.detail ? (
                      <span className="mt-1.5 block max-w-2xl text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                        {execution.currentMove.detail}
                      </span>
                    ) : null}
                    <span className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-border)]/70 pt-3 text-[12px]">
                      <span className="text-[var(--color-text-muted)]">
                        {execution.currentMove.remainingSteps === 1
                          ? 'Last planned step'
                          : `${execution.currentMove.remainingSteps} of ${execution.currentMove.totalSteps} steps remain`}
                      </span>
                      <span className="font-medium text-[var(--color-accent)]">Open guided work</span>
                    </span>
                  </button>
                </Section>
              ) : !loading ? (
                <Section title="Do this next" note="There is no concrete move waiting.">
                  <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                    The current plan is clear. Add something only if it deserves a place in the day.
                  </p>
                </Section>
              ) : null}

              <MissedMovesRecoverySection moves={execution?.missedMoves || []} />

              {attention.work.length || attention.approvals.length ? (
                <Section title="Needs you" note="Albatross cannot move these without you.">
                  <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                    {attention.approvals.map((approval) => (
                      <li key={approval._id}>
                        <button
                          type="button"
                          onClick={() => {
                            if (approval.intentId) openAlbatross(approval.intentId);
                          }}
                          className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block font-serif text-[16px] font-semibold">
                              {approval.title}
                            </span>
                            <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">
                              Waiting for your approval
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                    {attention.work.map((item) => (
                      <li key={item._id}>
                        <AlbatrossRow item={item} onOpen={() => openAlbatross(item._id)} />
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : !loading ? (
                <Section title="Needs you" note="Albatross cannot move these without you.">
                  <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                    Nothing needs you right now.
                  </p>
                </Section>
              ) : null}

              {practices?.length ? (
                <Section title="Ongoing practices" note="Kept over time, not scored week by week.">
                  <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                    {practices.map((practice) => (
                      <li key={practice._id} className="px-4 py-3">
                        <p className="text-[13.5px] font-medium">{practice.title}</p>
                        <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                          {practiceLine(practice, nowMs)}
                          {practice.areaName ? ` · ${practice.areaName}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {checkin ? (
                <Section title="Evening check-in" note="How did the day actually go?">
                  <button
                    type="button"
                    onClick={() => setCheckinOpen(true)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                  >
                    <span className="block text-[13.5px] font-medium">
                      {carryoverCheckin ? 'Yesterday’s check-in is still open' : 'Ready when you are'}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">
                      What moved, what changed, and what tomorrow should protect.
                    </span>
                  </button>
                </Section>
              ) : null}

              {mail.length ? (
                <Section title="Important mail" note="Only what bears on an open Albatross or on today.">
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

              {waiting.length ? (
                <Section title="Waiting, not forgotten" note="These depend on somebody or something else.">
                  <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                    {waiting.map((item) => (
                      <li key={item._id}>
                        <AlbatrossRow item={item} onOpen={() => openAlbatross(item._id)} />
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {!loading &&
              !attention.work.length &&
              !attention.approvals.length &&
              !execution?.currentMove ? (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setCaptureOpen(true)}
                    className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]"
                  >
                    Get this off my mind
                  </button>
                </div>
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
      <DailyCheckin checkin={checkin || null} open={checkinOpen} onOpenChange={setCheckinOpen} />
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
