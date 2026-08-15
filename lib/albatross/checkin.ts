import { z } from 'zod';

export { checkinRetryDelayMs } from './retry';

/** Server-to-Convex caller identity for authenticated check-in routes. */
export function checkinCallerArgs(userId: string) {
  const normalized = userId.trim();
  if (!normalized) throw new Error('userId is required.');
  return { userId: normalized };
}

const completionSchema = z.object({
  kind: z.string().transform((value) => value.trim().slice(0, 40)),
  id: z.string().transform((value) => value.trim().slice(0, 160)),
});

const reconciliationSchema = z.object({
  completed: z
    .array(z.unknown())
    .default([])
    .transform((rows) =>
      rows.slice(0, 60).flatMap((row) => {
        const parsed = completionSchema.safeParse(row);
        return parsed.success && parsed.data.kind && parsed.data.id ? [parsed.data] : [];
      }),
    ),
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
