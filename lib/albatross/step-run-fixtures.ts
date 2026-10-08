// Typed fixtures for every step-run state. The dev harness
// (app/dev/step-run-preview) and the tests read them, so a state can be seen
// and checked without a backend.

import type { StepRunHandoffItem, StepRunView } from './step-run-client';

export type StepRunFixtureName =
  | 'queued'
  | 'running'
  | 'readyDraft'
  | 'readyDocument'
  | 'approve'
  | 'signIn'
  | 'finishOnPage'
  | 'needsAnswer'
  | 'offline'
  | 'review'
  | 'stoppedTime'
  | 'stoppedCost'
  | 'failed'
  | 'done';

const MINUTE = 60_000;

function base(now: number, over: Partial<StepRunView>): StepRunView {
  return {
    id: 'run_fixture',
    workId: 'work_fixture',
    stepKey: 'step-1',
    stepIdentity: 'step-1',
    stepTitle: 'Send the dispute letter to the insurer',
    state: 'running',
    trigger: 'user',
    outcome: null,
    summary: null,
    log: [],
    next: null,
    artifacts: [],
    browserSessionId: null,
    parentRunId: null,
    stoppedBy: null,
    error: null,
    createdAt: now - 4 * MINUTE,
    updatedAt: now - MINUTE,
    finishedAt: null,
    ...over,
  };
}

function log(now: number, texts: string[]) {
  return texts.map((text, index) => ({ at: now - (texts.length - index) * 40_000, text }));
}

export function stepRunFixtures(now = Date.now()): Record<StepRunFixtureName, StepRunView> {
  return {
    queued: base(now, { id: 'run_queued', state: 'queued', log: [] }),
    running: base(now, {
      id: 'run_running',
      state: 'running',
      browserSessionId: 'session_fixture',
      log: log(now, [
        'Read the claim letter from 12 September',
        'Found the dispute form on the insurer site',
        'Filled the policy number and the claim reference',
      ]),
    }),
    readyDraft: base(now, {
      id: 'run_ready_draft',
      state: 'handed_off',
      outcome: 'ready_for_you',
      summary:
        'I wrote the dispute letter from the claim file and attached it to a draft to the insurer. The draft names the policy number and the two dates.',
      log: log(now, [
        'Read the claim letter from 12 September',
        'Wrote the dispute letter',
        'Saved a draft to claims@example-insurer.com',
      ]),
      next: {
        kind: 'review_draft',
        label: 'Read and send',
        detail: 'Read the draft. Send it when it is correct.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'draft', id: 'draft_fixture', accountId: 'jakob@lab86.io' },
      },
      artifacts: [
        {
          kind: 'draft',
          id: 'draft_fixture',
          title: 'Dispute of claim 44-2031',
          accountId: 'jakob@lab86.io',
        },
        { kind: 'document', id: 'doc_fixture', title: 'Dispute letter.docx', url: '/files/doc_fixture' },
      ],
      finishedAt: now - MINUTE,
    }),
    readyDocument: base(now, {
      id: 'run_ready_document',
      stepTitle: 'Write a one-page summary of the lease terms',
      state: 'handed_off',
      outcome: 'ready_for_you',
      summary: 'I made the one-page summary of the lease terms as a document.',
      log: log(now, ['Read the lease', 'Wrote the summary document']),
      next: {
        kind: 'review_document',
        label: 'Open the document',
        detail: 'Read the summary. Change what is not right.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'document', id: 'doc_lease', url: '/files/doc_lease' },
      },
      artifacts: [
        { kind: 'document', id: 'doc_lease', title: 'Lease terms, one page', url: '/files/doc_lease' },
      ],
      finishedAt: now - MINUTE,
    }),
    approve: base(now, {
      id: 'run_approve',
      stepTitle: 'Set up the site visit',
      state: 'handed_off',
      outcome: 'ready_for_you',
      summary: 'I prepared the calendar invite for the site visit on Friday at 10:00.',
      log: log(now, ['Found a free hour on Friday', 'Prepared the invite for two people']),
      next: {
        kind: 'approve',
        label: 'Approve the invite',
        detail: 'The invite goes out after you approve it.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'approval', id: 'approval_fixture' },
      },
      artifacts: [{ kind: 'approval', id: 'approval_fixture', title: 'Invite: site visit, Friday 10:00' }],
      finishedAt: now - MINUTE,
    }),
    signIn: base(now, {
      id: 'run_sign_in',
      stepTitle: 'Move the deposit on the bank site',
      state: 'handed_off',
      outcome: 'your_turn',
      summary: 'I opened the bank site at the transfer page. It asks for your sign-in.',
      log: log(now, ['Opened the bank site', 'Went to the transfer page', 'Stopped at the sign-in form']),
      next: {
        kind: 'sign_in',
        label: 'Sign in',
        detail: 'Sign in on the page, then press Continue. Albatross never sees the password.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'session', id: 'session_fixture' },
      },
      browserSessionId: 'session_fixture',
      finishedAt: now - MINUTE,
    }),
    finishOnPage: base(now, {
      id: 'run_finish',
      state: 'handed_off',
      outcome: 'your_turn',
      summary: 'I filled the renewal form. The last page asks for payment.',
      log: log(now, ['Opened the renewal form', 'Filled the four pages', 'Stopped before the payment page']),
      next: {
        kind: 'finish_on_page',
        label: 'Check and submit',
        detail: 'Check the form, pay, and submit it. Then press I paid.',
        doneLabel: 'I paid',
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'session', id: 'session_fixture' },
      },
      browserSessionId: 'session_fixture',
      finishedAt: now - MINUTE,
    }),
    needsAnswer: base(now, {
      id: 'run_needs_answer',
      stepTitle: 'File the packet with the county office',
      state: 'handed_off',
      outcome: 'needs_answer',
      summary: 'Two offices accept the packet. I need to know which one you want.',
      log: log(now, ['Read the office list', 'Found two offices in your county']),
      next: {
        kind: 'answer',
        label: '',
        detail: 'Pick the office. The run continues with your answer.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'question', id: 'question_fixture' },
      },
      finishedAt: now - MINUTE,
    }),
    offline: base(now, {
      id: 'run_offline',
      state: 'handed_off',
      outcome: 'your_turn',
      summary: 'The office takes the packet only in person. I printed the checklist.',
      log: log(now, ['Read the office rules', 'Wrote the checklist']),
      next: {
        kind: 'do_offline',
        label: 'Mark this step done',
        detail: 'Bring the packet to the office. Then mark the step done here.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: null,
      },
      artifacts: [
        { kind: 'document', id: 'doc_checklist', title: 'Packet checklist', url: '/files/doc_checklist' },
      ],
      finishedAt: now - MINUTE,
    }),
    review: base(now, {
      id: 'run_review',
      state: 'handed_off',
      outcome: 'ready_for_you',
      summary: 'The tracking page shows the parcel at the depot since this morning.',
      log: log(now, ['Opened the tracking page', 'Read the last three events']),
      next: {
        kind: 'review',
        label: 'Open the tracking page',
        detail: 'Look at the page. Tell Albatross if the parcel moves.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: { kind: 'url', url: 'https://example.com/track/123' },
      },
      artifacts: [{ kind: 'page', title: 'Tracking page', url: 'https://example.com/track/123' }],
      finishedAt: now - MINUTE,
    }),
    stoppedTime: base(now, {
      id: 'run_stopped_time',
      stepTitle: 'Compare the six health plans',
      state: 'handed_off',
      outcome: 'stopped',
      summary: 'I compared four plans. Two more remain.',
      log: log(now, ['Read plan A', 'Read plan B', 'Read plan C', 'Read plan D']),
      next: {
        kind: 'continue',
        label: 'Continue',
        detail: 'Press Continue. Albatross reads the last two plans.',
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: null,
      },
      stoppedBy: 'time',
      finishedAt: now - MINUTE,
    }),
    stoppedCost: base(now, {
      id: 'run_stopped_cost',
      state: 'handed_off',
      outcome: 'stopped',
      summary: 'I read the first forty pages of the contract.',
      log: log(now, ['Opened the contract', 'Read pages 1 to 40']),
      next: null,
      stoppedBy: 'cost',
      finishedAt: now - MINUTE,
    }),
    failed: base(now, {
      id: 'run_failed',
      state: 'failed',
      log: log(now, ['Opened the insurer site']),
      error: 'The insurer site did not load after three tries.',
      finishedAt: now - MINUTE,
    }),
    done: base(now, {
      id: 'run_done',
      state: 'done',
      outcome: 'done',
      summary: 'I filed the receipt in the claim folder.',
      log: log(now, ['Found the receipt in Mail', 'Saved it to the claim folder']),
      finishedAt: now - MINUTE,
    }),
  };
}

/** The Brief list: one run at work and three handoffs, newest first. */
export function handoffFixtures(now = Date.now()): StepRunHandoffItem[] {
  const runs = stepRunFixtures(now);
  return [
    { workId: 'work_claim', workTitle: 'Dispute the water damage claim', run: runs.running },
    { workId: 'work_lease', workTitle: 'Renew the office lease', run: runs.readyDocument },
    { workId: 'work_bank', workTitle: 'Move the deposit to the new account', run: runs.signIn },
    { workId: 'work_plans', workTitle: 'Pick a health plan for next year', run: runs.stoppedTime },
  ];
}

export const questionFixture = {
  _id: 'question_fixture',
  status: 'pending',
  prompt: 'Which office takes the packet?',
  options: [
    { id: 'downtown', label: 'Downtown office', description: 'Open until 17:00' },
    { id: 'north', label: 'North county office', description: 'Open until 19:00, longer queue' },
  ],
};
