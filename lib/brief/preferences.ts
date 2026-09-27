import type { FunctionReference } from 'convex/server';
import { z } from 'zod';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { transactionalEmailConfigured } from '../notifications/delivery';
import { BRIEF_DELIVERY_HOURS, BRIEF_WEEKEND_MODES, type BriefSchedule } from './schedule';

// The brief preferences (FEATURES items 3, 6, 9): the delivery hour, the
// weekend edition, the Sunday weekly review, and the edition by email. Web
// Settings and native read and save them through the brief preference tools.

export const BRIEF_EMAIL_UNAVAILABLE_REASON = 'Email delivery is not set up on this server yet.';

export interface BriefPreferences extends BriefSchedule {
  emailEnabled: boolean;
  /** The zone the brief follows, or null when no real zone is known yet. */
  timezone: string | null;
  email: { available: boolean; reason: string | null };
}

export const briefPreferencesInputSchema = z
  .object({
    deliveryHour: z
      .number()
      .int()
      .refine((hour) => (BRIEF_DELIVERY_HOURS as readonly number[]).includes(hour), {
        message: 'Pick an hour from 5 to 11.',
      })
      .optional(),
    weekendMode: z.enum(BRIEF_WEEKEND_MODES).optional(),
    weeklyReview: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
  })
  .strict();

export type BriefPreferencesInput = z.infer<typeof briefPreferencesInputSchema>;

// Read at call time, so a test can replace the hosted client.
const defaults = {
  query: <T>(fn: FunctionReference<'query', 'public'>, args: Record<string, unknown>) =>
    convexQuery<T>(fn, args),
  mutation: <T>(fn: FunctionReference<'mutation', 'public'>, args: Record<string, unknown>) =>
    convexMutation<T>(fn, args),
  emailConfigured: () => transactionalEmailConfigured(),
};

function emailState(configured: boolean) {
  return configured
    ? { available: true, reason: null }
    : { available: false, reason: BRIEF_EMAIL_UNAVAILABLE_REASON };
}

export async function loadBriefPreferences(userId: string, deps = defaults): Promise<BriefPreferences> {
  const stored = await deps.query<Omit<BriefPreferences, 'email'>>(api.dailyReports.briefPreferences, {
    userId,
  });
  const email = emailState(deps.emailConfigured());
  // An edition by email cannot go out without the email service, so the
  // stored choice reads as off until the service exists.
  return { ...stored, emailEnabled: email.available && stored.emailEnabled, email };
}

export async function saveBriefPreferences(
  userId: string,
  input: BriefPreferencesInput,
  options: { timezone?: string } = {},
  deps = defaults,
): Promise<BriefPreferences> {
  const parsed = briefPreferencesInputSchema.parse(input);
  const email = emailState(deps.emailConfigured());
  if (parsed.emailEnabled === true && !email.available) throw new Error(BRIEF_EMAIL_UNAVAILABLE_REASON);
  await deps.mutation(api.dailyReports.saveBriefPreferences, {
    userId,
    ...parsed,
    ...(options.timezone ? { timezone: options.timezone } : {}),
  });
  return loadBriefPreferences(userId, deps);
}
