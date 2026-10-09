// Fixtures for document mode (docs/albatross-document-handoff.md): an invented
// story, a freelance designer who bills a studio for monthly hours. The dev
// harness (/dev/thread-preview?state=checkResult | document) and the tests use
// them. No real person, address, or mailbox is in here.

import type { AlbatrossDocumentRecord } from '../documents/model';
import type { ThreadRunView } from './thread-contract';
import { threadDetailFixture, threadRunFixtures } from './thread-fixtures';
import type { WorkDetailData } from './work-view';

const MINUTE = 60_000;

export const HOURS_DOCUMENT_ID = 'doc_hours_preview';
export const HOURS_DOCUMENT_PATH = `/?view=files&document=${HOURS_DOCUMENT_ID}`;

export function documentHandoffDetailFixture(now = Date.now()): WorkDetailData {
  const detail = threadDetailFixture(now, {
    title: 'Send the September hours and invoice to Harbor Design',
    rawText: 'Bill Harbor Design for September',
  });
  detail.plan = {
    ...detail.plan!,
    outcome: 'Send the September hours and invoice to Harbor Design',
    summary:
      'Harbor Design pays from an hours summary and an invoice. Albatross finds their instructions, makes the document, and drafts the email.',
    sourceRefs: [{ kind: 'mail', id: 'm1', label: 'Billing instructions, Sep 30' }],
  };
  const step = detail.execution.guideSteps[0];
  detail.execution.guideSteps = [
    {
      ...step,
      key: 'step-find',
      identity: 'step-find',
      title: 'Find the billing instructions from Harbor Design',
      detail: 'Find the email that says how to send hours and invoices.',
      url: null,
      done: true,
      stepMode: 'agent_does',
      doneWhen: 'The instructions email is found.',
    },
    {
      ...step,
      key: 'step-document',
      identity: 'step-document',
      title: 'Make the hours summary and invoice',
      detail: 'One document with the hours table and the invoice.',
      url: null,
      done: false,
      stepMode: 'agent_drafts',
      doneWhen: 'The hours summary and invoice document exists with the hours filled in.',
    },
    {
      ...step,
      key: 'step-email',
      identity: 'step-email',
      title: 'Draft the email to Harbor Design with the invoice',
      detail: null,
      url: null,
      done: false,
      stepMode: 'agent_drafts',
      doneWhen: 'A draft to billing@harbor-design.example.com has the invoice attached.',
    },
  ];
  detail.execution.totalSteps = 3;
  detail.execution.remainingSteps = 2;
  return detail;
}

/** The two handoffs: a result with nothing to open, and the document to fill in. */
export function documentHandoffRunsFixture(now = Date.now()): {
  checkResult: ThreadRunView;
  document: ThreadRunView;
} {
  const template = threadRunFixtures(now).done;
  const at = (minutes: number) => now - minutes * MINUTE;
  return {
    checkResult: {
      ...template,
      id: 'run_find_instructions',
      stepKey: 'step-find',
      stepIdentity: 'step-find',
      stepTitle: 'Find the billing instructions from Harbor Design',
      state: 'handed_off',
      outcome: 'ready_for_you',
      browserSessionId: null,
      summary:
        'Found the billing email from Harbor Design on Sep 30: send the hours by month in a table, with an invoice to billing@harbor-design.example.com.',
      log: [
        { at: at(14), text: 'Searched mail for "Harbor Design invoice"' },
        { at: at(13.5), text: 'Read "Billing for contractors" from Harbor Design, Sep 30' },
      ],
      next: {
        kind: 'review',
        label: 'Check the result',
        blanks: [],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        target: null,
        detail:
          'I think the step is done, but I could not prove it: the email gives no hourly rate. Check it, then mark the step done.',
      },
      artifacts: [],
      createdAt: at(15),
      startedAt: at(15),
      updatedAt: at(13),
      finishedAt: at(13),
    },
    document: {
      ...template,
      id: 'run_make_document',
      stepKey: 'step-document',
      stepIdentity: 'step-document',
      stepTitle: 'Make the hours summary and invoice',
      state: 'handed_off',
      outcome: 'ready_for_you',
      browserSessionId: null,
      summary:
        'Made one document with a monthly hours table and an invoice to Harbor Design. No email lists the hours, so those fields are blank for you.',
      log: [
        { at: at(6), text: 'Read the billing instructions again' },
        { at: at(5), text: 'Made the document "September hours and invoice"' },
      ],
      next: {
        kind: 'review_document',
        label: 'Fill in hours',
        blanks: ['hours for each week', 'hourly rate', 'invoice number'],
        doneLabel: null,
        allow: null,
        saveSignIn: null,
        allowAnswer: null,
        detail:
          'Fill in the hours for each week, the hourly rate, and the invoice number. Then the next step drafts the email with the document attached.',
        target: { kind: 'document', id: HOURS_DOCUMENT_ID, url: HOURS_DOCUMENT_PATH },
      },
      artifacts: [
        {
          kind: 'document',
          id: HOURS_DOCUMENT_ID,
          title: 'September hours and invoice',
          url: HOURS_DOCUMENT_PATH,
        },
      ],
      createdAt: at(7),
      startedAt: at(7),
      updatedAt: at(4),
      finishedAt: at(4),
    },
  };
}

/** The document the run made, as `GET /api/documents/:id` returns it. */
export function hoursDocumentFixture(now = Date.now()): AlbatrossDocumentRecord & { suggestions: [] } {
  const block = (id: string, type: 'heading' | 'paragraph' | 'bullet', text: string, level?: 1 | 2) => ({
    id,
    type,
    text,
    ...(level ? { level } : {}),
  });
  return {
    documentId: HOURS_DOCUMENT_ID,
    kind: 'doc',
    title: 'September hours and invoice',
    currentRevision: 1,
    sourceRefs: [],
    createdAt: now - 5 * MINUTE,
    updatedAt: now - 5 * MINUTE,
    suggestions: [],
    model: {
      kind: 'doc',
      version: 1,
      blocks: [
        block('b1', 'heading', 'September hours and invoice', 1),
        block('b2', 'paragraph', 'From: Sam Rivera, design services. To: Harbor Design, billing.'),
        block('b3', 'heading', 'Hours by week', 2),
        block('b4', 'bullet', 'Week of Sep 1: __ hours'),
        block('b5', 'bullet', 'Week of Sep 8: __ hours'),
        block('b6', 'bullet', 'Week of Sep 15: __ hours'),
        block('b7', 'bullet', 'Week of Sep 22: __ hours'),
        block('b8', 'heading', 'Invoice', 2),
        block('b9', 'paragraph', 'Invoice number: __'),
        block('b10', 'paragraph', 'Hourly rate: __'),
        block('b11', 'paragraph', 'Total: hours × rate = __'),
        block('b12', 'paragraph', 'Pay to the account on file. Questions: billing@harbor-design.example.com'),
      ],
    },
  };
}
