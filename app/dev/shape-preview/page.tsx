'use client';

import { notFound } from 'next/navigation';
import { useState } from 'react';
import { OutcomeHeader } from '@/components/albatross/primitives';
import { ListBody } from '@/components/albatross/shapes/ListBody';
import type { ListItem } from '@/components/albatross/shapes/ListRow';
import type { Milestone, MilestoneRow } from '@/components/albatross/shapes/MilestoneRail';
import { type MetricEntry, PracticeBody } from '@/components/albatross/shapes/PracticeBody';
import { ProjectBody } from '@/components/albatross/shapes/ProjectBody';
import {
  SHAPE_STATUS_LINE,
  ShapeBodySwap,
  ShapeFactsRow,
  shapeFacts,
} from '@/components/albatross/shapes/ShapeFrame';
import { ShapePicker } from '@/components/albatross/shapes/ShapePicker';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import type { MetricLike } from '@/lib/albatross/practice-review';
import { metricSummary } from '@/lib/albatross/practice-review';
import type { EvidenceLike } from '@/lib/albatross/proof';
import type { WorkShape } from '@/lib/albatross/work-shape';

/* Dev-only harness: the Wave D shape bodies on fixtures, so the picker, the
 * list settle, the practice trend, and the milestone rail can be checked
 * without a signed-in account. Not linked from anywhere; 404s outside
 * development. */
export default function ShapePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ShapePreviewInner />;
}

const DAY = 24 * 60 * 60_000;

const TITLE: Record<WorkShape, string> = {
  quick: 'Renew the passport',
  list: 'Movie list',
  project: 'Ship the Albatross Mac app',
  practice: 'Lose fifteen pounds by spring',
  decision: 'Pick the venue for the wedding',
  monitor: 'Watch for the Lisbon flight price drop',
  recurring: 'Water the plants',
};

function listFixture(nowMs: number): ListItem[] {
  return [
    { id: 'heat', text: 'Heat', done: false, addedAt: nowMs - 9 * DAY },
    { id: 'alien', text: 'Alien', done: true, addedAt: nowMs - 8 * DAY, doneAt: nowMs - 2 * DAY },
    { id: 'dune', text: 'Dune part two', done: false, addedAt: nowMs - 7 * DAY },
    { id: 'blade', text: 'Blade Runner', done: false, addedAt: nowMs - 1 * DAY },
  ];
}

const metricFixture: MetricLike = { name: 'Weight', unit: 'lb', target: 170, direction: 'down' };

function entriesFixture(nowMs: number): MetricEntry[] {
  const values = [185, 184.2, 183.5, 182.8, 181.9, 180.4, 179.8];
  return values.map((value, index) => ({
    _id: `e${index}`,
    at: nowMs - (values.length - 1 - index) * 8 * DAY,
    value,
    note: null,
  }));
}

const milestonesFixture: Milestone[] = [
  { id: 'm1', title: 'Sidebar and shell', done: true, doneAt: Date.now() - 20 * DAY, order: 0 },
  { id: 'm2', title: 'Mail split view', done: true, doneAt: Date.now() - 6 * DAY, order: 1 },
  { id: 'm3', title: 'Calendar sync', done: false, order: 2 },
  { id: 'm4', title: 'TestFlight build', done: false, order: 3 },
];

function evidenceFixture(nowMs: number): EvidenceLike[] {
  return [
    {
      _id: 'ev1',
      title: 'Merge pull request #214: mac mail split',
      sourceKind: 'github_pull_request',
      occurredAt: nowMs - 6 * DAY,
      trust: 'confirmed',
      url: 'https://github.com',
    },
    {
      _id: 'ev2',
      title: 'Sequence the sidebar measurements',
      sourceKind: 'github_commit',
      occurredAt: nowMs - 3 * DAY,
      trust: 'observed',
    },
    {
      _id: 'ev3',
      title: 'macOS target notes',
      sourceKind: 'mcp_item',
      occurredAt: nowMs - 2 * 60 * 60_000,
      trust: 'inferred',
    },
  ];
}

function ShapePreviewInner() {
  useApplyThemeExtras();
  const [nowMs] = useState(() => Date.now());
  const [shape, setShape] = useState<WorkShape>('list');
  const [items, setItems] = useState(() => listFixture(nowMs));
  const [entries, setEntries] = useState(() => entriesFixture(nowMs));
  const [freshId, setFreshId] = useState<string | null>(null);
  const [milestones, setMilestones] = useState(milestonesFixture);
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((current) => [line, ...current].slice(0, 8));

  const facts = shapeFacts(
    shape,
    {
      listItems: items,
      metric: metricFixture,
      metricSummary: metricSummary(entries, nowMs),
      milestones,
      lastUserTouchAt: nowMs - 3 * 60 * 60_000,
    },
    nowMs,
  );

  return (
    <QueryProvider clerkEnabled={false}>
      <div className="app-paper relative min-h-dvh">
        <div className="mx-auto max-w-3xl px-5 py-10">
          <OutcomeHeader
            outcome={TITLE[shape]}
            work={{ workState: 'active', agentState: null }}
            evidence={[]}
            state="in_progress"
            eyebrow={
              <ShapePicker
                value={shape}
                onChange={(next) => {
                  note(`shape ${next}`);
                  setShape(next);
                }}
              />
            }
            facts={facts ? <ShapeFactsRow facts={facts} /> : undefined}
          />

          <ShapeBodySwap shape={shape}>
            {(shown, kind) => (
              <>
                {SHAPE_STATUS_LINE[shown] ? (
                  <p data-shape-status className="mt-5 text-[13px] text-[var(--color-text-muted)]">
                    {SHAPE_STATUS_LINE[shown]}
                  </p>
                ) : null}
                {kind === 'list' ? (
                  <ListBody
                    items={items}
                    onAdd={(texts) => {
                      note(`add ${texts.join(' | ')}`);
                      setItems((current) => [
                        ...current,
                        ...texts.map((text, index) => ({
                          id: `n${Date.now()}${index}`,
                          text,
                          done: false,
                          addedAt: Date.now() + index,
                        })),
                      ]);
                    }}
                    onToggle={(id) => {
                      note(`toggle ${id}`);
                      setItems((current) =>
                        current.map((item) =>
                          item.id === id
                            ? { ...item, done: !item.done, doneAt: item.done ? undefined : Date.now() }
                            : item,
                        ),
                      );
                    }}
                    onRemove={(id) => {
                      note(`remove ${id}`);
                      setItems((current) => current.filter((item) => item.id !== id));
                    }}
                  />
                ) : kind === 'practice' ? (
                  <PracticeBody
                    metric={metricFixture}
                    entries={entries}
                    nowMs={nowMs}
                    freshId={freshId}
                    onLog={(value, noteText) => {
                      const id = `fresh${Date.now()}`;
                      note(`log ${value}${noteText ? ` (${noteText})` : ''}`);
                      setEntries((current) => [
                        ...current,
                        { _id: id, at: nowMs, value, note: noteText ?? null },
                      ]);
                      setFreshId(id);
                    }}
                  />
                ) : kind === 'milestones' ? (
                  <ProjectBody
                    milestones={milestones}
                    evidence={evidenceFixture(nowMs)}
                    artifacts={[{ kind: 'github_issue', id: '412', title: 'Track the TestFlight build' }]}
                    lastUserTouchAt={nowMs - 3 * 60 * 60_000}
                    nowMs={nowMs}
                    onToggle={(id) => {
                      note(`milestone ${id}`);
                      setMilestones((current) =>
                        current.map((row) =>
                          row.id === id
                            ? { ...row, done: !row.done, doneAt: row.done ? undefined : Date.now() }
                            : row,
                        ),
                      );
                    }}
                    onSetMilestones={(rows: MilestoneRow[]) => {
                      note(`milestones ${JSON.stringify(rows)}`);
                      setMilestones(
                        rows.map((row, order) => {
                          const keep = milestones.find((existing) => existing.id === row.id);
                          return {
                            id: row.id ?? `m${Date.now()}${order}`,
                            title: row.title,
                            done: keep?.done ?? false,
                            doneAt: keep?.doneAt,
                            order,
                          };
                        }),
                      );
                      return true;
                    }}
                  />
                ) : (
                  <p className="mt-6 text-[13px] text-[var(--color-text-muted)]">
                    The guided body renders here on the real page.
                  </p>
                )}
              </>
            )}
          </ShapeBodySwap>

          <pre className="mt-10 text-[11px] text-[var(--color-text-faint)]">{log.join('\n')}</pre>
        </div>
      </div>
    </QueryProvider>
  );
}
