import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const taskDraftSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(2_000).default(''),
  priority: z.enum(['low', 'medium', 'high']).nullable(),
  dueIso: z.string().datetime().nullable(),
});

interface TaskAutofillDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  generateObjectForCurrentUser: typeof generateObjectForCurrentUser;
  now: () => Date;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: TaskAutofillDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  generateObjectForCurrentUser,
  now: () => new Date(),
  reportUnexpectedError: (error) => console.error('Task autofill failed.', error),
};

function validatedTimezone(value: string | null) {
  const timezone = String(value || '').trim();
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return 'UTC';
  }
}

function localReferenceTime(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).format(date);
}

export function createTaskAutofillPost(deps: TaskAutofillDependencies = defaultDependencies) {
  return async function taskAutofillPost(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'task-autofill',
        limit: 20,
        windowMs: 60_000,
      });
      const body = await req.json().catch(() => ({}));
      const rough = String(body?.rough || '').trim();
      if (!rough) {
        return NextResponse.json({ ok: false, error: 'Describe the task first.' }, { status: 400 });
      }
      const timezone = validatedTimezone(req.headers.get('x-user-timezone'));
      const { object } = await deps.generateObjectForCurrentUser<z.infer<typeof taskDraftSchema>>({
        userId: user.userId,
        feature: 'task_autofill',
        speed: 'fast',
        schema: taskDraftSchema,
        system:
          'Turn rough task language into editable task metadata. Do not claim the task was created. Infer a due date only when the user supplied a clear time window.',
        prompt: `Current time in ${timezone}: ${localReferenceTime(deps.now(), timezone)}\nRough task:\n${rough}`,
      });
      return NextResponse.json({ ok: true, draft: taskDraftSchema.parse(object) });
    } catch (error: unknown) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      deps.reportUnexpectedError(error);
      return NextResponse.json({ ok: false, error: 'Autofill failed.' }, { status: 500 });
    }
  };
}

export const POST = createTaskAutofillPost();
