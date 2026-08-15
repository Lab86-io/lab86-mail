import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { WORK_SHAPE_GUIDE, WORK_SHAPES } from '@/lib/albatross/work-shape';
import { preserveCaptureText, titleFromWorkText } from '@/lib/albatross/work-v2';

/**
 * The nightly "tomorrow" answer is a brain dump, not one outcome. This module
 * splits it with the same contract as capture, and it reconciles the result
 * against the Works an earlier save of the same check-in already created.
 */

export interface TomorrowSiblingWork {
  workId: string;
  title: string;
  started: boolean;
}

export const tomorrowSplitSchema = z.object({
  work: z
    .array(
      z.object({
        title: z.string().min(1).max(180),
        rawText: z.string().min(1).max(20_000),
        existingWorkId: z.string().max(160).nullish(),
        shape: z.enum(WORK_SHAPES).optional().catch(undefined),
      }),
    )
    .min(1)
    .max(12),
});

export type TomorrowSplit = z.infer<typeof tomorrowSplitSchema>;

export interface TomorrowSplitItem {
  title: string;
  rawText: string;
  existingWorkId: string | null;
  shape?: (typeof WORK_SHAPES)[number];
}

export interface TomorrowSplitResult {
  items: TomorrowSplitItem[];
  fallback: boolean;
}

export const TOMORROW_SPLIT_SYSTEM = `You split one nightly plan for tomorrow into independent desired outcomes called Work.

Rules:
- Preserve the user's meaning and important detail. Never invent a goal.
- Split automatically when two parts can be completed, paused, or abandoned independently.
- Keep one outcome together when its steps serve the same definition of done.
- A shared person, day, or theme is not one outcome by itself. Split when the parts can finish independently.
- A title is short, concrete, and sentence case.
- When an item is the same outcome as an existing Work in the list, set existingWorkId to that Work's id.
- Never set existingWorkId to an id outside the list.
- Do not encode professions, companies, errands, or example-specific behavior in the split.

${WORK_SHAPE_GUIDE}

Return one JSON object only:
{"work":[{"title":string,"rawText":string,"existingWorkId":string|null,"shape":"quick"|"project"|"practice"|"decision"|"monitor"|"recurring"}]}`;

function fallbackResult(original: string): TomorrowSplitResult {
  return {
    items: [
      {
        title: titleFromWorkText(original),
        rawText: preserveCaptureText(original),
        existingWorkId: null,
      },
    ],
    fallback: true,
  };
}

/** Parse the model reply. A parse failure never loses the raw answer. */
export function parseTomorrowSplit(
  raw: string,
  original: string,
  validWorkIds: ReadonlySet<string>,
): TomorrowSplitResult {
  try {
    let text = String(raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return fallbackResult(original);
    const parsed = tomorrowSplitSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    if (!parsed.success) return fallbackResult(original);
    const items = parsed.data.work
      .map((item) => ({
        title: item.title.trim(),
        rawText: preserveCaptureText(item.rawText),
        // A hallucinated id must not capture an unrelated Work.
        existingWorkId:
          item.existingWorkId && validWorkIds.has(item.existingWorkId) ? item.existingWorkId : null,
        shape: item.shape,
      }))
      .filter((item) => item.title && item.rawText);
    if (!items.length) return fallbackResult(original);
    return { items, fallback: false };
  } catch {
    return fallbackResult(original);
  }
}

export interface SplitTomorrowInput {
  userId: string;
  userEmail?: string;
  userName?: string;
  tomorrowIntentText: string;
  existing: TomorrowSiblingWork[];
}

interface SplitTomorrowDependencies {
  generate: typeof generateTextForCurrentUser;
}

const defaultDependencies: SplitTomorrowDependencies = {
  generate: generateTextForCurrentUser,
};

export async function splitTomorrowWork(
  input: SplitTomorrowInput,
  dependencies: SplitTomorrowDependencies = defaultDependencies,
): Promise<TomorrowSplitResult> {
  const original = input.tomorrowIntentText.trim();
  if (!original) throw new Error('tomorrowIntentText is required.');
  const validWorkIds = new Set(input.existing.map((work) => work.workId));
  try {
    const existingContext = input.existing.map((work) => ({
      id: work.workId,
      title: work.title,
      started: work.started,
    }));
    const { text } = await dependencies.generate({
      feature: 'albatross_capture_split',
      speed: 'fast',
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      system: TOMORROW_SPLIT_SYSTEM,
      prompt: `Existing Works from an earlier save of this check-in:\n${JSON.stringify(existingContext, null, 2)}\n\nTomorrow plan:\n${original}`,
    });
    return parseTomorrowSplit(text, original, validWorkIds);
  } catch {
    return fallbackResult(original);
  }
}

export function tomorrowExternalPrefix(checkinId: string) {
  return `checkin:${checkinId}:tomorrow`;
}

/** A content-stable slug for external ids: same title, same id, every run. */
export function contentSlug(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'work'
  );
}

/** Base plus a numeric suffix keeps sibling ids unique inside one family. */
export function uniqueExternalId(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base;
  // taken.size + 2 candidates cannot all collide with taken.size entries.
  for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${taken.size + 2}`;
}

/**
 * External ids key on content, not position, so a retry of the same run
 * upserts instead of duplicating. The legacy single-work id equals the bare
 * prefix and stays valid.
 */
export function tomorrowExternalId(checkinId: string, title: string, taken: ReadonlySet<string>) {
  return uniqueExternalId(`${tomorrowExternalPrefix(checkinId)}:${contentSlug(title)}`, taken);
}
