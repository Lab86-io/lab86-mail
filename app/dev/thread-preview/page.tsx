'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { WorkShapeState } from '@/components/albatross/thread/use-work-shape';
import {
  THREAD_SPLIT_QUERY,
  type ThreadHandlers,
  type ThreadModel,
  type ThreadRegion,
  WorkThreadView,
} from '@/components/albatross/WorkThread';
import { PersonalDetailsList } from '@/components/settings/PersonalDetailsSection';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  documentHandoffDetailFixture,
  documentHandoffRunsFixture,
  HOURS_DOCUMENT_ID,
  hoursDocumentFixture,
} from '@/lib/albatross/document-handoff-fixtures';
import type { PersonalDetailsResponse } from '@/lib/albatross/thread-contract';
import {
  earlierChatMessageFixture,
  threadDetailDoneStep,
  threadDetailFixture,
  threadDetailsFixture,
  threadDetailsWithPhone,
  threadMessagesFixture,
  threadRunFixtures,
  threadSessionFixture,
} from '@/lib/albatross/thread-fixtures';
import { createFixtureTransport } from '@/lib/chat/preview-fixture';

/* Dev-only harness: the Albatross thread in every state, from fixtures, so each
 * one can be seen and screenshotted without a backend. Query switches:
 *   ?state=planning | running | steered | needsAnswer | answeredChat | signIn
 *          | finalPage | done | failed | stopped | details | earlier | settings
 *          | checkResult | document   (docs/albatross-document-handoff.md)
 *   &region=page | details | document | none   (overrides the state's own region)
 * Not linked from anywhere; 404s outside development. */
export default function ThreadPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ThreadPreview />;
}

// A fixed clock keeps the times the same in every screenshot.
const NOW = Date.UTC(2026, 9, 7, 14, 46, 0);
const TIME_ZONE = 'UTC';
const noop = () => undefined;

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

type StateName =
  | 'planning'
  | 'running'
  | 'steered'
  | 'needsAnswer'
  | 'answeredChat'
  | 'signIn'
  | 'finalPage'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'details'
  | 'earlier'
  | 'settings'
  | 'checkResult'
  | 'document';

function buildModel(
  state: StateName,
  wide: boolean,
  regionOverride: ThreadRegion | undefined,
): { model: ThreadModel; messages: ReturnType<typeof threadMessagesFixture>; region: ThreadRegion } {
  const runs = threadRunFixtures(NOW);
  const details = threadDetailsFixture(NOW).details;
  const common = {
    workId: 'work_alive25',
    title: 'Register for and complete the CPR and first aid course',
    nowMs: NOW,
    timeZone: TIME_ZONE,
    busy: { runId: null, action: null, stepKey: null },
    runError: null,
    answerErrors: null,
    undoneOperations: new Set<string>(),
    undoing: null,
    completing: false,
    error: null,
    wide,
    shape: staticShape,
    personalDetails: details,
  } satisfies Partial<ThreadModel>;
  let detail = threadDetailFixture(NOW);
  let threadRuns: ThreadModel['runs'] = [];
  let session: ThreadModel['session'] = null;
  let region: ThreadRegion = null;
  let messages = threadMessagesFixture(NOW);
  switch (state) {
    case 'planning':
      detail = threadDetailFixture(NOW);
      detail.plan = null;
      detail.execution.guideSteps = [];
      detail.execution.totalSteps = 0;
      messages = [];
      break;
    case 'running':
      threadRuns = [runs.running];
      session = threadSessionFixture('agent', 'Reading the class schedule');
      region = 'page';
      break;
    case 'steered':
      threadRuns = [runs.steered];
      messages = [
        ...threadMessagesFixture(NOW, 'run_steered'),
        {
          id: 'm_user_2',
          role: 'user',
          metadata: { createdAt: NOW - 25_000 },
          parts: [{ type: 'text', text: 'Use the Monday class.' }],
        } as (typeof messages)[number],
        {
          id: 'm_assistant_2',
          role: 'assistant',
          metadata: { createdAt: NOW - 22_000 },
          parts: [
            {
              type: 'tool-albatross_handle_step',
              toolCallId: 'call_handle_2',
              state: 'output-available',
              input: { workId: 'work_alive25', note: 'Use the Monday class.' },
              output: {
                ok: true,
                action: 'steered',
                runId: 'run_steered',
                workId: 'work_alive25',
                message: '',
              },
            },
            {
              type: 'data-tool-shape',
              id: 'call_handle_2',
              data: {
                kind: 'step_run',
                title: 'Passed your note to the run',
                activity: {
                  running: 'Passing your note',
                  done: 'Passed your note to the run',
                  failed: 'Could not pass the note',
                },
                actions: [],
                runId: 'run_steered',
                workId: 'work_alive25',
                action: 'steered',
              },
            },
            { type: 'text', text: 'Noted. Albatross uses the Monday class.', state: 'done' },
          ],
        } as unknown as (typeof messages)[number],
      ];
      session = threadSessionFixture('agent', 'Opening the Monday, October 19 form');
      region = 'page';
      break;
    case 'needsAnswer':
      threadRuns = [runs.needsAnswer];
      messages = threadMessagesFixture(NOW, 'run_needs_answer');
      session = threadSessionFixture('user');
      region = 'page';
      break;
    case 'answeredChat':
      threadRuns = [runs.answeredChat, { ...runs.finalPage, parentRunId: 'run_answered_chat' }];
      messages = [
        ...threadMessagesFixture(NOW, 'run_answered_chat'),
        {
          id: 'm_user_3',
          role: 'user',
          metadata: { createdAt: NOW - 3 * 60_000 - 20_000 },
          parts: [{ type: 'text', text: 'Monday works, my phone is 555 555 0100' }],
        } as (typeof messages)[number],
        {
          id: 'm_assistant_3',
          role: 'assistant',
          metadata: { createdAt: NOW - 3 * 60_000 - 15_000 },
          parts: [
            {
              type: 'tool-personal_details_save',
              toolCallId: 'call_save_1',
              state: 'output-available',
              input: { details: [{ key: 'phone', value: '555 555 0100' }], source: 'chat' },
              output: { ok: true, saved: [{ key: 'phone', label: 'Phone' }] },
            },
            {
              type: 'data-tool-shape',
              id: 'call_save_1',
              data: {
                kind: 'receipt',
                title: 'Saved to your details: Phone',
                activity: {
                  running: 'Saving your details',
                  done: 'Saved to your details: Phone',
                  failed: 'Could not save',
                },
                surface: 'memory',
                target: { personalDetails: ['phone'] },
                actions: [{ kind: 'undo_personal_details', keys: ['phone'] }],
              },
            },
            { type: 'text', text: 'Monday, October 19 it is. Albatross continues.', state: 'done' },
          ],
        } as unknown as (typeof messages)[number],
      ];
      session = threadSessionFixture('user');
      region = regionOverride === undefined ? null : regionOverride;
      break;
    case 'signIn':
      threadRuns = [runs.signIn];
      messages = threadMessagesFixture(NOW, 'run_sign_in');
      session = threadSessionFixture('user');
      region = 'page';
      break;
    case 'finalPage':
      threadRuns = [runs.answeredForm, runs.finalPage];
      messages = threadMessagesFixture(NOW, 'run_answered_form');
      session = threadSessionFixture('user');
      region = 'page';
      break;
    case 'done':
      detail = threadDetailDoneStep(NOW);
      threadRuns = [runs.answeredForm, runs.finalPage, runs.done];
      messages = [
        ...threadMessagesFixture(NOW, 'run_answered_form'),
        {
          id: 'm_assistant_4',
          role: 'assistant',
          metadata: { createdAt: NOW - 20_000 },
          parts: [
            {
              type: 'text',
              text: 'Next: attend the lifeguard orientation on November 14. This one is yours. Albatross reminds you the day before.',
              state: 'done',
            },
          ],
        } as unknown as (typeof messages)[number],
      ];
      break;
    case 'failed':
      threadRuns = [runs.failed];
      messages = threadMessagesFixture(NOW, 'run_failed');
      break;
    case 'stopped':
      threadRuns = [runs.stoppedTime];
      messages = threadMessagesFixture(NOW, 'run_stopped_time');
      break;
    case 'details':
      threadRuns = [runs.answeredForm, runs.finalPage];
      messages = threadMessagesFixture(NOW, 'run_answered_form');
      session = threadSessionFixture('user');
      region = 'details';
      break;
    case 'checkResult':
    case 'document': {
      detail = documentHandoffDetailFixture(NOW);
      const handoffs = documentHandoffRunsFixture(NOW);
      if (state === 'checkResult') {
        detail.execution.guideSteps[0].done = false;
        threadRuns = [handoffs.checkResult];
      } else {
        threadRuns = [handoffs.document];
        region = 'document';
        // A plan question that no run owns: the thread shows it above the composer.
        detail.questions = [
          {
            _id: 'question_weeks',
            status: 'pending',
            prompt: 'Which weeks does this invoice cover, and how many hours for each?',
            reason: 'No email lists the hours.',
          },
        ];
      }
      messages = [];
      break;
    }
    case 'earlier':
      threadRuns = [runs.running];
      messages = [earlierChatMessageFixture(), ...threadMessagesFixture(NOW)];
      session = threadSessionFixture('agent', 'Reading the class schedule');
      break;
    default:
      break;
  }
  if (regionOverride !== undefined) region = regionOverride;
  const title = state === 'checkResult' || state === 'document' ? (detail.work.title ?? '') : common.title;
  return {
    model: {
      ...common,
      title,
      detail,
      runs: threadRuns,
      session,
      region,
      document: region === 'document' ? { provider: 'albatross', id: HOURS_DOCUMENT_ID } : null,
    },
    messages,
    region,
  };
}

function regionFromSearch(value: string | null): ThreadRegion | undefined {
  if (value === 'page' || value === 'details' || value === 'document') return value;
  if (value === 'none') return null;
  return undefined;
}

/** The harness has no backend: the document editor reads its fixture from this stub. */
function useDocumentFetchStub() {
  useState(() => {
    if (typeof window === 'undefined') return null;
    const original = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/api/documents/${HOURS_DOCUMENT_ID}`) && (!init?.method || init.method === 'GET'))
        return Response.json({ ok: true, document: hoursDocumentFixture(NOW) });
      return original(input, init);
    }) as typeof fetch;
    return null;
  });
}

function ThreadPreview() {
  useApplyThemeExtras();
  useDocumentFetchStub();
  const params = useSearchParams();
  const state = (params.get('state') || 'needsAnswer') as StateName;
  const regionParam = regionFromSearch(params.get('region'));
  const wide = useMediaQuery(THREAD_SPLIT_QUERY);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const transport = useMemo(() => createFixtureTransport(), []);
  const [region, setRegion] = useState<ThreadRegion | undefined>(undefined);
  const built = useMemo(
    () => buildModel(state, wide, region ?? regionParam),
    [state, wide, region, regionParam],
  );
  const handlers: ThreadHandlers = useMemo(
    () => ({
      onBack: noop,
      onHandle: noop,
      onStop: noop,
      onResume: noop,
      onDismiss: noop,
      onMarkDone: noop,
      onNext: (behaviour) => {
        if (behaviour.kind === 'open_document') setRegion('document');
      },
      onAnswer: noop,
      onUndoSave: async () => undefined,
      onUndoArtifact: noop,
      onTakeOver: noop,
      onPageDone: noop,
      onClosePage: () => setRegion(null),
      onReopenPage: noop,
      onRegionChange: (next) => setRegion(next),
      onOpenDocument: () => setRegion('document'),
      onCloseDocument: () => setRegion(null),
      onDocumentDone: () => setRegion(null),
      onAnswerWorkQuestion: noop,
      onSetWorkState: noop,
      onError: noop,
      chat: { transport, preview: true },
    }),
    [transport],
  );

  if (state === 'settings') {
    const response: PersonalDetailsResponse =
      params.get('saved') === 'phone' ? threadDetailsWithPhone(NOW) : threadDetailsFixture(NOW);
    return (
      <QueryProvider clerkEnabled={false}>
        <main
          data-preview-state={ready ? 'ready' : 'loading'}
          className="mx-auto min-h-dvh max-w-3xl bg-[var(--color-bg)] px-6 py-8 text-[var(--color-text)]"
        >
          <PersonalDetailsList
            response={response}
            accountName="Sam rivera"
            onSave={async () => true}
            onDelete={noop}
            timeZone={TIME_ZONE}
          />
        </main>
      </QueryProvider>
    );
  }

  return (
    <QueryProvider clerkEnabled={false}>
      <main
        data-preview-state={ready ? 'ready' : 'loading'}
        className="app-paper h-dvh overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]"
      >
        <WorkThreadView
          key={`${state}:${built.region ?? 'none'}`}
          model={built.model}
          handlers={{ ...handlers, chat: { transport, preview: true, initialMessages: built.messages } }}
        />
      </main>
    </QueryProvider>
  );
}
