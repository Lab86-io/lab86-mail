// Invented fixtures for the Albatross thread: one Work, its runs in every
// state, the shared browser session, the saved personal details, and a short
// chat. The dev harness (app/dev/thread-preview) and the tests read them, so
// each state can be seen and checked without a backend. Sam Rivera is not a
// real person; the phone numbers are 555 numbers.

import type { UIMessage } from 'ai';
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
