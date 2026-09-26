/**
 * Plain labels for the classification details in the reader. Raw purpose
 * values never reach the user; the prefix is the selected classifier's label.
 */
export const MAIL_PURPOSE_LABELS: Record<string, string> = {
  conversation: 'Conversation',
  promotion: 'Promotion',
  newsletter: 'Newsletter',
  transaction: 'Receipt',
  unknown: 'Unclear',
};

export function mailSortingLine(
  assessment: { purpose: string; status?: string },
  source = 'Classification',
): string {
  const purpose = MAIL_PURPOSE_LABELS[assessment.purpose] ?? 'Unclear';
  const state = assessment.status === 'uncertain' ? 'More context may be needed' : 'Classified';
  return `${source} · ${purpose} · ${state}`;
}
