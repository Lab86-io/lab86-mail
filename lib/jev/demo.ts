import { z } from 'zod';
import { classifyThreadDeterministic, SMART_CATEGORY_LABELS } from '../mail/smart-categories';
import { briefAttention } from './brief';
import { type JevResponse } from './client';
import { type JevPreferences, jevReason } from './contract';
import { assessmentFromResponse, type JevMailInput, mailSourceRevision, smartCategoryFromJev } from './mail';

export const jevDemoInputSchema = z
  .object({
    sender: z.string().email().max(254),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(2400),
    reply: z.string().trim().max(2400).default(''),
  })
  .strict();
export type JevDemoInput = z.infer<typeof jevDemoInputSchema>;

export const JEV_DEMO_EXAMPLES: Array<{ id: string; label: string; input: JevDemoInput }> = [
  {
    id: 'promotion',
    label: 'Athletics promotion',
    input: {
      sender: 'athletics@university.test',
      subject: 'Tickets for Saturday’s game',
      body: 'Syracuse Athletics: Tickets on sale for Saturday. Get your seats now! You receive these promotional announcements as a subscriber. Unsubscribe.',
      reply: '',
    },
  },
  {
    id: 'approval',
    label: 'Personal approval request',
    input: {
      sender: 'maya@university.test',
      subject: 'Revised budget approval',
      body: 'Can you confirm approval of the revised university budget by Friday?',
      reply: '',
    },
  },
  {
    id: 'resolved',
    label: 'Request already answered',
    input: {
      sender: 'maya@university.test',
      subject: 'Revised budget approval',
      body: 'Can you confirm approval of the revised university budget by Friday?',
      reply: 'Approved, please proceed.',
    },
  },
  {
    id: 'cancellation',
    label: 'Purchased ticket cancelled',
    input: {
      sender: 'tickets@rail.test',
      subject: 'Your train has been cancelled',
      body: 'Your purchased train ticket TKT-482 for the 10:00 service has been cancelled. Your refund has been issued automatically; no action is needed.',
      reply: '',
    },
  },
];

export function demoMailInput(input: JevDemoInput, now: number): JevMailInput {
  const owner = 'mailbox-owner@example.test';
  const messages = [
    {
      id: 'demo-incoming',
      from: input.sender,
      to: owner,
      subject: input.subject,
      body: input.body,
      date: now,
    },
  ];
  if (input.reply)
    messages.push({
      id: 'demo-reply',
      from: owner,
      to: input.sender,
      subject: input.subject,
      body: input.reply,
      date: now + 1,
    });
  return {
    accountId: 'demo',
    threadId: 'demo',
    messageId: messages.at(-1)!.id,
    sourceRevision: mailSourceRevision(messages),
    selfAddresses: [owner],
    messages,
    contextComplete: true,
  };
}

export function demoResult(
  input: JevMailInput,
  response: JevResponse,
  preferences: JevPreferences,
  inferenceMs: number,
  now: number,
) {
  const assessment = assessmentFromResponse(input, response, now);
  const last = input.messages.at(-1)!;
  const local = classifyThreadDeterministic({
    _id: input.threadId,
    subject: last.subject,
    fromAddress: last.from,
    snippet: last.body,
    unread: true,
    labels: ['INBOX'],
  });
  const category = smartCategoryFromJev(assessment, local, true);
  const brief = briefAttention({
    assessment,
    smart: category,
    preferences,
    now,
    waitingSince: last.date,
    fallbackReply: false,
    tracked: false,
  });
  return {
    model: response.model,
    inferenceMs,
    category: SMART_CATEGORY_LABELS[category.primary],
    reason: jevReason(assessment),
    status: assessment.status,
    purpose: assessment.purpose,
    obligations: assessment.obligations.map((item) => item.kind),
    meaningfulChange: assessment.meaningfulChange,
    briefEligible: brief.eligible,
    evidence: [
      ...new Set([
        ...assessment.obligations.map((item) => item.evidence.text),
        ...(assessment.changeEvidence ? [assessment.changeEvidence.text] : []),
      ]),
    ],
  };
}
export type JevDemoResult = ReturnType<typeof demoResult>;
