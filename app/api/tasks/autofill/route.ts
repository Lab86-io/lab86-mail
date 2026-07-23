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

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
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
    const { object } = await generateObjectForCurrentUser<z.infer<typeof taskDraftSchema>>({
      userId: user.userId,
      feature: 'task_autofill',
      speed: 'fast',
      schema: taskDraftSchema,
      system:
        'Turn rough task language into editable task metadata. Do not claim the task was created. Infer a due date only when the user supplied a clear time window.',
      prompt: `Current local time: ${new Date().toISOString()}\nRough task:\n${rough}`,
    });
    return NextResponse.json({ ok: true, draft: taskDraftSchema.parse(object) });
  } catch (error: any) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: error?.message || 'Autofill failed.' }, { status });
  }
}
