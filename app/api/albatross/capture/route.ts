import type { NextRequest } from 'next/server';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { captureFallbackItem, parseWorkSplit } from '@/lib/albatross/work-v2';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status });
}

function normalizedName(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function POST(req: NextRequest) {
  let body: {
    rawText?: string;
    transcript?: string;
    source?: 'text' | 'voice' | 'chat';
    timezone?: string;
    areaId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }
  const rawText = String(body.rawText || '').trim();
  if (!rawText) return json(400, { ok: false, error: 'rawText required' });
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-capture-v2',
      limit: 30,
      windowMs: 60_000,
    });
    const captureId = await convexMutation<string>((api as any).albatrossWorkV2.beginCapture, {
      userId: user.userId,
      rawText,
      transcript: body.transcript,
      source: body.source || 'text',
    });
    try {
      const [areas, facts] = await Promise.all([
        convexQuery<any[]>((api as any).albatross.listAreas, { userId: user.userId, status: 'active' }).catch(
          () => [],
        ),
        convexQuery<any[]>((api as any).albatross.listVerifiedFacts, { userId: user.userId }).catch(() => []),
      ]);
      const areaContext = areas.map((area) => ({
        name: area.name,
        kind: area.kind,
        description: area.description,
        facts: facts
          .filter((fact) => String(fact.areaId) === String(area._id))
          .slice(0, 10)
          .map((fact) => `${fact.kind}: ${fact.value}`),
      }));
      const { text } = await generateTextForCurrentUser({
        feature: 'albatross_capture_split',
        speed: 'fast',
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        system: `You split one unstructured brain dump into independent desired outcomes called Work.

Rules:
- Preserve the user's meaning and important detail. Never invent a goal.
- Split automatically when two parts can be completed, paused, or abandoned independently.
- Keep one outcome together when its steps serve the same definition of done.
- A title is short, concrete, and sentence case.
- Choose primaryAreaName only from the supplied active Areas when there is strong evidence. Otherwise null.
- relatedAreaNames may contain other supplied Areas that materially participate. Never invent an Area.
- Do not encode professions, companies, errands, or example-specific behavior in the split.

Return one JSON object only:
{"work":[{"title":string,"rawText":string,"primaryAreaName":string|null,"relatedAreaNames":string[]}]}`,
        prompt: `Active Areas:\n${JSON.stringify(areaContext, null, 2)}\n\nBrain dump:\n${rawText}`,
      });
      const split = parseWorkSplit(text, rawText);
      const areaByName = new Map(areas.map((area) => [normalizedName(area.name), area]));
      const requestedArea = body.areaId
        ? areas.find((area) => String(area._id) === String(body.areaId))
        : undefined;
      const items = split.work.map((item) => {
        const primary =
          requestedArea ||
          (item.primaryAreaName ? areaByName.get(normalizedName(item.primaryAreaName)) : undefined);
        const related = item.relatedAreaNames
          .map((name) => areaByName.get(normalizedName(name)))
          .filter((area): area is any => Boolean(area) && String(area._id) !== String(primary?._id));
        return {
          title: item.title,
          rawText: item.rawText,
          primaryAreaId: primary?._id,
          relatedAreaIds: [...new Set(related.map((area) => area._id))],
        };
      });
      const workIds = await convexMutation<string[]>((api as any).albatrossWorkV2.finishCapture, {
        userId: user.userId,
        captureId,
        items,
      });
      return json(200, { ok: true, captureId, status: 'split', workIds });
    } catch (error) {
      // Raw input is never lost. When the model or Area lookup fails, finalize
      // the capture as exactly one Work item and let normal advancement retry.
      const workIds = await convexMutation<string[]>((api as any).albatrossWorkV2.finishCapture, {
        userId: user.userId,
        captureId,
        items: [captureFallbackItem(rawText, body.areaId)],
      }).catch(async () => {
        await convexMutation((api as any).albatrossWorkV2.failCapture, {
          userId: user.userId,
          captureId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
      return json(200, { ok: true, captureId, status: 'split', workIds, fallback: true });
    }
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    return json(500, { ok: false, error: error instanceof Error ? error.message : 'capture failed' });
  }
}
