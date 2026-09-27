import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getAiRequestContext, runWithAiRequestContext } from '../ai/context';
import { recordOperation, registerUndoExecutor } from '../ai/operations';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import type { JevCorrection } from '../jev/contract';
import { emailFromHeader } from '../shared/format';
import { truncateText } from '../shared/text';
import { dismissDailyReportThread, restoreDailyReportThread } from '../store/daily-report-dismissals';

// Per-item steering (FEATURES item 8). Each Brief item offers "Not for me",
// "Less from this sender", and "Keep showing". They map onto Jev brief
// corrections, the same rules Settings > Classification edits:
//   not_for_me        thread correction, exclude, and the item leaves the live edition
//   less_from_sender  sender correction, exclude, and the item leaves the live edition
//   keep_showing      thread correction, include: read or handled, it stays
// Each choice is a logged operation with an inverse, so Activity shows it
// with Undo.

export const BRIEF_STEERING_MODES = ['not_for_me', 'less_from_sender', 'keep_showing'] as const;
export type BriefSteeringMode = (typeof BRIEF_STEERING_MODES)[number];

export const BRIEF_STEERING_LABELS: Record<BriefSteeringMode, string> = {
  not_for_me: 'Not for me',
  less_from_sender: 'Less from this sender',
  keep_showing: 'Keep showing',
};

export const BRIEF_STEER_UNDO_KIND = 'brief.steer';

export const steerBriefItemInputSchema = z
  .object({
    mode: z.enum(BRIEF_STEERING_MODES),
    account: z.string().trim().min(1).max(320),
    threadId: z.string().trim().min(1).max(240),
    subject: z.string().max(500).optional(),
    senderEmail: z.string().max(320).optional(),
    receivedAt: z.number().nullable().optional(),
  })
  .strict();
export type SteerBriefItemInput = z.infer<typeof steerBriefItemInputSchema>;

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** One correction id per thread, so Keep showing replaces Not for me. */
export function briefThreadCorrectionId(account: string, threadId: string) {
  return `brief-thread-${shortHash(`${account}\u0000${threadId}`)}`;
}

export function briefSenderCorrectionId(sender: string) {
  return `brief-sender-${shortHash(sender.toLowerCase())}`;
}

function validSender(value: string | null | undefined): string | null {
  const email = (emailFromHeader(String(value || '')) || String(value || '')).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function briefSteeringCorrection(
  input: Pick<SteerBriefItemInput, 'mode' | 'account' | 'threadId'>,
  sender: string | null,
): JevCorrection {
  if (input.mode === 'less_from_sender') {
    if (!sender) throw new Error('Albatross could not tell who sent this conversation.');
    return { id: briefSenderCorrectionId(sender), scope: 'sender', match: sender, brief: 'exclude' };
  }
  return {
    id: briefThreadCorrectionId(input.account, input.threadId),
    scope: 'thread',
    match: input.threadId,
    accountId: input.account,
    brief: input.mode === 'keep_showing' ? 'include' : 'exclude',
  };
}

function quoted(subject: string | undefined) {
  const text = String(subject || '').trim();
  return text ? `“${truncateText(text, 120)}”` : 'this conversation';
}

export function briefSteeringSummary(input: SteerBriefItemInput, sender: string | null) {
  if (input.mode === 'not_for_me') return `Kept ${quoted(input.subject)} out of the brief`;
  if (input.mode === 'keep_showing') return `Kept ${quoted(input.subject)} in the brief until you change it`;
  return `Showing less from ${sender} in the brief`;
}

interface SteeringInverse {
  correctionId: string;
  previous: JevCorrection | null;
  account: string;
  threadId: string;
  dismissed: boolean;
}

const defaults = {
  setCorrection: (userId: string, id: string, correction: JevCorrection | null) =>
    convexMutation<{ previous: JevCorrection | null }>(api.dailyReports.setBriefCorrection, {
      userId,
      id,
      correction,
    }),
  // The Jev sender of the conversation, never the user's own address.
  lookupSender: async (userId: string, account: string, threadId: string) => {
    const [threads, accounts] = await Promise.all([
      convexQuery<any[]>(api.jev.threadAssessments, {
        userId,
        threads: [{ accountId: account, threadId }],
      }),
      convexQuery<Array<{ email: string }>>(api.accounts.listConnectedAccounts, { userId }),
    ]);
    const self = new Set((accounts || []).map((row) => String(row.email || '').toLowerCase()));
    const thread = threads?.[0];
    for (const candidate of [thread?.jev?.sender, thread?.fromAddress]) {
      const email = validSender(candidate);
      if (email && !self.has(email)) return email;
    }
    return null;
  },
  dismiss: dismissDailyReportThread,
  restore: restoreDailyReportThread,
  record: recordOperation,
};

export type BriefSteeringDependencies = typeof defaults;

export async function steerBriefItem(
  userId: string,
  raw: SteerBriefItemInput,
  deps: BriefSteeringDependencies = defaults,
) {
  const input = steerBriefItemInputSchema.parse(raw);
  const sender =
    input.mode === 'less_from_sender'
      ? (validSender(input.senderEmail) ?? (await deps.lookupSender(userId, input.account, input.threadId)))
      : null;
  const correction = briefSteeringCorrection(input, sender);
  const { previous } = await deps.setCorrection(userId, correction.id, correction);
  // The item leaves the live edition now; the correction keeps it out of the
  // next ones.
  const dismissed = input.mode !== 'keep_showing';
  if (dismissed)
    await runWithAiRequestContext({ ...getAiRequestContext(), userId }, () =>
      deps.dismiss({
        account: input.account,
        threadId: input.threadId,
        subject: input.subject,
        receivedAt: input.receivedAt ?? null,
        action: 'dismissed',
      }),
    );
  const summary = briefSteeringSummary(input, sender);
  const inverse: SteeringInverse = {
    correctionId: correction.id,
    previous,
    account: input.account,
    threadId: input.threadId,
    dismissed,
  };
  const operationId = await deps.record({
    userId,
    agent: 'user',
    tool: 'steer_brief_item',
    surface: 'mail',
    summary,
    target: {
      account: input.account,
      threadId: input.threadId,
      mode: input.mode,
      correctionId: correction.id,
    },
    inverse: { kind: BRIEF_STEER_UNDO_KIND, payload: inverse },
  });
  return { ok: true as const, mode: input.mode, operationId, correction, summary };
}

/** Puts the correction and the live item back as they were. */
export async function undoBriefSteering(
  payload: SteeringInverse,
  userId: string,
  deps: Pick<BriefSteeringDependencies, 'setCorrection' | 'restore'> = defaults,
) {
  await deps.setCorrection(userId, payload.correctionId, payload.previous ?? null);
  if (payload.dismissed)
    await runWithAiRequestContext({ userId }, () =>
      deps.restore({ account: payload.account, threadId: payload.threadId }),
    );
}

registerUndoExecutor(BRIEF_STEER_UNDO_KIND, (payload, ctx) => undoBriefSteering(payload, ctx.userId));
