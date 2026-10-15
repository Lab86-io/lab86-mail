// Invented fixtures for the Albatross thread: one Work, its runs in every
// state, the shared browser session, the saved personal details, and a short
// chat. The dev harness (app/dev/thread-preview) and the tests read them, so
// each state can be seen and checked without a backend. Sam Rivera is not a
// real person; the phone numbers are 555 numbers.

import type { UIMessage } from 'ai';
import type { AlbatrossDocumentRecord } from '../documents/model';
import type { Draft } from '../shared/types';
import type { ChecklistItem, HandoffItem, RunMessage, RunSource } from './goal-run-contract';
import type { FormQuestion, PersonalDetailsResponse, ThreadRunView } from './thread-contract';
import type { WorkDetailData } from './work-view';

const MINUTE = 60_000;

export const THREAD_FIXTURE_WORK_ID = 'work_alive25';

export function threadDetailFixture(
  now = Date.now(),
  over: Partial<WorkDetailData['work']> = {},
): WorkDetailData {
  return {
    work: {
      _id: THREAD_FIXTURE_WORK_ID,
      title: 'Register for and complete the CPR and first aid course',
      rawText: 'Register for CPR and first aid before Nov 14',
      status: 'ready',
      workState: 'active',
      updatedAt: now - 10 * MINUTE,
      shape: 'project',
      ...over,
    },
    plan: {
      _id: 'plan_alive25',
      outcome: 'Register for and complete the CPR and first aid course',
      summary:
        'The course at firstaidclass.example.com must be complete before the November 14 orientation. Albatross registers you and tracks the certificate.',
      status: 'ready',
      artifactSource: 'none',
      assumptions: ['The pool accepts an online CPR certificate.'],
      sourceRefs: [{ kind: 'mail', id: 'm1', label: 'Pool job offer, Sep 29' }],
    },
    project: null,
    questions: [],
    areaLinks: [],
    execution: {
      currentStep: null,
      guideSteps: [
        {
          key: 'step-1',
          identity: 'step-1',
          kind: 'task',
          title: 'Register for the course',
          detail:
            'Pick a class before November 14 and register with your details. Albatross stops before the $45 payment.',
          url: 'https://firstaidclass.example.com/classes',
          done: false,
          cardId: null,
          stepMode: 'agent_does',
          doneWhen: 'The site shows the registration confirmation.',
          runnable: true,
        },
        {
          key: 'step-2',
          identity: 'step-2',
          kind: 'physical',
          title: 'Attend the lifeguard orientation on November 14',
          detail: 'Bring the completion certificate.',
          url: null,
          done: false,
          cardId: null,
          stepMode: 'you_do_offline',
          runnable: false,
        },
      ],
      remainingSteps: 2,
      totalSteps: 2,
      scheduledStartAt: null,
      scheduledEndAt: null,
      activeRun: null,
      runner: { enabled: true },
    },
    contract: null,
    evidence: [],
    application: {
      _id: 'app_alive25',
      status: 'applied',
      operationIds: ['op_event'],
      artifacts: [
        {
          kind: 'calendar_event',
          id: 'evt_orientation',
          title: 'Lifeguard orientation, November 14',
          operationId: 'op_event',
        },
      ],
    },
  };
}

/** The detail with the first step done, for the done state. */
export function threadDetailDoneStep(now = Date.now()): WorkDetailData {
  const detail = threadDetailFixture(now);
  detail.execution.guideSteps[0] = {
    ...detail.execution.guideSteps[0],
    done: true,
    verification: {
      level: 'observed',
      evidenceTitle: 'Registration confirmed, order A1234',
      evidenceUrl: null,
    },
  };
  detail.execution.remainingSteps = 1;
  detail.execution.currentStep = detail.execution.guideSteps[1];
  return detail;
}

export const classQuestionForm: FormQuestion = {
  title: 'Which class?',
  detail: 'All three are 4-hour Zoom sessions. Registration closes one week before each class.',
  fields: [
    {
      id: 'class',
      label: 'Class',
      kind: 'choice',
      options: [
        {
          id: 'mon-19',
          label: 'Monday, October 19',
          detail: '4:00–8:00 PM · Zoom · $45',
          recommended: 'Matches what you said',
          calendar: { fit: 'free', note: 'Free on your calendar' },
        },
        {
          id: 'wed-21',
          label: 'Wednesday, October 21',
          detail: '4:00–8:00 PM · Zoom · $45',
          calendar: { fit: 'conflict', note: 'Conflicts with Team sync, 5:00 PM' },
        },
        {
          id: 'sat-24',
          label: 'Saturday, October 24',
          detail: '9:00 AM–1:00 PM · Zoom · $45',
          calendar: { fit: 'free', note: 'Free on your calendar' },
        },
      ],
    },
    { id: 'name', label: 'Name', kind: 'name', detailKey: 'name' },
    { id: 'email', label: 'Email', kind: 'email', detailKey: 'email' },
    { id: 'address', label: 'Home address', kind: 'address', detailKey: 'home_address' },
    {
      id: 'phone',
      label: 'Phone',
      kind: 'phone',
      detailKey: 'phone',
      help: 'The site sends the Zoom invite by text message.',
      placeholder: '(555) 555-0100',
    },
  ],
};

export function threadDetailsFixture(now = Date.now()): PersonalDetailsResponse {
  return {
    ok: true,
    details: [
      {
        key: 'name',
        label: 'Name',
        value: { first: 'Sam', last: 'Rivera' },
        display: 'Sam Rivera',
        source: 'settings',
        saved: true,
        updatedAt: now - 3 * 24 * 60 * MINUTE,
      },
      {
        key: 'email',
        label: 'Email',
        value: 'sam.rivera@example.com',
        display: 'sam.rivera@example.com',
        source: 'account',
        saved: false,
        updatedAt: null,
      },
      {
        key: 'home_address',
        label: 'Home address',
        value: {
          line1: '12 Elm Street',
          line2: 'Apt 3',
          city: 'Springfield',
          region: 'IL',
          postalCode: '62704',
          country: 'US',
        },
        display: '12 Elm Street, Apt 3, Springfield, IL 62704',
        source: 'form',
        saved: true,
        updatedAt: now - 24 * 60 * MINUTE,
      },
    ],
    missing: ['phone', 'emergency_contact'],
  };
}

/** The settings list after the thread saved the phone. */
export function threadDetailsWithPhone(now = Date.now()): PersonalDetailsResponse {
  const base = threadDetailsFixture(now);
  return {
    ...base,
    details: [
      ...base.details,
      {
        key: 'phone',
        label: 'Phone',
        value: '+15555550100',
        display: '(555) 555-0100',
        source: 'chat',
        saved: true,
        updatedAt: now - 2 * MINUTE,
      },
    ],
    missing: ['emergency_contact'],
  };
}

function base(now: number, over: Partial<ThreadRunView>): ThreadRunView {
  return {
    id: 'run_fixture',
    workId: THREAD_FIXTURE_WORK_ID,
    stepKey: 'step-1',
    stepIdentity: 'step-1',
    stepTitle: 'Register for the course',
    state: 'running',
    trigger: 'user',
    outcome: null,
    summary: null,
    log: [],
    next: null,
    artifacts: [],
    goal: false,
    messages: [],
    checklist: [],
    items: [],
    unsure: [],
    browserSessionId: null,
    parentRunId: null,
    notes: [],
    stoppedBy: null,
    error: null,
    createdAt: now - 6 * MINUTE,
    startedAt: now - 6 * MINUTE,
    updatedAt: now - MINUTE,
    finishedAt: null,
    question: null,
    ...over,
  };
}

function log(now: number, texts: string[], endAt = now - MINUTE) {
  return texts.map((text, index) => ({ at: endAt - (texts.length - index) * 25_000, text }));
}

export type ThreadRunFixtureName =
  | 'queued'
  | 'running'
  | 'steered'
  | 'needsAnswer'
  | 'answeredForm'
  | 'answeredChat'
  | 'signIn'
  | 'finalPage'
  | 'done'
  | 'failed'
  | 'stoppedTime'
  | 'cancelled'
  | 'readyDraft';

export function threadRunFixtures(now = Date.now()): Record<ThreadRunFixtureName, ThreadRunView> {
  const classLog = [
    'Opened firstaidclass.example.com',
    'Read the class schedule: 3 virtual classes before November 14',
    'Checked your calendar for each class',
    'Opened the registration form to read its fields',
    'Read your details: name, email, and home address are saved',
    'Stopped to ask which class, and for your phone number',
  ];
  const answerText =
    "Class: Monday, October 19 (4:00–8:00 PM · Zoom · $45)\nPhone: (555) 555-0100\nSaved to the user's personal details: Phone.";
  const question = (
    status: 'pending' | 'answered',
    answeredIn: 'form' | 'chat' | null,
    answer: string | null,
  ) => ({
    id: 'question_class',
    form: classQuestionForm,
    prompt: 'Which class?',
    reason: null,
    options: null,
    status,
    answer,
    answeredIn,
  });
  return {
    queued: base(now, {
      id: 'run_queued',
      state: 'queued',
      startedAt: null,
      createdAt: now - 20_000,
      updatedAt: now - 20_000,
    }),
    running: base(now, {
      id: 'run_running',
      browserSessionId: 'session_alive25',
      log: log(now, classLog.slice(0, 3), now - 30_000),
      updatedAt: now - 30_000,
    }),
    steered: base(now, {
      id: 'run_steered',
      browserSessionId: 'session_alive25',
      log: log(
        now,
        [
          ...classLog.slice(0, 2),
          'Read your note: use the Monday class',
          'Opened the Monday, October 19 form',
        ],
        now - 20_000,
      ),
      updatedAt: now - 20_000,
    }),
    needsAnswer: base(now, {
      id: 'run_needs_answer',
      state: 'handed_off',
      outcome: 'needs_answer',
      browserSessionId: 'session_alive25',
      summary:
        'Found three virtual classes before November 14 and opened the registration form to read its fields. Your name, email, and address are ready. The class and your phone number are missing.',
      log: log(now, classLog, now - 2 * MINUTE),
      next: {
        kind: 'answer',
        label: '',
        detail: 'Pick the class. The run continues with your answer.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'question', id: 'question_class' },
      },
      question: question('pending', null, null),
      finishedAt: now - 2 * MINUTE,
    }),
    answeredForm: base(now, {
      id: 'run_answered_form',
      state: 'handed_off',
      outcome: 'needs_answer',
      summary:
        'Found three virtual classes before November 14 and opened the registration form to read its fields.',
      log: log(now, classLog, now - 4 * MINUTE),
      next: {
        kind: 'answer',
        label: '',
        detail: 'Pick the class.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'question', id: 'question_class' },
      },
      question: question('answered', 'form', answerText),
      createdAt: now - 8 * MINUTE,
      finishedAt: now - 4 * MINUTE,
    }),
    answeredChat: base(now, {
      id: 'run_answered_chat',
      state: 'handed_off',
      outcome: 'needs_answer',
      summary:
        'Found three virtual classes before November 14 and opened the registration form to read its fields.',
      log: log(now, classLog, now - 4 * MINUTE),
      next: {
        kind: 'answer',
        label: '',
        detail: 'Pick the class.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'question', id: 'question_class' },
      },
      question: question('answered', 'chat', `Answered in the chat: ${answerText}`),
      createdAt: now - 8 * MINUTE,
      finishedAt: now - 4 * MINUTE,
    }),
    signIn: base(now, {
      id: 'run_sign_in',
      state: 'handed_off',
      outcome: 'your_turn',
      browserSessionId: 'session_alive25',
      summary: 'Opened the class list. The site asks for your sign-in before it shows the registration form.',
      log: log(
        now,
        ['Opened firstaidclass.example.com', 'Went to the class list', 'Stopped at the sign-in form'],
        now - MINUTE,
      ),
      next: {
        kind: 'sign_in',
        label: 'Sign in',
        detail: 'Sign in to firstaidclass.example.com in the page, then press I signed in.',
        blanks: [],
        doneLabel: 'I signed in',
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'session', id: 'session_alive25' },
      },
      finishedAt: now - MINUTE,
    }),
    finalPage: base(now, {
      id: 'run_final_page',
      state: 'handed_off',
      outcome: 'your_turn',
      browserSessionId: 'session_alive25',
      parentRunId: 'run_answered_form',
      notes: [],
      summary:
        'Filled in the registration form for Monday, October 19 with your name, email, address, and phone. The $45 payment is yours to make.',
      log: log(
        now,
        [
          'Read your answer: Monday, October 19',
          'Typed your name, email, and home address',
          'Typed your phone number',
          'Checked every field',
          'Stopped before the payment',
        ],
        now - MINUTE,
      ),
      next: {
        kind: 'finish_on_page',
        label: 'Check and pay',
        detail: 'Everything is filled in. Check it and pay the $45.',
        blanks: [],
        doneLabel: 'I paid',
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'session', id: 'session_alive25' },
      },
      createdAt: now - 3 * MINUTE,
      finishedAt: now - MINUTE,
    }),
    done: base(now, {
      id: 'run_done',
      state: 'done',
      outcome: 'done',
      parentRunId: 'run_final_page',
      notes: [],
      summary: 'The site shows the registration confirmation for Monday, October 19. Order A1234.',
      log: log(
        now,
        ['Read your note: I paid', 'Checked the page: registration confirmed, order A1234'],
        now - 30_000,
      ),
      createdAt: now - MINUTE,
      finishedAt: now - 30_000,
    }),
    failed: base(now, {
      id: 'run_failed',
      state: 'failed',
      log: log(
        now,
        ['Opened firstaidclass.example.com', 'The page did not load', 'Tried again twice'],
        now - MINUTE,
      ),
      error: 'The site did not load after three tries.',
      finishedAt: now - MINUTE,
    }),
    stoppedTime: base(now, {
      id: 'run_stopped_time',
      state: 'handed_off',
      outcome: 'stopped',
      summary: 'Read the class schedule and the first two class pages. One class page remains.',
      log: log(
        now,
        [
          'Opened firstaidclass.example.com',
          'Read the class schedule',
          'Read the Monday class page',
          'Read the Wednesday class page',
        ],
        now - MINUTE,
      ),
      next: {
        kind: 'continue',
        label: 'Continue',
        detail: 'Press Continue. Albatross reads the last class page.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: null,
      },
      stoppedBy: 'time',
      finishedAt: now - MINUTE,
    }),
    cancelled: base(now, {
      id: 'run_cancelled',
      state: 'cancelled',
      summary: null,
      log: log(now, ['Opened firstaidclass.example.com', 'Read the class schedule'], now - MINUTE),
      finishedAt: now - MINUTE,
    }),
    readyDraft: base(now, {
      id: 'run_ready_draft',
      stepKey: 'step-2',
      stepIdentity: 'step-2',
      stepTitle: 'Send the certificate to the pool manager',
      state: 'handed_off',
      outcome: 'ready_for_you',
      summary: 'Wrote the note to the pool manager and attached the certificate to a draft.',
      log: log(
        now,
        [
          'Found the pool manager address in the job offer',
          'Wrote the note',
          'Saved a draft with the certificate',
        ],
        now - MINUTE,
      ),
      next: {
        kind: 'review_draft',
        label: 'Read and send',
        detail: 'Read the draft. Send it when it is correct.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'draft', id: 'draft_manager', accountId: 'sam.rivera@example.com' },
      },
      artifacts: [
        {
          kind: 'draft',
          id: 'draft_manager',
          title: 'CPR and first aid certificate',
          accountId: 'sam.rivera@example.com',
        },
      ],
      finishedAt: now - MINUTE,
    }),
  };
}

export function threadSessionFixture(
  status: 'starting' | 'agent' | 'user' | 'verifying' | 'ended' | 'failed',
  statusDetail?: string,
) {
  return {
    sessionId: 'session_alive25',
    status,
    statusDetail: statusDetail ?? null,
    stepKey: 'step-1',
    liveViewUrl: 'about:blank',
  };
}

/** A short chat: the request, Albatross's one line, and the run it started (inline). */
export function threadMessagesFixture(now = Date.now(), inlineRunId = 'run_running'): UIMessage[] {
  return [
    {
      id: 'm_user_1',
      role: 'user',
      metadata: { createdAt: now - 7 * MINUTE },
      parts: [{ type: 'text', text: 'Go ahead and register me. A Monday or a Wednesday would be best.' }],
    } as UIMessage,
    {
      id: 'm_assistant_1',
      role: 'assistant',
      metadata: { createdAt: now - 7 * MINUTE + 4_000 },
      parts: [
        {
          type: 'text',
          text: 'I will handle the registration. I will stop before the $45 payment, which is yours to make.',
          state: 'done',
        },
        {
          type: 'tool-albatross_handle_step',
          toolCallId: 'call_handle_1',
          state: 'output-available',
          input: { workId: THREAD_FIXTURE_WORK_ID, note: 'A Monday or a Wednesday would be best.' },
          output: {
            ok: true,
            action: 'started',
            runId: inlineRunId,
            workId: THREAD_FIXTURE_WORK_ID,
            message: 'Albatross started on the step.',
          },
        },
        {
          type: 'data-tool-shape',
          id: 'call_handle_1',
          data: {
            kind: 'step_run',
            title: 'Started on the step',
            activity: {
              running: 'Starting on the step',
              done: 'Started on the step',
              failed: 'Could not start on the step',
            },
            actions: [{ kind: 'open_work', workId: THREAD_FIXTURE_WORK_ID }],
            runId: inlineRunId,
            workId: THREAD_FIXTURE_WORK_ID,
            action: 'started',
          },
        },
      ],
    } as unknown as UIMessage,
  ];
}

/** A message from before the thread existed: no `createdAt`, so it sorts first under the divider. */
export function earlierChatMessageFixture(): UIMessage {
  return {
    id: 'm_earlier',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: 'The job offer names November 14 at 9:00 AM. The CPR and first aid course takes four hours.',
        state: 'done',
      },
    ],
  } as UIMessage;
}

// ---------------------------------------------------------------------------
// Goal runs (docs/albatross-goal-runs.md, docs/research/goal-runs-web-design-2026-10-15.md).
// An invented story: a freelance editor bills a small press for July. Bramble
// Press, Priya Natarajan, and the Jira key BP-214 are not real. The only real
// site is irs.gov, where a W-9 comes from.
// ---------------------------------------------------------------------------

export const GOAL_FIXTURE_WORK_ID = 'work_goal_bramble';
export const GOAL_ACCOUNT = 'sam.rivera@example.com';
export const GOAL_INVOICE_DOCUMENT_ID = 'doc_invoice_0007';
export const GOAL_HOURS_DOCUMENT_ID = 'doc_hours_july';
export const GOAL_W9_FILE_ID = 'upload_w9_filled';
export const GOAL_DRAFT_ID = 'draft_invoice_0007';
export const GOAL_INVOICE_DOCUMENT_PATH = `/?view=files&document=${GOAL_INVOICE_DOCUMENT_ID}`;
export const GOAL_HOURS_DOCUMENT_PATH = `/?view=files&document=${GOAL_HOURS_DOCUMENT_ID}`;
export const GOAL_W9_FILE_PATH = `/?view=files&file=${GOAL_W9_FILE_ID}`;

export function goalDetailFixture(
  now = Date.now(),
  over: Partial<WorkDetailData['work']> = {},
): WorkDetailData {
  return {
    work: {
      _id: GOAL_FIXTURE_WORK_ID,
      title: 'Invoice Bramble Press for July',
      rawText: 'Invoice Bramble Press for July, with the W-9 this time',
      status: 'ready',
      workState: 'active',
      updatedAt: now - 10 * MINUTE,
      shape: 'project',
      ...over,
    },
    plan: {
      _id: 'plan_goal_bramble',
      outcome: 'Invoice Bramble Press for July',
      summary:
        'Bramble Press pays within 14 days of a correct invoice with the hours, the W-9, and the direct deposit form. Albatross makes the invoice from your Jira worklog and sends it to Priya Natarajan.',
      status: 'ready',
      artifactSource: 'none',
      digitalActions: [],
      physicalActions: [],
    },
    project: null,
    questions: [],
    areaLinks: [],
    execution: {
      currentStep: null,
      guideSteps: [],
      remainingSteps: 0,
      totalSteps: 0,
      scheduledStartAt: null,
      scheduledEndAt: null,
      activeRun: null,
      runner: { enabled: true },
    },
    goalRuns: true,
    contract: null,
    evidence: [],
    application: {
      _id: 'app_goal_bramble',
      status: 'applied',
      operationIds: ['op_invoice', 'op_hours', 'op_w9', 'op_draft'],
      artifacts: [
        { kind: 'document', id: GOAL_INVOICE_DOCUMENT_ID, title: 'Invoice 0007', operationId: 'op_invoice' },
        { kind: 'document', id: GOAL_HOURS_DOCUMENT_ID, title: 'Hours, July', operationId: 'op_hours' },
        { kind: 'file', id: GOAL_W9_FILE_ID, title: 'Form W-9, filled', operationId: 'op_w9' },
        {
          kind: 'draft',
          id: GOAL_DRAFT_ID,
          title: 'Invoice 0007 to Priya Natarajan',
          operationId: 'op_draft',
        },
      ],
    },
  };
}

/** A Work that moved to goal runs with two steps done before the change. */
export function goalDetailWithEarlierSteps(now = Date.now()): WorkDetailData {
  const detail = goalDetailFixture(now);
  detail.execution.guideSteps = [
    {
      key: 'step-find',
      identity: 'step-find',
      kind: 'task',
      title: 'Find the billing instructions from Bramble Press',
      detail: null,
      url: null,
      done: true,
      cardId: null,
      stepMode: 'agent_does',
      runnable: false,
      verification: { level: 'observed', evidenceTitle: 'Billing instructions, Jun 30', evidenceUrl: null },
    },
    {
      key: 'step-june',
      identity: 'step-june',
      kind: 'task',
      title: 'Send the June invoice',
      detail: null,
      url: null,
      done: true,
      cardId: null,
      stepMode: 'agent_drafts',
      runnable: false,
      verification: { level: 'confirmed', evidenceTitle: 'Invoice 0006 sent, Sep 2', evidenceUrl: null },
    },
  ];
  detail.execution.totalSteps = 2;
  return detail;
}

export const goalSourceFixtures: Record<
  'jira' | 'mailHours' | 'invoice0006' | 'mailRate' | 'w9' | 'calendar',
  RunSource
> = {
  jira: {
    kind: 'jira',
    title: 'BP-214 worklog, July',
    url: 'https://bramble.example.atlassian.net/browse/BP-214',
    id: 'BP-214',
    detail: 'BP-214',
  },
  mailHours: {
    kind: 'mail',
    title: 'July hours',
    id: 'thread_july_hours',
    accountId: GOAL_ACCOUNT,
    detail: 'Priya, Jul 30',
  },
  invoice0006: {
    kind: 'document',
    title: 'Invoice 0006',
    id: 'doc_invoice_0006',
    url: '/?view=files&document=doc_invoice_0006',
  },
  mailRate: { kind: 'mail', title: 'Rate for the autumn work', id: 'thread_rate', accountId: GOAL_ACCOUNT },
  w9: {
    kind: 'web',
    title: 'Form W-9 (Rev. March 2024)',
    url: 'https://www.irs.gov/forms-pubs/about-form-w-9',
  },
  calendar: { kind: 'calendar', title: 'Invoice day', id: 'evt_invoice_day' },
};

const GOAL_CHECKLIST_TEXTS = [
  'Find the July hours',
  'Find the next invoice number',
  'Make the invoice from the template',
  'Get the W-9 from irs.gov and fill it in',
  'Make the hours sheet for July',
  'Write the draft to Priya with the files attached',
  'Fill in the rate and send the mail',
];

/** The checklist with `done` items done, the next one doing, and the last one yours. */
export function goalChecklistFixture(done: number, doing = true): ChecklistItem[] {
  return GOAL_CHECKLIST_TEXTS.map((text, index) => ({
    id: `c${index + 1}`,
    text,
    state:
      index === GOAL_CHECKLIST_TEXTS.length - 1
        ? done >= GOAL_CHECKLIST_TEXTS.length
          ? 'done'
          : 'yours'
        : index < done
          ? 'done'
          : index === done && doing
            ? 'doing'
            : 'todo',
  }));
}

/** The messages of the whole run, oldest first. `count` keeps the first ones. */
export function goalMessageFixtures(now = Date.now(), count = 11): RunMessage[] {
  const start = now - 13 * MINUTE;
  const texts: Array<[string, RunSource[]]> = [
    [
      'I look for the hours you worked for Bramble Press in July: the Jira worklog first, then your mail with Priya.',
      [],
    ],
    [
      'The BP-214 worklog shows 78 hours in July, across 11 days. No mail names a different number, so I use 78.',
      [goalSourceFixtures.jira, goalSourceFixtures.mailHours],
    ],
    [
      'Your last invoice was 0006 on September 2, so this one is 0007. The rate is not on it, and I found no rate in your mail. I leave the rate for you.',
      [goalSourceFixtures.invoice0006, goalSourceFixtures.mailRate],
    ],
    [
      'I make the invoice from the template with your details, the period July 1 to 31, and the 78 hours.',
      [],
    ],
    ['The invoice is saved. The rate, the amount, and the total are blanks for you.', []],
    ['Next, the hours sheet: one row for each of the 11 days, from the worklog.', [goalSourceFixtures.jira]],
    ['The hours sheet is saved.', []],
    ['I get the W-9 from irs.gov. The IRS form is the one Priya asked for in June.', [goalSourceFixtures.w9]],
    [
      'I saved Form W-9 from irs.gov and filled in your name, your address, and the Individual box. The tax ID stays sealed: it fills in when the mail sends.',
      [goalSourceFixtures.w9],
    ],
    ['I write the draft to Priya and attach the invoice as a PDF, the hours sheet, and the W-9.', []],
    [
      'The draft to Priya names the amount as 78 hours at your rate. The rate is the one blank left. When you fill it in, the invoice total and the mail follow.',
      [],
    ],
  ];
  return texts.slice(0, count).map(([text, sources], index) => ({
    id: `msg_${index + 1}`,
    at: start + index * 65_000,
    text,
    sources,
  }));
}

export function goalItemsFixture(): HandoffItem[] {
  return [
    {
      kind: 'draft',
      id: GOAL_DRAFT_ID,
      accountId: GOAL_ACCOUNT,
      title: 'Invoice 0007 to Priya Natarajan',
      state: 'check',
      note: 'The three files are attached.',
    },
    {
      kind: 'document',
      id: GOAL_INVOICE_DOCUMENT_ID,
      url: GOAL_INVOICE_DOCUMENT_PATH,
      title: 'Invoice 0007',
      state: 'blanks',
      blanks: ['rate'],
      note: 'From the invoice template, 78 hours in July.',
    },
    {
      kind: 'sheet',
      id: GOAL_HOURS_DOCUMENT_ID,
      url: GOAL_HOURS_DOCUMENT_PATH,
      title: 'Hours, July',
      state: 'ready',
      note: '11 days from the BP-214 worklog.',
    },
    {
      kind: 'file',
      id: GOAL_W9_FILE_ID,
      url: GOAL_W9_FILE_PATH,
      title: 'Form W-9, filled',
      state: 'check',
      note: 'The tax ID fills in when you send.',
    },
  ];
}

const GOAL_LOG = [
  'Read the BP-214 worklog for July',
  'Searched your mail for July hours',
  'Read Invoice 0006',
  'Searched your mail for the rate',
  'Made Invoice 0007 from the invoice template',
  'Made the hours sheet for July',
  'Searched irs.gov for Form W-9',
  'Saved Form W-9 (Rev. March 2024) in Files',
  'Read the fields of Form W-9',
  'Filled Form W-9 with your name, address, and the Individual box',
  'Converted Invoice 0007 to a PDF',
  'Saved the draft to Priya Natarajan with three attachments',
];

function goalBase(now: number, over: Partial<ThreadRunView>): ThreadRunView {
  return base(now, {
    id: 'run_goal',
    workId: GOAL_FIXTURE_WORK_ID,
    stepKey: 'goal',
    stepIdentity: `goal:${GOAL_FIXTURE_WORK_ID}`,
    stepTitle: 'Invoice Bramble Press for July',
    goal: true,
    createdAt: now - 13 * MINUTE,
    startedAt: now - 13 * MINUTE,
    updatedAt: now - 30_000,
    ...over,
  });
}

export type GoalRunFixtureName =
  | 'goalQueued'
  | 'goalRunning'
  | 'goalNeedsAnswer'
  | 'goalPackage'
  | 'goalYourTurn'
  | 'goalStoppedTime'
  | 'goalFailed'
  | 'goalCancelled'
  | 'goalClosedPackage'
  | 'goalDone';

export const goalAddressQuestionForm: FormQuestion = {
  title: 'Which address for Priya?',
  detail: 'The June invoice went to the Portland office. Her signature now names a Boston address.',
  fields: [
    {
      id: 'address',
      label: 'Address',
      kind: 'choice',
      options: [
        {
          id: 'portland',
          label: '40 Mill Lane, Portland, ME 04101',
          detail: 'On the June invoice',
          recommended: 'On the last invoice',
        },
        {
          id: 'boston',
          label: '8 Harbor Street, Boston, MA 02110',
          detail: 'In her mail signature since October',
        },
      ],
    },
  ],
};

export function goalRunFixtures(now = Date.now()): Record<GoalRunFixtureName, ThreadRunView> {
  const items = goalItemsFixture();
  const packageNext: ThreadRunView['next'] = {
    kind: 'review_document',
    label: 'Open the package',
    detail: 'Fill in the rate, check the W-9, then send the mail.',
    blanks: ['rate'],
    doneLabel: null,
    allow: null,
    saveSignIn: null,
    allowAnswer: null,
    target: { kind: 'document', id: GOAL_INVOICE_DOCUMENT_ID, url: GOAL_INVOICE_DOCUMENT_PATH },
  };
  const unsure = [
    'I found no mail with the hours for July. I used 78 from the BP-214 worklog.',
    'Priya’s address comes from the June invoice mail. Check it if she moved.',
  ];
  return {
    goalQueued: goalBase(now, {
      id: 'run_goal_queued',
      state: 'queued',
      startedAt: null,
      createdAt: now - 20_000,
      updatedAt: now - 20_000,
    }),
    goalRunning: goalBase(now, {
      id: 'run_goal_running',
      state: 'running',
      messages: goalMessageFixtures(now, 7),
      checklist: goalChecklistFixture(2),
      log: log(now, GOAL_LOG.slice(0, 5), now - 30_000),
      createdAt: now - 6 * MINUTE,
      startedAt: now - 6 * MINUTE,
    }),
    goalNeedsAnswer: goalBase(now, {
      id: 'run_goal_needs_answer',
      state: 'handed_off',
      outcome: 'needs_answer',
      messages: goalMessageFixtures(now, 4),
      checklist: goalChecklistFixture(2),
      log: log(now, GOAL_LOG.slice(0, 5), now - 2 * MINUTE),
      summary: 'The invoice needs an address for Priya, and her mail names two.',
      next: {
        kind: 'answer',
        label: '',
        detail: 'Pick the address. The run continues with your answer.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'question', id: 'question_address' },
      },
      question: {
        id: 'question_address',
        form: goalAddressQuestionForm,
        prompt: 'Which address for Priya?',
        reason: null,
        options: null,
        status: 'pending',
        answer: null,
        answeredIn: null,
      },
      finishedAt: now - 2 * MINUTE,
    }),
    goalPackage: goalBase(now, {
      id: 'run_goal_package',
      state: 'handed_off',
      outcome: 'ready_for_you',
      messages: goalMessageFixtures(now, 11),
      checklist: goalChecklistFixture(6, false),
      items,
      unsure,
      log: log(now, GOAL_LOG, now - 2 * MINUTE),
      summary:
        'The invoice, the hours sheet, the filled W-9, and the draft to Priya are ready. The rate is the one blank left.',
      next: packageNext,
      artifacts: [
        {
          kind: 'draft',
          id: GOAL_DRAFT_ID,
          title: 'Invoice 0007 to Priya Natarajan',
          accountId: GOAL_ACCOUNT,
        },
        {
          kind: 'document',
          id: GOAL_INVOICE_DOCUMENT_ID,
          url: GOAL_INVOICE_DOCUMENT_PATH,
          title: 'Invoice 0007',
        },
        { kind: 'document', id: GOAL_HOURS_DOCUMENT_ID, url: GOAL_HOURS_DOCUMENT_PATH, title: 'Hours, July' },
        { kind: 'file', id: GOAL_W9_FILE_ID, url: GOAL_W9_FILE_PATH, title: 'Form W-9, filled' },
      ],
      finishedAt: now - 2 * MINUTE,
    }),
    goalYourTurn: goalBase(now, {
      id: 'run_goal_your_turn',
      state: 'handed_off',
      outcome: 'your_turn',
      browserSessionId: 'session_bramble',
      messages: goalMessageFixtures(now, 8),
      checklist: goalChecklistFixture(3),
      log: log(
        now,
        [...GOAL_LOG.slice(0, 7), 'Opened the Bramble Press vendor portal', 'Stopped at the sign-in form'],
        now - MINUTE,
      ),
      summary: 'The vendor portal asks for your sign-in before it shows the W-9 upload.',
      next: {
        kind: 'sign_in',
        label: 'Sign in',
        detail: 'Sign in to vendors.bramble-press.example.com in the page, then press I signed in.',
        blanks: [],
        doneLabel: 'I signed in',
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'session', id: 'session_bramble' },
      },
      finishedAt: now - MINUTE,
    }),
    goalStoppedTime: goalBase(now, {
      id: 'run_goal_stopped',
      state: 'handed_off',
      outcome: 'stopped',
      messages: [
        ...goalMessageFixtures(now, 6),
        {
          id: 'msg_stop',
          at: now - MINUTE,
          text: 'The document server did not answer for the PDF export. I tried three times over four minutes. The invoice and the hours sheet are saved; the W-9 is not filled in yet.',
          sources: [goalSourceFixtures.invoice0006],
        },
      ],
      checklist: goalChecklistFixture(4, false),
      log: log(now, GOAL_LOG.slice(0, 6), now - MINUTE),
      summary: 'The invoice and the hours sheet are saved. The W-9 and the draft remain.',
      next: {
        kind: 'continue',
        label: 'Continue',
        detail: 'Press Continue. Albatross starts from the checklist.',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: null,
      },
      stoppedBy: 'time',
      createdAt: now - 31 * MINUTE,
      startedAt: now - 31 * MINUTE,
      finishedAt: now - MINUTE,
    }),
    goalFailed: goalBase(now, {
      id: 'run_goal_failed',
      state: 'failed',
      messages: goalMessageFixtures(now, 1),
      checklist: goalChecklistFixture(0),
      log: log(now, ['Opened Jira', 'Jira did not answer', 'Tried again twice'], now - MINUTE),
      error: 'Jira did not answer after three tries.',
      createdAt: now - 5 * MINUTE,
      startedAt: now - 5 * MINUTE,
      finishedAt: now - MINUTE,
    }),
    goalCancelled: goalBase(now, {
      id: 'run_goal_cancelled',
      state: 'cancelled',
      messages: goalMessageFixtures(now, 2),
      checklist: goalChecklistFixture(1),
      log: log(now, GOAL_LOG.slice(0, 2), now - MINUTE),
      finishedAt: now - MINUTE,
    }),
    goalClosedPackage: goalBase(now, {
      id: 'run_goal_closed',
      state: 'closed',
      outcome: 'ready_for_you',
      messages: goalMessageFixtures(now, 11),
      checklist: goalChecklistFixture(6, false),
      items: items.map((item) =>
        item.kind === 'document'
          ? { ...item, state: 'ready' as const, blanks: undefined, note: 'Rate $90, total $7,020.' }
          : item,
      ),
      unsure,
      log: log(now, GOAL_LOG, now - 20 * MINUTE),
      next: packageNext,
      createdAt: now - 33 * MINUTE,
      startedAt: now - 33 * MINUTE,
      finishedAt: now - 20 * MINUTE,
    }),
    goalDone: goalBase(now, {
      id: 'run_goal_done',
      state: 'done',
      outcome: 'done',
      parentRunId: 'run_goal_closed',
      messages: [
        {
          id: 'msg_done',
          at: now - 40_000,
          text: 'The mail to Priya went out at 3:02 PM with the invoice, the hours sheet, and the W-9. The invoice total is $7,020 at $90 an hour.',
          sources: [
            {
              kind: 'mail',
              title: 'Invoice 0007 for July',
              id: 'thread_invoice_0007',
              accountId: GOAL_ACCOUNT,
            },
          ],
        },
      ],
      checklist: goalChecklistFixture(7),
      log: log(
        now,
        [
          'Read your note: sent',
          'Read the sent mail: Invoice 0007 for July',
          'Checked the outcome: the invoice mail went out with three files',
        ],
        now - 40_000,
      ),
      summary: 'The invoice mail went out with the three files. The outcome holds.',
      createdAt: now - 2 * MINUTE,
      startedAt: now - 2 * MINUTE,
      finishedAt: now - 40_000,
    }),
  };
}

/** The saved draft of the package, with its three attachments. */
export function goalDraftFixture(now = Date.now()): Draft {
  return {
    _id: GOAL_DRAFT_ID,
    account: GOAL_ACCOUNT,
    to: 'Priya Natarajan <priya@bramble-press.example.com>',
    subject: 'Invoice 0007 for July',
    body: 'Hi Priya,\n\nHere is my invoice for July: 78 hours on the BP-214 series, with the hours by day in the attached sheet. My W-9 and the direct deposit form are attached as well.\n\nThank you,\nSam',
    attachments: [
      {
        source: 'file',
        fileId: GOAL_INVOICE_DOCUMENT_ID,
        provider: 'office',
        format: 'pdf',
        name: 'Invoice 0007.pdf',
        size: 86_016,
        contentType: 'application/pdf',
      },
      {
        source: 'file',
        fileId: GOAL_HOURS_DOCUMENT_ID,
        provider: 'office',
        format: 'native',
        name: 'Hours, July.xlsx',
        size: 21_504,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      // The server marks a file with a sealed field (the files builder's `sealed`).
      Object.assign(
        {
          source: 'file' as const,
          fileId: GOAL_W9_FILE_ID,
          provider: 'upload' as const,
          format: 'pdf' as const,
          name: 'Form W-9.pdf',
          size: 131_072,
          contentType: 'application/pdf',
        },
        { sealed: true },
      ),
    ],
    updatedAt: now - 2 * MINUTE,
  };
}

function documentRecord(
  now: number,
  documentId: string,
  title: string,
  blocks: Array<[string, 'heading' | 'paragraph' | 'bullet', string, (1 | 2)?]>,
): AlbatrossDocumentRecord & { suggestions: [] } {
  return {
    documentId,
    kind: 'doc',
    title,
    currentRevision: 1,
    sourceRefs: [],
    createdAt: now - 5 * MINUTE,
    updatedAt: now - 5 * MINUTE,
    suggestions: [],
    model: {
      kind: 'doc',
      version: 1,
      blocks: blocks.map(([id, type, text, level]) => ({ id, type, text, ...(level ? { level } : {}) })),
    },
  };
}

/** The invoice as an Albatross document, for the harness (the Word editor needs the document server). */
export function goalInvoiceDocumentFixture(now = Date.now()) {
  return documentRecord(now, GOAL_INVOICE_DOCUMENT_ID, 'Invoice 0007', [
    ['b1', 'heading', 'Invoice 0007', 1],
    [
      'b2',
      'paragraph',
      'From: Sam Rivera, 12 Elm Street, Apt 3, Springfield, IL 62704. sam.rivera@example.com',
    ],
    ['b3', 'paragraph', 'Bill to: Bramble Press, Priya Natarajan, 40 Mill Lane, Portland, ME 04101'],
    ['b4', 'paragraph', 'Date: October 15, 2026. Due: October 29, 2026. Period: July 1 to July 31, 2026.'],
    ['b5', 'heading', 'Work', 2],
    ['b6', 'bullet', 'Editorial work on the BP-214 series, July: 78 hours (11 days, from the Jira worklog)'],
    ['b7', 'paragraph', 'Rate: __ an hour'],
    ['b8', 'paragraph', 'Amount: 78 × rate = __'],
    ['b9', 'heading', 'Total due: __', 2],
    [
      'b10',
      'paragraph',
      'Pay by direct deposit within 14 days. A W-9 and the direct deposit form are attached to the mail.',
    ],
  ]);
}

export function goalHoursDocumentFixture(now = Date.now()) {
  return documentRecord(now, GOAL_HOURS_DOCUMENT_ID, 'Hours, July', [
    ['h1', 'heading', 'Hours, July', 1],
    ['h2', 'paragraph', 'From the BP-214 worklog. 11 days, 78 hours.'],
    ['h3', 'bullet', 'Jul 1: 8 hours. Jul 2: 6 hours. Jul 7: 8 hours. Jul 8: 7 hours.'],
    ['h4', 'bullet', 'Jul 14: 8 hours. Jul 15: 6 hours. Jul 21: 8 hours. Jul 22: 7 hours.'],
    ['h5', 'bullet', 'Jul 28: 8 hours. Jul 29: 6 hours. Jul 30: 6 hours.'],
  ]);
}

/** A short chat for a goal Work: the request, Albatross's one line, and the run it started (inline). */
export function goalMessagesFixture(now = Date.now(), inlineRunId = 'run_goal_running'): UIMessage[] {
  return [
    {
      id: 'm_goal_user_1',
      role: 'user',
      metadata: { createdAt: now - 14 * MINUTE },
      parts: [{ type: 'text', text: 'Go ahead and invoice Priya for July. Attach the W-9 this time.' }],
    } as UIMessage,
    {
      id: 'm_goal_assistant_1',
      role: 'assistant',
      metadata: { createdAt: now - 14 * MINUTE + 4_000 },
      parts: [
        {
          type: 'text',
          text: 'I handle it. I stop before the mail sends; the send is yours.',
          state: 'done',
        },
        {
          type: 'tool-albatross_handle_step',
          toolCallId: 'call_goal_1',
          state: 'output-available',
          input: { workId: GOAL_FIXTURE_WORK_ID, note: 'Attach the W-9 this time.' },
          output: {
            ok: true,
            action: 'started',
            runId: inlineRunId,
            workId: GOAL_FIXTURE_WORK_ID,
            message: 'Albatross started.',
          },
        },
        {
          type: 'data-tool-shape',
          id: 'call_goal_1',
          data: {
            kind: 'step_run',
            title: 'Started',
            activity: { running: 'Starting', done: 'Started', failed: 'Could not start' },
            actions: [{ kind: 'open_work', workId: GOAL_FIXTURE_WORK_ID }],
            runId: inlineRunId,
            workId: GOAL_FIXTURE_WORK_ID,
            action: 'started',
          },
        },
      ],
    } as unknown as UIMessage,
  ];
}
