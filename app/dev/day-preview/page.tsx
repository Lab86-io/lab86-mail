'use client';

import { notFound } from 'next/navigation';
import { DayRibbon } from '@/components/report/DayRibbon';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import type { TodayEvent } from '@/lib/albatross/today';

/* Dev-only harness: the day ribbon against fixed days, so the drawing can be
 * verified without waiting for a real account to have a busy calendar. Covers
 * the four shapes that matter — a booked day, a wide-open day, a day with one
 * early edge case, and an empty day. Not linked from anywhere; 404s outside
 * development. */
export default function DayPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DayPreviewInner />;
}

const at = (hour: number, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
};

const event = (id: string, title: string, from: number, to: number, location?: string): TodayEvent => ({
  _id: id,
  title,
  startAt: from,
  endAt: to,
  allDay: false,
  location: location ?? null,
  status: null,
});

const BOOKED: TodayEvent[] = [
  event('a', 'Stand-up', at(9), at(9, 15)),
  event('b', 'Design review', at(9, 30), at(10, 30), 'Studio'),
  event('c', 'Lunch with Mara', at(12), at(13), 'Ostro'),
  event('d', 'Quarterly numbers', at(15), at(17), 'Room 2'),
  event('e', 'Squash', at(19), at(20)),
];

const OPEN: TodayEvent[] = [
  {
    _id: 'holiday',
    title: 'Bank holiday',
    startAt: at(0),
    endAt: at(23, 59),
    allDay: true,
    location: null,
    status: null,
  },
  event('f', 'Call the dentist', at(11), at(11, 20)),
];

const EDGES: TodayEvent[] = [
  event('g', 'Flight to Lisbon', at(6), at(9, 40), 'Gate 44'),
  event('h', 'Late set', at(22, 30), at(23, 45), 'Hoxton'),
];

function DayPreviewInner() {
  useApplyThemeExtras();
  const now = at(10, 20);
  const days: Array<{ title: string; note: string; events: TodayEvent[] }> = [
    { title: 'A booked day', note: 'Five commitments, two real openings.', events: BOOKED },
    { title: 'A day that is mostly yours', note: 'One all-day marker and one short call.', events: OPEN },
    { title: 'A day with edges', note: 'A 6am flight and a late set must both fit.', events: EDGES },
    { title: 'An empty day', note: 'Nothing booked at all.', events: [] },
  ];

  return (
    <div className="min-h-dvh bg-[var(--color-bg)] p-8 text-[var(--color-text)]">
      <p className="font-mono text-[11px] uppercase text-[var(--color-text-faint)]">Day ribbon</p>
      <div className="mt-6 grid gap-8 md:grid-cols-2 xl:grid-cols-4">
        {days.map((day) => (
          <section key={day.title}>
            <h2 className="font-serif text-[16px] font-semibold tracking-tight">{day.title}</h2>
            <p className="mb-3 text-[12px] text-[var(--color-text-muted)]">{day.note}</p>
            <DayRibbon events={day.events} nowMs={now} height={420} />
          </section>
        ))}
      </div>
    </div>
  );
}
