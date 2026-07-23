import { NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'compose-draft',
      limit: 20,
      windowMs: 60_000,
    });
    const input = await req.json().catch(() => ({}));
    const to = String(input?.to || '').trim();
    const subject = String(input?.subject || '').trim();
    const instructions = String(input?.instructions || '').trim();
    if (!to && !subject && !instructions) {
      return NextResponse.json(
        { ok: false, error: 'Add a recipient, subject, or drafting instruction first.' },
        { status: 400 },
      );
    }
    const { text } = await runWithAiRequestContext(
      {
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        agent: 'user',
      },
      () =>
        generateTextForCurrentUser({
          feature: 'compose_draft',
          speed: 'fast',
          system:
            'Draft editable email body copy for the user. Never send, promise a send, invent facts, or include a subject line. Return only the body.',
          prompt: [
            to ? `Recipient: ${to}` : '',
            subject ? `Subject: ${subject}` : '',
            instructions ? `User notes or existing draft: ${instructions}` : '',
            'Write concise, reviewable body copy and preserve uncertainty.',
          ]
            .filter(Boolean)
            .join('\n'),
        }),
    );
    const draft = text.trim();
    if (!draft) {
      return NextResponse.json({ ok: false, error: 'Albatross returned an empty draft.' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, draft });
  } catch (error: any) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: error?.message || 'Drafting failed.' }, { status });
  }
}
