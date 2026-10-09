// Invented threads for the preview page and the tests (docs/albatross-threads.md).
// The rows come through the real `buildThreadRows`, so a fixture row is exactly
// what the server would send for that Work and activity. Never a real person.

import type { RunActivity, ThreadStateView } from '../../convex/albatrossThreads';
import { buildThreadRows, type ThreadActivity, type ThreadRow, type ThreadWorkInput } from './threads';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface ThreadListFixtureWork extends ThreadWorkInput {
  _id: string;
  title: string;
  rawText: string;
  status: string;
  workState: string;
  agentState: string | null;
  primaryAreaId: string | null;
  areaName: string | null;
  openQuestions: number;
  updatedAt: number;
  createdAt: number;
  horizon: null;
  lastUserTouchAt: number | null;
}

function work(over: Partial<ThreadListFixtureWork> & { _id: string; title: string }): ThreadListFixtureWork {
  return {
    rawText: over.title,
    status: 'ready',
    workState: 'active',
    agentState: null,
    primaryAreaId: 'area_home',
    areaName: 'Home',
    openQuestions: 0,
    updatedAt: 0,
    createdAt: 0,
    horizon: null,
    lastUserTouchAt: null,
    nextStep: null,
    ...over,
  };
}

function run(over: Partial<RunActivity> & { runId: string; state: RunActivity['state'] }): RunActivity {
  return {
    outcome: null,
    stepTitle: 'Renew online',
    logLine: null,
    nextKind: null,
    nextLabel: null,
    nextDetail: null,
    nextBlanks: [],
    allowAnswered: false,
    summary: null,
    error: null,
    stoppedBy: null,
    startedAt: null,
    finishedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function state(over: Partial<ThreadStateView> = {}): ThreadStateView {
  return {
    answering: false,
    answeringSince: null,
    replyAt: null,
    replyWaits: false,
    replyPreview: null,
    seenAt: null,
    ...over,
  };
}

export const THREAD_LIST_FIXTURE_IDS = {
  lisbon: 'work_lisbon',
  dentist: 'work_dentist',
  passport: 'work_passport',
  car: 'work_car',
  water: 'work_water',
  lease: 'work_lease',
  gym: 'work_gym',
  library: 'work_library',
  recycling: 'work_recycling',
  insurance: 'work_insurance',
  taxes: 'work_taxes',
  invoice: 'work_invoice',
} as const;

/** Nine awake threads in mixed states, plus one finished one, as the design note shows them. */
export function threadListFixture(now = Date.now()): {
  works: ThreadListFixtureWork[];
  activity: ThreadActivity;
  rows: ThreadRow[];
} {
  const ids = THREAD_LIST_FIXTURE_IDS;
  const works: ThreadListFixtureWork[] = [
    work({
      _id: ids.lisbon,
      title: 'Plan the Lisbon trip',
      primaryAreaId: 'area_travel',
      areaName: 'Travel',
      updatedAt: now - 3 * MINUTE,
      lastUserTouchAt: now - 40 * MINUTE,
      nextStep: 'Choose the dates',
    }),
    work({
      _id: ids.invoice,
      title: 'Send the September hours and invoice to Harbor Design',
      primaryAreaId: 'area_money',
      areaName: 'Money',
      updatedAt: now - 4 * MINUTE,
      lastUserTouchAt: now - 30 * MINUTE,
      nextStep: 'Make the hours summary and invoice',
    }),
    work({
      _id: ids.dentist,
      title: 'Book the dentist appointment',
      updatedAt: now - 12 * MINUTE,
      lastUserTouchAt: now - 2 * HOUR,
      nextStep: 'Confirm the slot',
    }),
    work({
      _id: ids.passport,
      title: 'Order a new passport photo',
      primaryAreaId: 'area_travel',
      areaName: 'Travel',
      updatedAt: now - 26 * HOUR,
      lastUserTouchAt: now - 20 * HOUR,
      nextStep: 'Order the photo',
    }),
    work({
      _id: ids.car,
      title: 'Renew the car registration',
      updatedAt: now - 2 * MINUTE,
      lastUserTouchAt: now - 3 * MINUTE,
      nextStep: 'Renew online',
    }),
    work({
      _id: ids.water,
      title: 'Pay the water bill',
      primaryAreaId: 'area_money',
      areaName: 'Money',
      updatedAt: now - MINUTE,
      lastUserTouchAt: now - 5 * MINUTE,
      nextStep: 'Pay the bill',
    }),
    work({
      _id: ids.lease,
      title: 'Reply to Sam Rivera about the lease',
      updatedAt: now - 2 * MINUTE,
      lastUserTouchAt: now - 2 * MINUTE,
      nextStep: 'Reply to Sam',
    }),
    work({
      _id: ids.gym,
      title: 'Cancel the old gym membership',
      primaryAreaId: 'area_money',
      areaName: 'Money',
      updatedAt: now - 4 * MINUTE,
      lastUserTouchAt: now - 4 * MINUTE,
      nextStep: 'Cancel online',
    }),
    work({
      _id: ids.library,
      title: 'Return the library books',
      updatedAt: now - HOUR,
      lastUserTouchAt: now - 3 * HOUR,
      nextStep: 'Return the books by Oct 22',
    }),
    work({
      _id: ids.recycling,
      title: 'Set up the recycling pickup',
      updatedAt: now - 3 * 24 * HOUR,
      lastUserTouchAt: now - 3 * 24 * HOUR,
      nextStep: 'Call the county line, 555-0144',
    }),
    work({
      _id: ids.insurance,
      title: 'Compare the two car insurance quotes',
      primaryAreaId: 'area_money',
      areaName: 'Money',
      updatedAt: now - 5 * 24 * HOUR,
      lastUserTouchAt: now - 5 * 24 * HOUR,
      nextStep: 'Read both quotes side by side',
    }),
    work({
      _id: ids.taxes,
      title: 'File the property tax appeal',
      primaryAreaId: 'area_money',
      areaName: 'Money',
      workState: 'done',
      status: 'done',
      updatedAt: now - 6 * 24 * HOUR,
      lastUserTouchAt: now - 6 * 24 * HOUR,
    }),
  ];
  const activity: ThreadActivity = {
    now,
    runs: {
      [ids.lisbon]: run({
        runId: 'run_lisbon',
        state: 'handed_off',
        outcome: 'needs_answer',
        stepTitle: 'Choose the dates',
        nextKind: 'answer',
        nextDetail: 'Which dates work?',
        summary: 'Found three date ranges that keep the Friday flight.',
        createdAt: now - 9 * MINUTE,
        updatedAt: now - 3 * MINUTE,
        finishedAt: now - 3 * MINUTE,
      }),
      [ids.invoice]: run({
        runId: 'run_invoice',
        state: 'handed_off',
        outcome: 'ready_for_you',
        stepTitle: 'Make the hours summary and invoice',
        nextKind: 'review_document',
        nextLabel: 'Fill in hours',
        nextDetail: 'Fill in the hours for each week, the hourly rate, and the invoice number.',
        nextBlanks: ['hours for each week', 'hourly rate', 'invoice number'],
        summary: 'Made the hours summary and the invoice from the template.',
        createdAt: now - 9 * MINUTE,
        updatedAt: now - 4 * MINUTE,
        finishedAt: now - 4 * MINUTE,
      }),
      [ids.dentist]: run({
        runId: 'run_dentist',
        state: 'handed_off',
        outcome: 'your_turn',
        stepTitle: 'Confirm the slot',
        nextKind: 'finish_on_page',
        nextDetail: 'Confirm the 9:30 slot on the page',
        createdAt: now - 20 * MINUTE,
        updatedAt: now - 12 * MINUTE,
        finishedAt: now - 12 * MINUTE,
      }),
      [ids.passport]: run({
        runId: 'run_passport',
        state: 'failed',
        stepTitle: 'Order the photo',
        error: 'The site did not load after three tries',
        createdAt: now - 27 * HOUR,
        updatedAt: now - 26 * HOUR,
        finishedAt: now - 26 * HOUR,
      }),
      [ids.car]: run({
        runId: 'run_car',
        state: 'running',
        stepTitle: 'Renew online',
        logLine: "Typed your saved Driver's license on dmv.ny.gov",
        startedAt: now - 72_000,
        createdAt: now - 80_000,
        updatedAt: now - 10_000,
      }),
      [ids.water]: run({
        runId: 'run_water',
        state: 'running',
        stepTitle: 'Pay the bill',
        logLine: 'Opened springfieldwater.example.gov',
        startedAt: now - 14 * MINUTE,
        createdAt: now - 14 * MINUTE,
        updatedAt: now - MINUTE,
      }),
      [ids.gym]: run({
        runId: 'run_gym',
        state: 'queued',
        stepTitle: 'Cancel online',
        createdAt: now - 4 * MINUTE,
        updatedAt: now - 4 * MINUTE,
      }),
      [ids.library]: run({
        runId: 'run_library',
        state: 'done',
        stepTitle: 'Renew the loan',
        summary: 'Due date moved to Oct 22',
        startedAt: now - 70 * MINUTE,
        createdAt: now - 70 * MINUTE,
        updatedAt: now - HOUR,
        finishedAt: now - HOUR,
      }),
      [ids.recycling]: run({
        runId: 'run_recycling',
        state: 'cancelled',
        stepTitle: 'Book the pickup',
        createdAt: now - 3 * 24 * HOUR,
        updatedAt: now - 3 * 24 * HOUR,
        finishedAt: now - 3 * 24 * HOUR,
      }),
    },
    threads: {
      [ids.lisbon]: state({ seenAt: now - 10 * MINUTE }),
      [ids.dentist]: state({ seenAt: now - 30 * MINUTE }),
      [ids.passport]: state({ seenAt: now - 20 * HOUR }),
      [ids.car]: state({ seenAt: now - 30_000 }),
      [ids.water]: state({ seenAt: now - 5 * MINUTE }),
      [ids.lease]: state({
        answering: true,
        answeringSince: now - 2 * MINUTE,
        replyPreview: 'What did Sam ask for in the last email?',
        seenAt: now - 2 * MINUTE,
      }),
      [ids.gym]: state({ seenAt: now - 4 * MINUTE }),
      [ids.library]: state({ seenAt: now - 3 * HOUR }),
      [ids.recycling]: state({ seenAt: now - 2 * 24 * HOUR }),
    },
  };
  return { works, activity, rows: buildThreadRows(works, activity) };
}
