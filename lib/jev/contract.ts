import { z } from 'zod';

export const JEV_VERSION = 1;
export const JEV_QUESTION_VERSION = 'mail-1';

export const jevPreferencesSchema = z
  .object({
    enabled: z.boolean().default(true),
    briefNewsletters: z.boolean().default(false),
    briefPromotions: z.boolean().default(false),
    briefAccountChanges: z.boolean().default(true),
    searchRelevance: z.boolean().default(true),
    showExplanations: z.boolean().default(true),
    followUpDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14)]).default(3),
  })
  .strict();
export type JevPreferences = z.infer<typeof jevPreferencesSchema>;
export const DEFAULT_JEV_PREFERENCES = jevPreferencesSchema.parse({});
export function normalizeJevPreferences(value: unknown): JevPreferences {
  const parsed = jevPreferencesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_JEV_PREFERENCES };
}

export const purposeSchema = z.enum(['conversation', 'promotion', 'newsletter', 'transaction', 'unknown']);
export const subjectKindSchema = z.enum(['general', 'code', 'order', 'finance', 'booking', 'account']);
export const evidenceSchema = z.object({
  messageId: z.string().min(1),
  text: z.string().min(1).max(2400),
});
/**
 * Jev's answer to the `due` question (Needs you): when the owner must act, by
 * the evidence. `soon` is the next three days. An assessment stored before
 * the question existed has no value; read it as `none`.
 */
export const dueSchema = z.enum(['today', 'soon', 'later', 'none']);
export type JevDue = z.infer<typeof dueSchema>;
export const obligationSchema = z.object({
  kind: z.enum(['reply', 'action', 'waiting']),
  evidence: evidenceSchema,
  probability: z.number().min(0).max(1),
});
export const jevAssessmentSchema = z.object({
  version: z.literal(JEV_VERSION),
  questionVersion: z.literal(JEV_QUESTION_VERSION),
  sourceMessageId: z.string().min(1),
  sourceRevision: z.string().min(1),
  evaluatedAt: z.number().finite(),
  model: z.string().min(1),
  status: z.enum(['accepted', 'uncertain']),
  purpose: purposeSchema,
  subjectKind: subjectKindSchema,
  confidence: z.number().min(0).max(1),
  obligations: z.array(obligationSchema).max(3),
  meaningfulChange: z.boolean(),
  changeEvidence: evidenceSchema.optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  contextComplete: z.boolean(),
  sender: z.string().optional(),
  listId: z.string().optional(),
  due: dueSchema.optional(),
});
export type JevAssessment = z.infer<typeof jevAssessmentSchema>;
export type JevObligation = z.infer<typeof obligationSchema>;
/**
 * The part of an assessment that the live brief refresh (projectBriefMail)
 * reads from a stored brief item: the revision it compares, the change flag,
 * and the kind of each obligation. Overflow items store only this.
 */
export type JevBriefDigest = Pick<JevAssessment, 'sourceRevision' | 'meaningfulChange'> & {
  obligations: Array<Pick<JevObligation, 'kind'>>;
};
export const ATTENTION_VIEWS = ['needs_reply', 'needs_action', 'waiting_for', 'important_changes'] as const;
export type AttentionView = (typeof ATTENTION_VIEWS)[number];
export function isAttentionView(value: string): value is AttentionView {
  return ATTENTION_VIEWS.some((view) => view === value);
}
export function assessmentIsCurrent(
  assessment: unknown,
  messageId?: string,
  revision?: string,
): assessment is JevAssessment {
  const parsed = jevAssessmentSchema.safeParse(assessment);
  return (
    parsed.success &&
    parsed.data.sourceMessageId === messageId &&
    (!revision || parsed.data.sourceRevision === revision)
  );
}
export function hasObligation(
  assessment: Pick<JevBriefDigest, 'obligations'> | null | undefined,
  kind: JevObligation['kind'],
) {
  return Boolean(assessment?.obligations.some((item) => item.kind === kind));
}
/** The `due` answer of an assessment. An older assessment without it is `none`. */
export function assessmentDue(assessment: Pick<JevAssessment, 'due'> | null | undefined): JevDue {
  return assessment?.due ?? 'none';
}
/**
 * The key of Jev's `routine_notice` answer in `probabilities` (Needs you,
 * phase 1.1). The question is optional: it does not change the question
 * version, so an assessment stored before it has no value.
 */
export const ROUTINE_NOTICE_QUESTION = 'routine_notice';
/** The `routine_notice` probability, or undefined for an assessment from before the question. */
export function routineNoticeProbability(
  assessment: Pick<JevAssessment, 'probabilities'> | null | undefined,
): number | undefined {
  const value = assessment?.probabilities?.[ROUTINE_NOTICE_QUESTION];
  return typeof value === 'number' ? value : undefined;
}
export function attentionMatches(assessment: JevAssessment | null | undefined, view: AttentionView) {
  if (!assessment) return false;
  if (view === 'important_changes') return assessment.meaningfulChange;
  return hasObligation(
    assessment,
    view === 'needs_reply' ? 'reply' : view === 'needs_action' ? 'action' : 'waiting',
  );
}
export function jevReason(assessment: JevAssessment): string {
  if (hasObligation(assessment, 'reply')) return 'An unresolved request needs your reply.';
  if (hasObligation(assessment, 'action')) return 'You have an unfinished action in this conversation.';
  if (assessment.meaningfulChange) return 'Something changed in an existing account, booking, or commitment.';
  if (hasObligation(assessment, 'waiting')) return 'You are waiting for a response or promised work.';
  if (assessment.purpose === 'promotion') return 'An optional promotion or invitation.';
  if (assessment.purpose === 'newsletter') return 'An informational newsletter without a personal request.';
  if (assessment.purpose === 'transaction') return 'A routine receipt or account update.';
  if (assessment.status === 'uncertain') return 'More context is needed to determine what needs attention.';
  return 'No unresolved action is established in this conversation.';
}

export const jevCorrectionSchema = z
  .object({
    id: z.string().min(1).max(200),
    scope: z.enum(['sender', 'list', 'thread']),
    match: z.string().trim().min(1).max(500),
    accountId: z.string().max(200).optional(),
    brief: z.enum(['include', 'exclude']),
  })
  .strict();
export type JevCorrection = z.infer<typeof jevCorrectionSchema>;
export function correctionForMail(
  corrections: JevCorrection[],
  input: { accountId: string; threadId: string; sender: string; listId?: string },
) {
  const rank = { thread: 3, list: 2, sender: 1 };
  return corrections
    .filter(
      (rule) =>
        (!rule.accountId || rule.accountId === input.accountId) &&
        (rule.scope === 'thread'
          ? rule.match === input.threadId
          : rule.match.toLowerCase() ===
            (rule.scope === 'list' ? input.listId || '' : input.sender).toLowerCase()),
    )
    .sort(
      (a, b) =>
        rank[b.scope] - rank[a.scope] ||
        Number(b.brief === 'exclude') - Number(a.brief === 'exclude') ||
        a.id.localeCompare(b.id),
    )[0];
}
