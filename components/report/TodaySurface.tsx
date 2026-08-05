'use client';

import { useQuery as useReactQuery } from '@tanstack/react-query';
import { useConvexAuth, useQuery } from 'convex/react';
import { CalendarDays, LoaderCircle } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DailyCheckin, type DailyCheckinData } from '@/components/albatross/DailyCheckin';
import { ReEntry, ReviewBatch } from '@/components/albatross/Forgiveness';
import { AlbatrossRow } from '@/components/albatross/primitives';
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
  readyToMove,
  type TodayApproval,
  type TodayEvent,
  type TodayPractice,
  type TodayWork,
  todayDateline,
  waitingOnSomebody,
} from '@/lib/albatross/today';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

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
  const setCaptureOpen = useClientStore((s) => s.setCaptureOpen);
  const capacity = useClientStore((s) => s.capacity);
  const setCapacity = useClientStore((s) => s.setCapacity);
  // One timestamp for the whole render, so the window and the dateline agree.
  const [nowMs] = useState(() => Date.now());
  const window = useMemo(() => dayWindow(nowMs), [nowMs]);

  const work = useQuery(api.albatrossWorkV2.allWork, isAuthenticated ? {} : 'skip') as
    | TodayWork[]
    | undefined;
  const events = useQuery(
    api.calendarData.dayEvents,
    isAuthenticated ? { startAt: window.startAt, endAt: window.endAt } : 'skip',
  ) as TodayEvent[] | undefined;
  const approvals = useQuery(api.albatrossWork.listApprovals, isAuthenticated ? { limit: 20 } : 'skip') as
    | TodayApproval[]
    | undefined;

  const rows = work || [];
  const attention = needsYouToday(rows, approvals || []);
  const schedule = fixedSchedule(events || []);
  const ready = readyToMove(rows, capacity);
  const [showAllReady, setShowAllReady] = useState(false);
  const [dayChangedOpen, setDayChangedOpen] = useState(false);
  const readyItems = showAllReady ? openWork(rows) : ready.items;
  const waiting = waitingOnSomebody(rows);
  const loading = work === undefined;

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
      <header className="border-b border-[var(--color-border)] px-5 py-4">
        <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            {/* A dateline, not a page title: rule, day, deck. The one place
                the product lets itself be a newspaper. */}
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-px w-6 bg-[var(--color-accent)]" />
              <span className="font-mono text-[10.5px] tabular-nums text-[var(--color-text-faint)]">
                {new Date(nowMs).toLocaleDateString('en-US', { year: 'numeric' })}
              </span>
            </div>
            <h1 className="mt-1.5 font-serif text-[clamp(22px,3.6vw,30px)] font-semibold leading-none tracking-tight">
              {todayDateline(nowMs)}
            </h1>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              {shape}
            </p>
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
              Today's plan was a guess. Tell Albatross how the day actually looks and it will use less of it —
              nothing is lost either way.
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-6">
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
              <p className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                <LoaderCircle className="size-4 animate-spin" /> Loading
              </p>
            ) : null}

            {attention.work.length || attention.approvals.length ? (
              <Section title="Needs you" note="Albatross cannot move these without you.">
                <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  {attention.approvals.map((approval) => (
                    <li key={approval._id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (approval.intentId) setSelectedWorkId(approval.intentId);
                          setPrimaryView('albatrosses');
                        }}
                        className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-serif text-[16px] font-semibold">{approval.title}</span>
                          <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">
                            Waiting for your approval
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {attention.work.map((item) => (
                    <li key={item._id}>
                      <AlbatrossRow item={item} onOpen={() => setSelectedWorkId(item._id)} />
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

            {readyItems.length ? (
              <Section title="Could move today" note="Albatross is carrying these. None of them is booked.">
                <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  {readyItems.map((item) => (
                    <li key={item._id}>
                      <AlbatrossRow item={item} onOpen={() => setSelectedWorkId(item._id)} />
                    </li>
                  ))}
                </ul>
                {/* Capacity shortens the day; it never hides it. */}
                {ready.heldBack && !showAllReady ? (
                  <button
                    type="button"
                    onClick={() => setShowAllReady(true)}
                    className="mt-2 text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
                  >
                    {ready.heldBack === 1
                      ? 'One more is held back for the capacity you set — show it'
                      : `${ready.heldBack} more are held back for the capacity you set — show them`}
                  </button>
                ) : null}
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
                      <AlbatrossRow item={item} onOpen={() => setSelectedWorkId(item._id)} />
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {!loading && !attention.work.length && !attention.approvals.length && !readyItems.length ? (
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
                <p className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-[13px] text-[var(--color-text-muted)]">
                  <CalendarDays className="size-4 shrink-0" aria-hidden />
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
