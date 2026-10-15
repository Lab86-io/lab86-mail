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
import { activeTabKey, packageTabs } from '@/lib/albatross/goal-run-view';
import type { PersonalDetailsResponse } from '@/lib/albatross/thread-contract';
import {
  earlierChatMessageFixture,
  GOAL_DRAFT_ID,
  GOAL_FIXTURE_WORK_ID,
  GOAL_HOURS_DOCUMENT_ID,
  GOAL_INVOICE_DOCUMENT_ID,
  GOAL_W9_FILE_ID,
  goalDetailFixture,
  goalDetailWithEarlierSteps,
  goalDraftFixture,
  goalHoursDocumentFixture,
  goalInvoiceDocumentFixture,
  goalMessagesFixture,
  goalRunFixtures,
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
 *          | goalQueued | goalRunning | goalNeedsAnswer | goalPackage | goalYourTurn
 *          | goalStopped | goalFailed | goalDone | goalDetails | goalEarlierSteps
 *          | goalDocument   (docs/albatross-goal-runs.md; &tab=draft | invoice | hours | w9;
 *                           &allow=1 makes the compose route ask for a send permission)
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
  | 'document'
  | 'goalQueued'
  | 'goalRunning'
  | 'goalNeedsAnswer'
  | 'goalPackage'
  | 'goalYourTurn'
  | 'goalStopped'
  | 'goalFailed'
  | 'goalDone'
  | 'goalDetails'
  | 'goalEarlierSteps'
  | 'goalDocument';

/** The `&tab=` name of a tab key, so the harness keeps the active tab in the URL vocabulary. */
function tabNameOf(key: string): string | null {
  return Object.entries(GOAL_TAB_IDS).find(([, id]) => key.endsWith(`:${id}`))?.[0] ?? null;
}

/** The `&tab=` names of the goal package, by item id. */
const GOAL_TAB_IDS: Record<string, string> = {
  draft: GOAL_DRAFT_ID,
  invoice: GOAL_INVOICE_DOCUMENT_ID,
  hours: GOAL_HOURS_DOCUMENT_ID,
  w9: GOAL_W9_FILE_ID,
};

function buildModel(
  state: StateName,
  wide: boolean,
  regionOverride: ThreadRegion | undefined,
  goalOptions: { tab: string | null; sentDrafts: Record<string, string> } = { tab: null, sentDrafts: {} },
): { model: ThreadModel; messages: ReturnType<typeof threadMessagesFixture>; region: ThreadRegion } {
  const runs = threadRunFixtures(NOW);
  const goal = goalRunFixtures(NOW);
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
    // Goal runs (docs/albatross-goal-runs.md): the Bramble Press invoice.
    case 'goalQueued':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalQueued];
      messages = goalMessagesFixture(NOW, 'run_goal_queued');
      break;
    case 'goalRunning':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalRunning];
      messages = goalMessagesFixture(NOW, 'run_goal_running');
      break;
    case 'goalNeedsAnswer':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalNeedsAnswer];
      messages = goalMessagesFixture(NOW, 'run_goal_needs_answer');
      break;
    case 'goalPackage':
    case 'goalDetails':
    case 'goalDocument':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalPackage];
      messages = goalMessagesFixture(NOW, 'run_goal_package');
      region = state === 'goalDetails' ? 'details' : state === 'goalDocument' ? 'document' : null;
      break;
    case 'goalYourTurn':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalYourTurn];
      messages = goalMessagesFixture(NOW, 'run_goal_your_turn');
      session = threadSessionFixture('user');
      region = 'page';
      break;
    case 'goalStopped':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalStoppedTime];
      messages = goalMessagesFixture(NOW, 'run_goal_stopped');
      break;
    case 'goalFailed':
      detail = goalDetailFixture(NOW);
      threadRuns = [goal.goalFailed];
      messages = goalMessagesFixture(NOW, 'run_goal_failed');
      break;
    case 'goalDone':
      detail = goalDetailFixture(NOW, { workState: 'done' });
      threadRuns = [goal.goalClosedPackage, goal.goalDone];
      messages = goalMessagesFixture(NOW, 'run_goal_closed');
      break;
    case 'goalEarlierSteps':
      detail = goalDetailWithEarlierSteps(NOW);
      threadRuns = [];
      messages = [];
      break;
    default:
      break;
  }
  if (regionOverride !== undefined) region = regionOverride;
  const goalState = state.startsWith('goal');
  const title =
    state === 'checkResult' || state === 'document' || goalState ? (detail.work.title ?? '') : common.title;
  // Document mode with the package: one tab per item, the `&tab=` one or the next.target one active.
  const packageRun =
    goalState && region === 'document' ? threadRuns.find((run) => run.items.length) : undefined;
  const tabs = packageRun ? packageTabs(packageRun) : [];
  const wanted = goalOptions.tab ? GOAL_TAB_IDS[goalOptions.tab] : null;
  const activeKey =
    (wanted ? tabs.find((tab) => tab.item.id === wanted)?.key : null) ??
    (packageRun ? activeTabKey(tabs, packageRun.next) : null);
  return {
    model: {
      ...common,
      workId: goalState ? GOAL_FIXTURE_WORK_ID : common.workId,
      title,
      detail,
      runs: threadRuns,
      session,
      region,
      document:
        region === 'document' && !packageRun ? { provider: 'albatross', id: HOURS_DOCUMENT_ID } : null,
      documentTabs: packageRun && activeKey ? { runId: packageRun.id, tabs, activeKey } : null,
      sentDrafts: goalOptions.sentDrafts,
      sealedFields: { [GOAL_W9_FILE_ID]: ['ssn'] },
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

/**
 * The harness has no backend: the document editor, the draft tab, the PDF
 * pane, and the compose route read their fixtures from this stub. The sample
 * W-9 is public/dev/w9-sample.pdf (scripts/dev/make-w9-sample.mjs).
 */
function useDocumentFetchStub() {
  useState(() => {
    if (typeof window === 'undefined') return null;
    const original = window.fetch.bind(window);
    const askForAllow = new URLSearchParams(window.location.search).get('allow') === '1';
    let allowed = false;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.includes(`/api/documents/${HOURS_DOCUMENT_ID}`) && method === 'GET')
        return Response.json({ ok: true, document: hoursDocumentFixture(NOW) });
      if (url.includes(`/api/documents/${GOAL_INVOICE_DOCUMENT_ID}`) && method === 'GET')
        return Response.json({ ok: true, document: goalInvoiceDocumentFixture(NOW) });
      if (url.includes(`/api/documents/${GOAL_HOURS_DOCUMENT_ID}`) && method === 'GET')
        return Response.json({ ok: true, document: goalHoursDocumentFixture(NOW) });
      if (url.includes(`/api/files/saved/${GOAL_W9_FILE_ID}`)) return original('/dev/w9-sample.pdf');
      // callTool reads `result` (lib/api-client.ts).
      if (url.includes('/api/tools/list_drafts'))
        return Response.json({ ok: true, result: { drafts: [goalDraftFixture(NOW)] } });
      if (url.includes('/api/tools/update_draft') || url.includes('/api/tools/save_draft'))
        return Response.json({ ok: true, result: { ok: true, draft: goalDraftFixture(NOW) } });
      if (url.includes('/api/secure-details/allow-send')) {
        allowed = true;
        const body = JSON.parse(String(init?.body ?? '{}')) as { scope?: string };
        return Response.json(
          body.scope === 'once'
            ? { ok: true, scope: 'once', allowToken: 'tok_preview', expiresAt: NOW + 600_000 }
            : { ok: true, scope: 'always' },
        );
      }
      if (new URL(url, window.location.origin).pathname === '/api/compose') {
        if (askForAllow && !allowed)
          return Response.json(
            {
              ok: false,
              code: 'needs_allow',
              grant: 'send',
              sendId: 'outbox:preview',
              domains: ['bramble-press.example.com'],
              allow: [
                {
                  itemId: 'secure_tax_id',
                  itemLabel: 'Tax ID',
                  fieldLabels: ['Social security number'],
                  domains: ['bramble-press.example.com'],
                },
              ],
              error: 'A sealed file needs your permission for this send.',
            },
            { status: 409 },
          );
        return Response.json({ ok: true, sent: true });
      }
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
  const [tab, setTab] = useState<string | null>(params.get('tab'));
  const [sentDrafts, setSentDrafts] = useState<Record<string, string>>({});
  const built = useMemo(
    () => buildModel(state, wide, region ?? regionParam, { tab, sentDrafts }),
    [state, wide, region, regionParam, tab, sentDrafts],
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
      onHandleGoal: noop,
      onOpenPackage: (_run, key) => {
        setTab(key ? tabNameOf(key) : null);
        setRegion('document');
      },
      onOpenItem: (_run, key) => {
        setTab(tabNameOf(key));
        setRegion('document');
      },
      onSelectTab: (key) => setTab(tabNameOf(key)),
      onDoneContinue: () => setRegion(null),
      onOpenSource: noop,
      onDraftSent: (draftId) => setSentDrafts((current) => ({ ...current, [draftId]: '3:02 PM' })),
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
