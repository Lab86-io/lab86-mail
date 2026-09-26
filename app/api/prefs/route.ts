import { NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { DEFAULT_UNDO_SEND_SECONDS, normalizeUndoSendSeconds } from '@/lib/shared/sending';
import { getModelPins, setModelPins } from '@/lib/store/model-pins';
import { getPref, setPref } from '@/lib/store/prefs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNDO_SEND_PREF = 'undoSendSeconds';

interface PrefsDependencies {
  requireCurrentUser: typeof requireCurrentUser;
}

const defaults: PrefsDependencies = { requireCurrentUser };

/**
 * Per-user preferences for web and native. `pinnedModels` is the list of
 * pinned models in the model picker; a POST replaces the whole list.
 */
export function createPrefsRoute(overrides: Partial<PrefsDependencies> = {}) {
  const deps: PrefsDependencies = { ...defaults, ...overrides };

  async function GET() {
    try {
      const user = await deps.requireCurrentUser();
      const prefs = await runWithAiRequestContext(
        { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
        async () => {
          const [raw, pinnedModels] = await Promise.all([getPref(UNDO_SEND_PREF), getModelPins()]);
          return {
            undoSendSeconds: raw === null ? DEFAULT_UNDO_SEND_SECONDS : normalizeUndoSendSeconds(raw),
            pinnedModels,
          };
        },
      );
      return NextResponse.json({ ok: true, prefs });
    } catch (err: any) {
      const status = err instanceof AuthRequiredError ? 401 : 500;
      return NextResponse.json({ ok: false, error: err?.message || 'prefs failed' }, { status });
    }
  }

  async function POST(req: NextRequest) {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: 'Malformed JSON in request body' }, { status: 400 });
    }
    if (body?.pinnedModels !== undefined && !Array.isArray(body.pinnedModels)) {
      return NextResponse.json(
        { ok: false, error: 'pinnedModels must be a list of model ids.' },
        { status: 400 },
      );
    }
    try {
      const user = await deps.requireCurrentUser();
      const prefs = await runWithAiRequestContext(
        { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
        async () => {
          const next: { undoSendSeconds?: number; pinnedModels?: string[] } = {};
          if (body?.undoSendSeconds !== undefined) {
            const seconds = normalizeUndoSendSeconds(body.undoSendSeconds);
            await setPref(UNDO_SEND_PREF, String(seconds));
            next.undoSendSeconds = seconds;
          }
          if (body?.pinnedModels !== undefined) next.pinnedModels = await setModelPins(body.pinnedModels);
          return next;
        },
      );
      return NextResponse.json({ ok: true, prefs });
    } catch (err: any) {
      const status = err instanceof AuthRequiredError ? 401 : 500;
      return NextResponse.json({ ok: false, error: err?.message || 'prefs failed' }, { status });
    }
  }

  return { GET, POST };
}

const route = createPrefsRoute();
export const GET = route.GET;
export const POST = route.POST;
