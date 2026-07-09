import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ONBOARDING_KIND = 'prefs';
const ONBOARDING_KEY = 'albatross-area-onboarding';

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* One fetch-friendly seam for the area onboarding wizard, usable from /welcome,
 * Settings, and the app shell alike (no Convex provider needed client-side).
 * Facts the user types about themselves in the wizard are verified WITH a user
 * confirmation ref — that is the explicit confirmation the trust model
 * requires; everything inferred stays candidate. */

export async function GET() {
  try {
    const user = await requireCurrentUser();
    await convexMutation((api as any).albatross.ensurePersonal, { userId: user.userId }).catch(() => null);
    const [areas, onboarding] = await Promise.all([
      convexQuery<any[]>((api as any).albatross.listAreas, { userId: user.userId, status: 'active' }),
      convexQuery<any>((api as any).userData.getDoc, {
        userId: user.userId,
        kind: ONBOARDING_KIND,
        key: ONBOARDING_KEY,
      }),
    ]);
    return json(200, { ok: true, areas, onboarding: onboarding?.doc ?? null });
  } catch (err: any) {
    if (err instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    console.error('[albatross-areas-route]', err?.message || err);
    return json(500, { ok: false, error: err?.message || 'areas lookup failed' });
  }
}

type Action =
  | {
      action: 'create_area';
      name: string;
      kind?: string;
      description?: string;
      priority?: number;
      primaryDomain?: string;
      faviconUrl?: string;
      imageUrl?: string;
    }
  | {
      action: 'update_area';
      areaId: string;
      name?: string;
      kind?: string;
      description?: string;
      priority?: number;
      primaryDomain?: string;
      faviconUrl?: string;
      imageUrl?: string;
    }
  | { action: 'archive_area'; areaId: string }
  | { action: 'reindex_areas'; areaId?: string }
  | {
      action: 'add_fact';
      areaId: string;
      kind: string;
      value: string;
      verified?: boolean;
      sourceRefs?: Array<{ kind: string; id: string; url?: string; label?: string }>;
    }
  | { action: 'complete_onboarding' }
  | { action: 'reset_onboarding' };

function userConfirmationRefs(userId: string, prompt: string) {
  return [
    {
      kind: 'userConfirmation',
      id: `area-onboarding:${userId}:${Date.now()}`,
      confirmedAt: Date.now(),
      confirmedBy: userId,
      prompt,
    },
  ];
}

export async function POST(req: NextRequest) {
  let body: Action;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross_areas',
      limit: 60,
      windowMs: 60_000,
    });
    const caller = { userId: user.userId };

    switch (body.action) {
      case 'create_area': {
        if (!body.name?.trim()) return json(400, { ok: false, error: 'name required' });
        const areaId = await convexMutation<string>((api as any).albatross.createArea, {
          ...caller,
          name: body.name.trim(),
          kind: body.kind,
          description: body.description,
          priority: body.priority,
          primaryDomain: body.primaryDomain,
          faviconUrl: body.faviconUrl,
          imageUrl: body.imageUrl,
        });
        return json(200, { ok: true, areaId });
      }
      case 'update_area': {
        if (!body.areaId) return json(400, { ok: false, error: 'areaId required' });
        await convexMutation((api as any).albatross.updateArea, {
          ...caller,
          areaId: body.areaId,
          name: body.name,
          kind: body.kind,
          description: body.description,
          priority: body.priority,
          primaryDomain: body.primaryDomain,
          faviconUrl: body.faviconUrl,
          imageUrl: body.imageUrl,
        });
        return json(200, { ok: true });
      }
      case 'archive_area': {
        if (!body.areaId) return json(400, { ok: false, error: 'areaId required' });
        await convexMutation((api as any).albatross.archiveArea, { ...caller, areaId: body.areaId });
        return json(200, { ok: true });
      }
      case 'reindex_areas': {
        await convexMutation((api as any).albatross.reindexMyAreas, { ...caller, areaId: body.areaId });
        return json(200, { ok: true });
      }
      case 'add_fact': {
        if (!body.areaId || !body.kind || !body.value?.trim()) {
          return json(400, { ok: false, error: 'areaId, kind, and value required' });
        }
        const verified = Boolean(body.verified);
        const factId = await convexMutation<string>((api as any).albatross.addAreaFact, {
          ...caller,
          areaId: body.areaId,
          kind: body.kind,
          value: body.value.trim(),
          status: verified ? 'verified' : 'candidate',
          sourceRefs: body.sourceRefs,
          ...(verified
            ? {
                confirmationRefs: userConfirmationRefs(
                  user.userId,
                  'Stated by the user in the area setup wizard.',
                ),
              }
            : {}),
        });
        return json(200, { ok: true, factId });
      }
      case 'complete_onboarding':
      case 'reset_onboarding': {
        await convexMutation((api as any).userData.upsertDoc, {
          userId: user.userId,
          kind: ONBOARDING_KIND,
          key: ONBOARDING_KEY,
          doc:
            body.action === 'complete_onboarding'
              ? { completedAt: Date.now() }
              : { completedAt: null, resetAt: Date.now() },
        });
        return json(200, { ok: true });
      }
      default:
        return json(400, { ok: false, error: 'unknown action' });
    }
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitResponse(err);
    if (err instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    console.error('[albatross-areas-route]', err?.message || err);
    return json(500, { ok: false, error: err?.message || 'area action failed' });
  }
}
