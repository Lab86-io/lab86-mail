import { NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { DEFAULT_UNDO_SEND_SECONDS, normalizeUndoSendSeconds } from '@/lib/shared/sending';
import { getPref, setPref } from '@/lib/store/prefs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNDO_SEND_PREF = 'undoSendSeconds';

export async function GET() {
  try {
    const user = await requireCurrentUser();
    const prefs = await runWithAiRequestContext(
      { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
      async () => {
        const raw = await getPref(UNDO_SEND_PREF);
        return {
          undoSendSeconds: raw === null ? DEFAULT_UNDO_SEND_SECONDS : normalizeUndoSendSeconds(raw),
        };
      },
    );
    return NextResponse.json({ ok: true, prefs });
  } catch (err: any) {
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'prefs failed' }, { status });
  }
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  try {
    const user = await requireCurrentUser();
    const prefs = await runWithAiRequestContext(
      { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
      async () => {
        const next: Record<string, number> = {};
        if (body?.undoSendSeconds !== undefined) {
          const seconds = normalizeUndoSendSeconds(body.undoSendSeconds);
          await setPref(UNDO_SEND_PREF, String(seconds));
          next.undoSendSeconds = seconds;
        }
        return next;
      },
    );
    return NextResponse.json({ ok: true, prefs });
  } catch (err: any) {
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'prefs failed' }, { status });
  }
}
