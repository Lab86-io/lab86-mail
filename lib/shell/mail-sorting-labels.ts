/**
 * Plain labels for the mail sorting details in the reader. The internal
 * classifier name and raw purpose values never reach the user.
 */
export const MAIL_PURPOSE_LABELS: Record<string, string> = {
  conversation: 'Conversation',
  promotion: 'Promotion',
  newsletter: 'Newsletter',
  transaction: 'Receipt',
  unknown: 'Unclear',
};

export function mailSortingLine(assessment: { purpose: string; status?: string }): string {
  const purpose = MAIL_PURPOSE_LABELS[assessment.purpose] ?? 'Unclear';
  const state = assessment.status === 'uncertain' ? 'More context may be needed' : 'Sorted';
  return `Mail sorting · ${purpose} · ${state}`;
}
