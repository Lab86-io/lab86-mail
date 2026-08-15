/** Server-to-Convex caller identity for authenticated check-in routes. */
export function checkinCallerArgs(userId: string) {
  const normalized = userId.trim();
  if (!normalized) throw new Error('userId is required.');
  return { userId: normalized };
}

export function tomorrowWorkPlanStatus(
  detail: {
    plan?: { status?: string } | null;
    questions?: Array<{ status?: string }>;
  } | null,
): 'advance' | 'needs_input' | 'already_applied' {
  if ((detail?.questions || []).some((question) => question.status === 'pending')) return 'needs_input';
  if (detail?.plan?.status === 'applied') return 'already_applied';
  return 'advance';
}
