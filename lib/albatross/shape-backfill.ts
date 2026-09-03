import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';
import { parseHorizonHint, type WorkHorizon } from '@/lib/albatross/horizon';
import { parseListHint, parseMetricHint } from '@/lib/albatross/shape-hints';
import { WORK_SHAPE_GUIDE, WORK_SHAPES, type WorkShape } from '@/lib/albatross/work-shape';

// Work captured before shapes existed carries no shape, so it reads as
// `quick`: planned, watched, and reviewed. Most of it never was. The backfill
// reads each row once and gives it the shape it always had, plus the items,
// the metric, or the horizon that shape carries.
//
// The model reads the text. The deterministic parsers fill what the model
// leaves out and act as the test oracle, exactly as capture does.

export const SHAPE_BACKFILL_BATCH = 20;

export interface UnshapedWorkRow {
  workId: string;
  title: string | null;
  rawText: string;
  createdAt?: number;
}

export interface ShapeBackfillWrite {
  workId: string;
  shape: WorkShape;
  listItems?: string[];
  metric?: { name: string; unit: string; target?: number; direction?: 'down' | 'up' };
  horizon?: WorkHorizon;
}

const verdictSchema = z
  .object({
    workId: z.string(),
    shape: z.enum(WORK_SHAPES),
    listItems: z.array(z.string().min(1).max(300)).max(50).optional(),
    metric: z
      .object({
        name: z.string().min(1).max(60),
        unit: z.string().max(20),
        target: z.number().optional(),
        direction: z.enum(['down', 'up']).optional(),
      })
      .optional(),
  })
  .strict();

const responseSchema = z.object({ verdicts: z.array(verdictSchema).max(SHAPE_BACKFILL_BATCH) });

export const SHAPE_BACKFILL_SYSTEM = `You read existing work items and say what kind of outcome each one is.

${WORK_SHAPE_GUIDE}

Rules:
- Read only what the text says. Do not invent an outcome.
- A collection of named things is a list. Return the items in listItems.
- A goal with a number and a unit is a practice. Return the metric.
- When the text is a single errand, the shape is quick.
- When you cannot tell, answer quick.
Return one verdict for every workId you are given.`;

export function backfillPrompt(rows: UnshapedWorkRow[]): string {
  return rows
    .map((row) => {
      const title = row.title?.trim();
      const text = row.rawText.trim().slice(0, 600);
      return `workId: ${row.workId}\n${title ? `title: ${title}\n` : ''}text: ${text}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Merge one model verdict with the deterministic parsers. The parsers only
 * add what the model left out, so a confident model answer always wins.
 */
export function planShapeWrite(
  row: UnshapedWorkRow,
  verdict: { shape?: WorkShape; listItems?: string[]; metric?: ShapeBackfillWrite['metric'] } | null,
  nowMs: number,
): ShapeBackfillWrite {
  const text = `${row.title ? `${row.title}\n` : ''}${row.rawText}`;
  const parsedList = parseListHint(text);
  const parsedMetric = parseMetricHint(text, nowMs);
  const parsedHorizon = parseHorizonHint(text, nowMs);

  let shape: WorkShape = verdict?.shape ?? 'quick';
  const listItems = verdict?.listItems?.length ? verdict.listItems : parsedList?.items;
  const metric = verdict?.metric ?? parsedMetric?.metric ?? undefined;

  // A shape the model missed but the text states plainly.
  if (!verdict?.shape) {
    if (listItems?.length) shape = 'list';
    else if (metric) shape = 'practice';
  }
  // A list without items, or a practice without a metric, is not that shape.
  if (shape === 'list' && !listItems?.length) shape = 'quick';
  if (shape === 'practice' && !metric) shape = 'quick';

  const write: ShapeBackfillWrite = { workId: row.workId, shape };
  if (shape === 'list' && listItems?.length) write.listItems = listItems.slice(0, 50);
  if (shape === 'practice' && metric) write.metric = metric;
  // A horizon the text states outright. Nothing is invented.
  if (parsedHorizon?.notBefore || parsedHorizon?.by) write.horizon = parsedHorizon;
  return write;
}

export interface ShapeBackfillDependencies {
  generateObject: typeof generateObjectForCurrentUser;
  now: () => number;
}

const defaultDependencies: ShapeBackfillDependencies = {
  generateObject: generateObjectForCurrentUser,
  now: () => Date.now(),
};

/**
 * One model pass over one batch. A failed call is not fatal: every row still
 * gets the deterministic reading, which is what capture falls back to.
 */
export async function planShapeBackfill(
  rows: UnshapedWorkRow[],
  dependencies: ShapeBackfillDependencies = defaultDependencies,
): Promise<ShapeBackfillWrite[]> {
  if (!rows.length) return [];
  const nowMs = dependencies.now();
  let verdicts: Array<z.infer<typeof verdictSchema>> = [];
  try {
    const result = await dependencies.generateObject({
      feature: 'albatross_shape_backfill',
      speed: 'fast',
      system: SHAPE_BACKFILL_SYSTEM,
      prompt: backfillPrompt(rows),
      schema: responseSchema,
      maxOutputTokens: 2000,
    } as any);
    verdicts = (result as any)?.object?.verdicts ?? [];
  } catch {
    verdicts = [];
  }
  const byId = new Map(verdicts.map((verdict) => [verdict.workId, verdict]));
  return rows.map((row) => planShapeWrite(row, byId.get(row.workId) ?? null, nowMs));
}
