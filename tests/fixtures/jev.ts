import type { ClassifierResponse } from '../../lib/classifier/client';
import { DEFAULT_JEV_PREFERENCES, type JevAssessment } from '../../lib/jev/contract';
import { buildMailQuestions, type JevMailInput, mailSourceRevision } from '../../lib/jev/mail';
import type { DailyReport, DailyReportItem, Thread } from '../../lib/shared/types';

export const NOW = Date.parse('2026-09-21T12:00:00Z');
export function mailInput(body = 'Please confirm the budget by Friday.'): JevMailInput {
  const messages = [
    {
      id: 'm1',
      from: 'Maya <maya@university.test>',
      to: 'owner@example.test',
      subject: 'Budget approval',
      body,
      date: NOW,
      headers: {},
    },
  ];
  return {
    accountId: 'account-a',
    threadId: 'thread-a',
    messageId: 'm1',
    sourceRevision: mailSourceRevision(messages),
    selfAddresses: ['owner@example.test'],
    messages,
    contextComplete: true,
  };
}
export function responseFor(
  input: JevMailInput,
  choices: Record<string, string | number> = {},
): ClassifierResponse {
  return {
    model: 'typesafe/jev-1.13-20260917',
    answers: Object.fromEntries(
      Object.entries(buildMailQuestions(input)).map(([key, question]) => {
        if (question.type === 'noul')
          return [key, { type: 'noul', noul: choices[key] ?? (key === 'reply' ? 0.98 : 0.02) }];
        const choice = String(
          choices[key] ??
            (key === 'purpose'
              ? 'conversation'
              : key === 'subject_kind'
                ? 'general'
                : key === 'reply_evidence'
                  ? 'm0'
                  : 'none'),
        );
        return [
          key,
          {
            type: 'choice',
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((option) => [option, option === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
    usage: { input_tokens: 200, output_tokens: 0, cost: 0.0000084 },
  };
}
export function assessment(patch: Partial<JevAssessment> = {}): JevAssessment {
  const input = mailInput();
  return {
    version: 1,
    questionVersion: 'mail-1',
    sourceMessageId: 'm1',
    sourceRevision: input.sourceRevision,
    evaluatedAt: NOW,
    model: 'typesafe/jev-1.13-20260917',
    status: 'accepted',
    purpose: 'conversation',
    subjectKind: 'general',
    confidence: 0.99,
    obligations: [
      { kind: 'reply', evidence: { messageId: 'm1', text: input.messages[0].body }, probability: 0.98 },
    ],
    meaningfulChange: false,
    probabilities: { reply: 0.98, action: 0.02, waiting: 0.02, change: 0.02 },
    contextComplete: true,
    sender: 'maya@university.test',
    ...patch,
  };
}
export function thread(patch: Partial<Thread> = {}): Thread {
  return {
    _id: 'thread-a',
    account: 'account-a',
    subject: 'Budget approval',
    fromAddress: 'maya@university.test',
    lastDate: NOW,
    snippet: 'Please confirm the budget by Friday.',
    labels: ['INBOX'],
    unread: true,
    cachedAt: NOW,
    ...patch,
  };
}
export function reportItem(patch: Partial<DailyReportItem> = {}): DailyReportItem {
  return {
    account: 'account-a',
    threadId: 'thread-a',
    subject: 'Budget approval',
    people: ['Maya'],
    whyItMatters: 'Please reply.',
    nextAction: 'Reply to Maya.',
    unread: true,
    score: 9,
    budgetLane: 'answer',
    lane: 'reply_owed',
    receivedAt: NOW,
    jev: assessment(),
    ...patch,
  };
}
export function report(items: DailyReportItem[] = [reportItem()]): DailyReport {
  return {
    _id: 'brief-a',
    kind: 'morning',
    generatedAt: NOW,
    title: 'Monday Brief',
    accounts: ['account-a'],
    narrative: 'Please reply.',
    tier: 'pro',
    sections: {
      answer: items,
      today: [],
      know: [],
      overflow: [],
      replyOwed: items,
      followUpOwed: [],
      timeSensitive: [],
      tracked: [],
      newPeople: [],
      fyi: [],
      bulkTail: [],
    },
    stats: {
      scannedThreads: items.length,
      trackedThreads: 0,
      needsReply: items.length,
      replyOwed: items.length,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: items.length,
    },
    services: [],
    errors: [],
  };
}
export const policy = { preferences: DEFAULT_JEV_PREFERENCES, corrections: [], revision: 0 };
