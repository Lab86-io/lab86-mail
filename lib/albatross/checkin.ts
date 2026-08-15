import { z } from 'zod';

/** Server-to-Convex caller identity for authenticated check-in routes. */
export function checkinCallerArgs(userId: string) {
  const normalized = userId.trim();
  if (!normalized) throw new Error('userId is required.');
  return { userId: normalized };
}

const reconciliationSchema = z.object({
  completed: z
    .array(z.object({ kind: z.string(), id: z.string() }))
    .max(60)
    .default([]),
});

/** Parse the bounded JSON envelope returned by the background reflection pass. */
export function parseCheckinReconciliation(text: string) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return { completed: [] };
    const result = reconciliationSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return result.success ? result.data : { completed: [] };
  } catch {
    return { completed: [] };
  }
}

/** Back off quickly enough to help tomorrow, but never hot-loop a broken dependency. */
export function checkinRetryDelayMs(attempts: number) {
  const exponent = Math.min(Math.max(Math.floor(attempts) - 1, 0), 5);
  return Math.min(60 * 60_000, 2 ** exponent * 2 * 60_000);
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
