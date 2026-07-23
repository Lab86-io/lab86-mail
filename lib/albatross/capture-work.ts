import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { captureFallbackItem, parseWorkSplit } from '@/lib/albatross/work-v2';
import type { CurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

export interface CaptureWorkInput {
  rawText: string;
  transcript?: string;
  source: 'text' | 'voice' | 'chat';
  areaId?: string;
  reviewedItems?: Array<{ title: string; rawText: string }>;
}

export interface CaptureWorkResult {
  captureId: string;
  status: 'split';
  workIds: string[];
  fallback?: boolean;
}

interface CaptureWorkDependencies {
  generate: typeof generateTextForCurrentUser;
  mutate: typeof convexMutation;
  query: typeof convexQuery;
}

const defaultDependencies: CaptureWorkDependencies = {
  generate: generateTextForCurrentUser,
  mutate: convexMutation,
  query: convexQuery,
};

function normalizedName(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function captureWork(
  input: CaptureWorkInput,
  user: CurrentUser,
  dependencies: CaptureWorkDependencies = defaultDependencies,
): Promise<CaptureWorkResult> {
  const rawText = input.rawText.trim();
  if (!rawText) throw new Error('rawText required');
  const captureId = await dependencies.mutate<string>((api as any).albatrossWorkV2.beginCapture, {
    userId: user.userId,
    rawText,
    transcript: input.transcript,
    source: input.source,
  });
  try {
    if (input.reviewedItems?.length) {
      const items = input.reviewedItems.slice(0, 20).map((item) => ({
        title:
          String(item.title || '')
            .trim()
            .slice(0, 180) || 'Work',
        rawText: String(item.rawText || '')
          .trim()
          .slice(0, 20_000),
        primaryAreaId: input.areaId || undefined,
        relatedAreaIds: [],
      }));
      if (items.some((item) => !item.rawText)) throw new Error('Reviewed Work cannot be empty.');
      const workIds = await dependencies.mutate<string[]>((api as any).albatrossWorkV2.finishCapture, {
        userId: user.userId,
        captureId,
        items,
      });
      return { captureId, status: 'split', workIds };
    }
    const [areas, facts] = await Promise.all([
      dependencies
        .query<any[]>((api as any).albatross.listAreas, { userId: user.userId, status: 'active' })
        .catch(() => []),
      dependencies
        .query<any[]>((api as any).albatross.listVerifiedFacts, { userId: user.userId })
        .catch(() => []),
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
    const { text } = await dependencies.generate({
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
    const requestedArea = input.areaId
      ? areas.find((area) => String(area._id) === String(input.areaId))
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
    const workIds = await dependencies.mutate<string[]>((api as any).albatrossWorkV2.finishCapture, {
      userId: user.userId,
      captureId,
      items,
    });
    return { captureId, status: 'split', workIds };
  } catch (error) {
    // Raw input is never lost. A model or Area lookup failure commits one
    // verbatim Work item and lets the normal advancement path continue.
    const workIds = await dependencies
      .mutate<string[]>((api as any).albatrossWorkV2.finishCapture, {
        userId: user.userId,
        captureId,
        items: [captureFallbackItem(rawText, input.areaId)],
      })
      .catch(async () => {
        await dependencies.mutate((api as any).albatrossWorkV2.failCapture, {
          userId: user.userId,
          captureId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    return { captureId, status: 'split', workIds, fallback: true };
  }
}
