'use client';

import { notFound } from 'next/navigation';
import { useState } from 'react';
import { HorizonControl } from '@/components/albatross/HorizonControl';
import { LaterShelf, type LaterShelfItem } from '@/components/albatross/LaterShelf';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { type WakeNotification, WakeNudge } from '@/components/shell/WakeNudge';
import { type WorkHorizon, wakeLine } from '@/lib/albatross/horizon';

/* Dev-only harness: the Wave A pieces on fixtures, so the Later rail, the
 * horizon control, and the wake nudge can be checked without a signed-in
 * account that owns dormant Work. Not linked from anywhere; 404s outside
 * development. */
export default function HorizonPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <HorizonPreviewInner />;
}

const DAY = 24 * 60 * 60_000;

function at(year: number, month: number, day: number) {
  return new Date(year, month, day).getTime();
}

function fixtures(nowMs: number): LaterShelfItem[] {
  const year = new Date(nowMs).getFullYear();
  return [
    {
      _id: 'dentist',
      title: 'Book the dentist',
      rawText: '',
      horizon: { kind: 'later', notBefore: nowMs + 9 * DAY, label: 'after the trip' },
      updatedAt: 2,
    },
    {
      _id: 'passport',
      title: 'Renew the passport before the spring trip to Lisbon',
      rawText: '',
      horizon: { kind: 'later', notBefore: at(year, 10, 1), label: 'not before November' },
      updatedAt: 1,
    },
    {
      _id: 'taxes',
      title: 'File the taxes',
      rawText: '',
      horizon: { kind: 'later', notBefore: at(year, 10, 20) },
      updatedAt: 3,
    },
    {
      _id: 'garage',
      title: null,
      rawText: 'Clear the garage',
      horizon: { kind: 'later', label: 'after the wedding' },
      updatedAt: 9,
    },
    { _id: 'piano', title: 'Learn the piano', rawText: '', horizon: { kind: 'someday' }, updatedAt: 5 },
  ];
}

const wakes: WakeNotification[] = [
  {
    _id: 'n1',
    type: 'work_wake',
    title: wakeLine('Passport renewal'),
    status: 'delivered',
    entityKind: 'work',
    entityId: 'passport',
    createdAt: 2,
  },
  {
    _id: 'n2',
    type: 'work_wake',
    title: wakeLine('The dentist'),
    status: 'queued',
    entityKind: 'work',
    entityId: 'dentist',
    createdAt: 1,
  },
];

function HorizonPreviewInner() {
  useApplyThemeExtras();
  const [nowMs] = useState(() => Date.now());
  const [value, setValue] = useState<WorkHorizon | null>({
    kind: 'later',
    notBefore: at(new Date(nowMs).getFullYear(), 10, 1),
    label: 'not before November',
  });
  const [fresh, setFresh] = useState<WorkHorizon | null>(null);
  const [rows, setRows] = useState(wakes);
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((current) => [line, ...current].slice(0, 6));

  return (
    <QueryProvider clerkEnabled={false}>
      <div className="app-paper relative min-h-dvh">
        <WakeNudge
          notifications={rows}
          nowMs={nowMs}
          onOpen={(row) => {
            note(`open ${row.entityId}`);
            setRows((current) => current.filter((item) => item._id !== row._id));
          }}
          onLater={(row, horizon) => {
            note(`later ${row.entityId} ${JSON.stringify(horizon)}`);
            setRows((current) => current.filter((item) => item._id !== row._id));
          }}
          onDismiss={(row) => {
            note(`dismiss ${row.entityId}`);
            setRows((current) => current.filter((item) => item._id !== row._id));
          }}
        />
        <div className="mx-auto max-w-3xl px-5 py-10">
          <div className="mb-8">
            <div className="mb-3 flex items-baseline gap-2">
              <span aria-hidden className="h-px w-5 shrink-0 bg-[var(--color-border-strong)]" />
              <h2 className="font-serif text-[15px] font-semibold">Later</h2>
              <p className="text-[12px] text-[var(--color-text-faint)]">
                Kept, not carried. Each comes back on its date.
              </p>
              <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <LaterShelf items={fixtures(nowMs)} nowMs={nowMs} onOpen={(id) => note(`shelf ${id}`)} />
          </div>

          <div className="mb-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
            <p className="mb-3 text-[12px] text-[var(--color-text-muted)]">A saved Later horizon.</p>
            <HorizonControl value={value} nowMs={nowMs} onChange={setValue} className="items-start" />
          </div>

          <div className="mb-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
            <p className="mb-3 text-[12px] text-[var(--color-text-muted)]">Work on Now.</p>
            <HorizonControl value={fresh} nowMs={nowMs} onChange={setFresh} className="items-start" />
          </div>

          <div className="mb-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5">
            <p className="mb-3 text-[12px] text-[var(--color-text-muted)]">A save that failed.</p>
            <HorizonControl
              value={{ kind: 'later', notBefore: nowMs + 3 * DAY }}
              nowMs={nowMs}
              onChange={() => {}}
              saving
              error="Could not save the horizon. Try again."
              className="items-start"
            />
          </div>

          <pre className="text-[11px] text-[var(--color-text-faint)]">{log.join('\n')}</pre>
        </div>
      </div>
    </QueryProvider>
  );
}
