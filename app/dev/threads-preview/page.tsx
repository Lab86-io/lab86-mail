'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ThreadGroupSection } from '@/components/albatross/AlbatrossesSurface';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { ThreadAnswerInPlace } from '@/components/albatross/ThreadAnswerInPlace';
import { ThreadRail } from '@/components/albatross/ThreadRail';
import { ThreadRow } from '@/components/albatross/ThreadRow';
import type { WorkShapeState } from '@/components/albatross/thread/use-work-shape';
import {
  THREAD_SPLIT_QUERY,
  type ThreadHandlers,
  type ThreadModel,
  WorkThreadView,
} from '@/components/albatross/WorkThread';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { ThreadRunView } from '@/lib/albatross/thread-contract';
import {
  classQuestionForm,
  threadDetailFixture,
  threadDetailsFixture,
  threadMessagesFixture,
  threadRunFixtures,
} from '@/lib/albatross/thread-fixtures';
import { THREAD_LIST_FIXTURE_IDS, threadListFixture } from '@/lib/albatross/thread-list-fixtures';
import {
  listCountSentence,
  listThreadGroups,
  THREAD_FILTER_LABEL,
  THREAD_FILTERS,
} from '@/lib/albatross/thread-list-view';
import { steerNoteMessage } from '@/lib/albatross/thread-notes';
import { filterThreadRows, type ThreadFilter } from '@/lib/albatross/threads';

/* Dev-only harness: the thread rail, the full list, and the in-place flows,
 * from fixtures, so each state can be seen and screenshotted without a backend.
 *   ?screen=rail    the rail beside an open thread (a run in progress, a note read)
 *   ?screen=list    the full list, no thread open
 *   ?screen=answer  the full list with "Answer" open in place
 *   &dark=1         dark mode
 * Not linked from anywhere; 404s outside development. */
export default function ThreadsPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ThreadsPreview />;
}

// A fixed clock keeps the times the same in every screenshot.
const NOW = Date.UTC(2026, 9, 8, 14, 46, 0);
const TIME_ZONE = 'UTC';
const noop = () => undefined;
const yes = async () => true;

const staticShape: WorkShapeState = {
  shape: 'project',
  shapeSaving: false,
  shapeError: null,
  saveShape: async () => undefined,
  horizon: null,
  horizonSaving: false,
  horizonError: null,
  saveHorizon: async () => undefined,
  listItems: [],
  listBusyIds: new Set(),
  listError: null,
  addListItems: async () => undefined,
  toggleListItem: async () => undefined,
  removeListItem: async () => undefined,
  metricEntries: [],
  metricSaving: false,
  metricError: null,
  freshEntryId: null,
  logMetric: async () => undefined,
  milestones: [],
  milestoneBusyIds: new Set(),
  milestonesSaving: false,
  milestoneError: null,
  toggleMilestone: async () => undefined,
  saveMilestones: async () => true,
};

function ThreadsPreview() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const screen = params.get('screen') ?? 'rail';
  const dark = params.get('dark') === '1';
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    return () => document.documentElement.classList.remove('dark');
  }, [dark]);
  return (
    <QueryProvider clerkEnabled={false}>
      <div className="app-paper h-dvh overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
        {screen === 'rail' ? <RailScreen /> : <ListScreen answer={screen === 'answer'} />}
      </div>
    </QueryProvider>
  );
}

/** The open thread: "Renew the car registration" with a run in progress and a note it read. */
function RailScreen() {
  const wide = useMediaQuery(THREAD_SPLIT_QUERY);
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const fixture = useMemo(() => threadListFixture(NOW), []);
  const runs = useMemo(() => threadRunFixtures(NOW), []);
  const steered: ThreadRunView = useMemo(
    () => ({
      ...runs.steered,
      stepTitle: 'Renew online',
      notes: [
        { id: 'note_two_year', at: NOW - 60_000, text: 'Use the two-year option', readAt: NOW - 50_000 },
      ],
      log: [
        { at: NOW - 130_000, text: 'Opened dmv.ny.gov' },
        { at: NOW - 120_000, text: 'Chose "Renew a registration"' },
        { at: NOW - 90_000, text: 'Typed your plate number from your details' },
        { at: NOW - 50_000, text: 'Read your note: Use the two-year option' },
        { at: NOW - 20_000, text: "Typed your saved Driver's license on dmv.ny.gov" },
      ],
    }),
    [runs],
  );
  const messages = useMemo(
    () => [
      ...threadMessagesFixture(NOW, 'run_steered'),
      steerNoteMessage('Use the two-year option', 'run_steered', { id: 'note_two_year', now: NOW - 60_000 }),
    ],
    [],
  );
  const detail = useMemo(() => {
    const value = threadDetailFixture(NOW);
    value.work.title = 'Renew the car registration';
    value.execution.guideSteps = value.execution.guideSteps.map((step, index) =>
      index === 0 ? { ...step, title: 'Renew online' } : step,
    );
    return value;
  }, []);
  const model: ThreadModel = {
    workId: THREAD_LIST_FIXTURE_IDS.car,
    title: 'Renew the car registration',
    detail,
    runs: [steered],
    session: null,
    personalDetails: threadDetailsFixture(NOW).details,
    nowMs: NOW,
    timeZone: TIME_ZONE,
    busy: { runId: null, action: null, stepKey: null },
    runError: null,
    answerErrors: null,
    undoneOperations: new Set(),
    undoing: null,
    completing: false,
    error: null,
    region: null,
    wide,
    shape: staticShape,
  };
  const handlers: ThreadHandlers = {
    onBack: noop,
    onHandle: noop,
    onStop: noop,
    onResume: noop,
    onDismiss: noop,
    onMarkDone: noop,
    onNext: noop,
    onAnswer: noop,
    onUndoSave: async () => undefined,
    onUndoArtifact: noop,
    onTakeOver: noop,
    onPageDone: noop,
    onClosePage: noop,
    onReopenPage: noop,
    onRegionChange: noop,
    onSetWorkState: noop,
    onError: noop,
    onSteerNote: yes,
    onRedirectStop: yes,
    onRedirectResume: yes,
    chat: { preview: true, initialMessages: messages },
  };
  return (
    <div className="flex h-full min-h-0">
      <ThreadRail
        rows={fixture.rows}
        laterCount={2}
        openWorkId={THREAD_LIST_FIXTURE_IDS.car}
        filter={filter}
        onFilterChange={setFilter}
        nowMs={NOW}
        timeZone={TIME_ZONE}
        locale="en-US"
        onOpen={noop}
        onAction={noop}
        onSteer={yes}
        onMarkUnread={noop}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <WorkThreadView model={model} handlers={handlers} />
      </div>
    </div>
  );
}

/** The full list, with "Answer" open in place when asked. */
function ListScreen({ answer }: { answer: boolean }) {
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const fixture = useMemo(() => threadListFixture(NOW), []);
  const runs = useMemo(() => threadRunFixtures(NOW), []);
  const rows = useMemo(
    () => filterThreadRows(fixture.rows, filter).filter((row) => !row.closed),
    [fixture, filter],
  );
  const groups = useMemo(() => listThreadGroups(rows), [rows]);
  const [answering, setAnswering] = useState<string | null>(answer ? THREAD_LIST_FIXTURE_IDS.lisbon : null);
  // The Lisbon question, as the run would carry it.
  const lisbonRuns: ThreadRunView[] = useMemo(
    () => [
      {
        ...runs.needsAnswer,
        id: 'run_lisbon',
        workId: THREAD_LIST_FIXTURE_IDS.lisbon,
        stepTitle: 'Choose the dates',
        question: {
          id: 'question_lisbon',
          form: {
            ...classQuestionForm,
            title: 'Which dates work?',
            detail: 'All three keep the Friday flight you asked for. Prices are for two people.',
            fields: [
              {
                id: 'dates',
                label: 'Dates',
                kind: 'choice',
                options: [
                  {
                    id: 'nov7',
                    label: 'Fri, Nov 7 – Tue, Nov 11',
                    detail: 'Lisbon · 4 nights · $1,140',
                    recommended: 'Matches what you said',
                    calendar: { fit: 'free', note: 'Free on your calendar' },
                  },
                  {
                    id: 'nov14',
                    label: 'Fri, Nov 14 – Tue, Nov 18',
                    detail: 'Lisbon · 4 nights · $1,060',
                    calendar: { fit: 'conflict', note: 'Conflicts with Team offsite, Nov 17' },
                  },
                  {
                    id: 'nov21',
                    label: 'Fri, Nov 21 – Tue, Nov 25',
                    detail: 'Lisbon · 4 nights · $1,210',
                    calendar: { fit: 'free', note: 'Free on your calendar' },
                  },
                ],
              },
            ],
          },
          prompt: 'Which dates work?',
          reason: null,
          options: null,
          status: 'pending',
          answer: null,
          answeredIn: null,
        },
      },
    ],
    [runs],
  );
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="px-5 pb-2 pt-8">
        <div className="mx-auto max-w-3xl">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="font-display text-[34px] font-normal leading-[1.1] tracking-[-0.015em]">
              Albatrosses
            </h1>
            <p className="flex-1 text-[14px] text-[var(--color-text-muted)]">
              {listCountSentence(
                groups.find((group) => group.key === 'needs_you')?.rows.length ?? 0,
                groups.find((group) => group.key === 'working')?.rows.length ?? 0,
              )}
            </p>
            <span className="text-[12px] text-[var(--color-text-muted)]">Show finished</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {THREAD_FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={
                  filter === key
                    ? 'rounded-ui bg-[var(--color-accent-soft)] px-3 py-1 text-[12.5px] font-medium text-[var(--color-accent)]'
                    : 'rounded-ui px-3 py-1 text-[12.5px] text-[var(--color-text-muted)]'
                }
              >
                {THREAD_FILTER_LABEL[key]}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-6">
        <div className="mx-auto max-w-3xl">
          {groups.map((group) => (
            <ThreadGroupSection key={group.key} groupKey={group.key}>
              {group.rows.map((row) => (
                <li key={row.workId}>
                  <ThreadRow
                    row={row}
                    variant="list"
                    prominent={group.key === 'needs_you'}
                    nowMs={NOW}
                    timeZone={TIME_ZONE}
                    locale="en-US"
                    onOpen={noop}
                    onAction={(kind, target) => {
                      if (kind === 'answer') setAnswering(target.workId);
                    }}
                    onSteer={yes}
                    onMarkUnread={noop}
                    inPlace={
                      answering === row.workId ? (
                        <ThreadAnswerInPlace
                          row={row}
                          runs={lisbonRuns}
                          submit={async () => undefined}
                          onDone={() => setAnswering(null)}
                          onCancel={() => setAnswering(null)}
                          onOpenThread={() => setAnswering(null)}
                        />
                      ) : null
                    }
                  />
                </li>
              ))}
            </ThreadGroupSection>
          ))}
          {groups.length === 0 ? (
            <div className="mx-auto max-w-md py-20 text-center">
              <AlbatrossMark className="mx-auto mb-4 size-10 text-[var(--color-text-faint)]" />
              <p className="font-display text-[22px] font-normal">Nothing on your shoulders yet</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
