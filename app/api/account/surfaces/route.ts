import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { resolveSurfaces, setFilesSurface } from '@/lib/hosted/surfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { requireCurrentUser, resolveSurfaces, setFilesSurface };

/**
 * Optional surfaces (Settings, Advanced) for web, iOS, and macOS.
 *
 * GET  → { ok: true, surfaces: { files: boolean } }
 * POST { files: boolean } → { ok: true, surfaces: { files: boolean } }
 */
export function createSurfacesRoute(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };

  function failure(err: unknown) {
    if (err instanceof AuthRequiredError)
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    console.error('[account/surfaces] failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ ok: false, error: 'Could not load your surfaces.' }, { status: 500 });
  }

  async function GET() {
    try {
      const user = await deps.requireCurrentUser();
      return NextResponse.json({ ok: true, surfaces: await deps.resolveSurfaces(user.userId) });
    } catch (err) {
      return failure(err);
    }
  }

  async function POST(req: Request) {
    const body = await req.json().catch(() => null);
    if (typeof body?.files !== 'boolean')
      return NextResponse.json({ ok: false, error: 'files must be true or false.' }, { status: 400 });
    try {
      const user = await deps.requireCurrentUser();
      return NextResponse.json({ ok: true, surfaces: await deps.setFilesSurface(user.userId, body.files) });
    } catch (err) {
      return failure(err);
    }
  }

  return { GET, POST };
}

export const { GET, POST } = createSurfacesRoute();
