import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HORIZON_KINDS, parseHorizonHint, type WorkHorizon } from '@/lib/albatross/horizon';
import type { MetricLike } from '@/lib/albatross/practice-review';
import { parseListHint, parseMetricHint } from '@/lib/albatross/shape-hints';
import { WORK_SHAPES, type WorkShape } from '@/lib/albatross/work-shape';

// The splitter's read of the horizon. Dates arrive as ISO strings because a
// model writes those more reliably than epoch numbers.
export const splitHorizonSchema = z
  .object({
    kind: z.enum(HORIZON_KINDS),
    notBeforeIso: z.string().max(40).nullish(),
    byIso: z.string().max(40).nullish(),
    label: z.string().max(120).nullish(),
  })
  .nullish()
  .catch(undefined);

export type SplitHorizon = z.infer<typeof splitHorizonSchema>;

// The splitter's read of a practice metric.
export const splitMetricSchema = z
  .object({
    name: z.string().min(1).max(80),
    unit: z
      .string()
      .max(24)
      .nullish()
      .transform((value) => value ?? ''),
    target: z
      .number()
      .finite()
      .nullish()
      .transform((value) => value ?? undefined),
    direction: z
      .enum(['down', 'up'])
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .nullish()
  .catch(undefined);

export type SplitMetric = z.infer<typeof splitMetricSchema>;

function isoToMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The stored horizon for one split item. The model's read wins when it is
 * usable. The deterministic parse of the item's own words is the fallback.
 * "now" with no date and no label means no horizon at all.
 */
export function horizonForSplitItem(
  horizon: SplitHorizon,
  rawText: string,
  nowMs: number,
): WorkHorizon | undefined {
  if (horizon) {
    const notBefore = isoToMs(horizon.notBeforeIso);
    const by = isoToMs(horizon.byIso);
    const label = horizon.label?.trim() || undefined;
    if (horizon.kind !== 'now' || notBefore !== undefined || by !== undefined) {
      return {
        kind: horizon.kind,
        ...(notBefore !== undefined ? { notBefore } : {}),
        ...(by !== undefined ? { by } : {}),
        ...(label ? { label } : {}),
      };
    }
  }
  return parseHorizonHint(rawText, nowMs) ?? undefined;
}

export const workSplitSchema = z.object({
  work: z
    .array(
      z.object({
        title: z.string().min(1).max(180),
        rawText: z.string().min(1).max(20_000),
        primaryAreaName: z.string().max(120).nullish(),
        relatedAreaNames: z.array(z.string().max(120)).max(6).default([]),
        // The splitter's first read of what kind of outcome this is. The
        // planner refines it later with more context; capture must not block
        // on it, so an unrecognised value simply drops to undefined.
        shape: z.enum(WORK_SHAPES).optional().catch(undefined),
        // Now, later, or someday, in the splitter's read. Optional; the
        // deterministic parse fills the gap.
        horizon: splitHorizonSchema,
        // Shape-owned data. A list names its items; a practice names its
        // metric. Both are optional, and both fall back to the parsers.
        listItems: z.array(z.string().max(500)).max(500).nullish().catch(undefined),
        metric: splitMetricSchema,
      }),
    )
    .min(1)
    .max(20),
});

export interface ShapeReadInput {
  shape?: WorkShape;
  listItems?: string[] | null;
  metric?: SplitMetric;
}

export interface ShapeRead {
  shape?: WorkShape;
  listItems?: string[];
  metric?: MetricLike;
  /** A horizon the metric phrase carried ("by spring"). Used only when the split gave none. */
  horizon?: WorkHorizon;
}

/**
 * The stored shape data for one split item. The model's read wins when it is
 * usable. The deterministic parsers fill the gaps: a list phrase makes the
 * item a list with its items, a metric phrase makes it a practice with its
 * metric. An item the model called something else keeps that shape.
 */
export function shapeForSplitItem(read: ShapeReadInput, rawText: string, nowMs: number): ShapeRead {
  const modelItems = (read.listItems || []).map((item) => item.trim()).filter(Boolean);
  const modelMetric = read.metric
    ? {
        name: read.metric.name.trim(),
        unit: (read.metric.unit || '').trim(),
        ...(typeof read.metric.target === 'number' ? { target: read.metric.target } : {}),
        ...(read.metric.direction ? { direction: read.metric.direction } : {}),
      }
    : undefined;
  const listHint = read.shape === undefined || read.shape === 'list' ? parseListHint(rawText) : null;
  const metricHint =
    read.shape === undefined || read.shape === 'practice' ? parseMetricHint(rawText, nowMs) : null;

  if (read.shape === 'list' || (read.shape === undefined && listHint)) {
    const listItems = modelItems.length ? modelItems : listHint?.items || [];
    return { shape: 'list', ...(listItems.length ? { listItems } : {}) };
  }
  if (read.shape === 'practice' || (read.shape === undefined && metricHint)) {
    const metric = modelMetric?.name ? modelMetric : metricHint?.metric;
    return {
      shape: 'practice',
      ...(metric ? { metric } : {}),
      ...(metricHint?.horizon ? { horizon: metricHint.horizon } : {}),
    };
  }
  return { shape: read.shape };
}

export type WorkSplit = z.infer<typeof workSplitSchema>;

export interface PlannedActionLike {
  actionKey?: string;
  key?: string;
  kind: string;
  title: string;
  description?: string;
  sourceRefs?: Array<{ kind: string; id: string }>;
  startIso?: string;
  endIso?: string;
}

export interface ProjectPromotionInput {
  declaredProjectTitle?: string | null;
  actions?: PlannedActionLike[] | null;
  now?: number;
}

export interface CheckinPreferenceLike {
  eveningCheckinEnabled: boolean;
  eveningCheckinLocalTime: string;
  emailFallbackDelayMinutes: number;
  timezone: string;
}

export function preserveCaptureText(value: string, max = 20_000) {
  return String(value || '')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, max);
}

export function parseWorkSplit(raw: string, original: string): WorkSplit {
  const fallback = {
    work: [
      {
        title: titleFromWorkText(original),
        rawText: preserveCaptureText(original),
        primaryAreaName: null,
        relatedAreaNames: [],
      },
    ],
  };
  try {
    let text = String(raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return fallback;
    const parsed = workSplitSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    if (!parsed.success) return fallback;
    const originalText = preserveCaptureText(original);
    const work = parsed.data.work
      .map((item) => ({
        ...item,
        title: item.title.trim(),
        rawText: preserveCaptureText(item.rawText),
        primaryAreaName: item.primaryAreaName?.trim() || null,
        relatedAreaNames: [...new Set(item.relatedAreaNames.map((name) => name.trim()).filter(Boolean))],
      }))
      .filter((item) => item.rawText);
    return work.length ? { work } : { ...fallback, work: [{ ...fallback.work[0], rawText: originalText }] };
  } catch {
    return fallback;
  }
}

export function titleFromWorkText(text: string) {
  const line =
    preserveCaptureText(text)
      .split(/\n|[.!?](?:\s|$)/)[0]
      ?.trim() || 'Untitled work';
  return line.length > 96 ? `${line.slice(0, 95).trimEnd()}…` : line;
}

function normalizedActionIdentity(action: PlannedActionLike) {
  const refs = (action.sourceRefs || [])
    .map((ref) => `${ref.kind}:${ref.id}`)
    .sort()
    .join('|');
  return [
    action.kind,
    action.title.trim().toLowerCase().replace(/\s+/g, ' '),
    action.startIso || '',
    refs,
  ].join('\u001f');
}

export function actionKeyFor(action: PlannedActionLike) {
  if (action.actionKey) return action.actionKey;
  if (action.key) return action.key;
  return `action-${createHash('sha256').update(normalizedActionIdentity(action)).digest('hex').slice(0, 16)}`;
}

export function assignStableActionKeys<T extends PlannedActionLike>(
  actions: T[],
): Array<T & { actionKey: string }> {
  return actions.map((action) => ({ ...action, actionKey: actionKeyFor(action) }));
}

export function unappliedActions<T extends PlannedActionLike>(
  actions: T[],
  applications: Array<{ status?: string; artifacts?: Array<{ actionKey?: unknown }> }>,
) {
  const appliedKeys = new Set(
    applications
      .filter((application) => application.status !== 'undone')
      .flatMap((application) => application.artifacts || [])
      .map((artifact) => (typeof artifact.actionKey === 'string' ? artifact.actionKey : ''))
      .filter(Boolean),
  );
  return actions.filter((action) => !action.actionKey || !appliedKeys.has(action.actionKey));
}

export function projectPromotionDecision(input: ProjectPromotionInput): {
  promote: boolean;
  reason?: string;
} {
  if (input.declaredProjectTitle?.trim()) {
    return { promote: true, reason: 'The plan declares a durable multi-step outcome.' };
  }
  const actions = input.actions || [];
  const taskCount = actions.filter((action) => action.kind === 'task').length;
  if (taskCount >= 3)
    return { promote: true, reason: `${taskCount} separate tasks need one durable project.` };
  const horizon = (input.now ?? Date.now()) + 7 * 24 * 60 * 60 * 1000;
  if (
    actions.some((action) => {
      const at = Date.parse(action.startIso || action.endIso || '');
      return Number.isFinite(at) && at > horizon;
    })
  ) {
    return { promote: true, reason: 'The work extends beyond one week.' };
  }
  return { promote: false };
}

/**
 * The plan document is the Work page, so any plan with something to follow
 * gets one: steps to do, or an open question that gates them. Only a plan
 * with nothing in it — no actions, no question — goes without.
 */
export function shouldComposeWorkBrief(
  input: ProjectPromotionInput & {
    physicalActions?: Array<{ title: string }> | null;
    openQuestions?: number;
  },
) {
  if ((input.openQuestions ?? 0) > 0) return true;
  if ((input.actions || []).length) return true;
  return Boolean(input.physicalActions?.length);
}

export function localDateKey(timezone: string, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function localMinuteOfDay(timezone: string, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0) % 24;
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    return hour * 60 + minute;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

export function parseClockMinutes(value: string, fallback = 19 * 60) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : fallback;
}

export function checkinIsDue(preference: CheckinPreferenceLike, at = new Date(), windowMinutes = 15) {
  if (!preference.eveningCheckinEnabled) return false;
  const now = localMinuteOfDay(preference.timezone, at);
  const target = parseClockMinutes(preference.eveningCheckinLocalTime);
  return now >= target && now < target + windowMinutes;
}

export function fallbackEmailIsDue(input: {
  checkinCreatedAt: number;
  answeredAt?: number | null;
  delayMinutes: number;
  now?: number;
}) {
  if (input.answeredAt) return false;
  return (input.now ?? Date.now()) >= input.checkinCreatedAt + Math.max(0, input.delayMinutes) * 60_000;
}

export function captureFallbackItem(rawText: string, areaId?: string) {
  const primaryAreaId = String(areaId || '').trim() || undefined;
  return {
    title: rawText.slice(0, 180),
    rawText,
    relatedAreaIds: [],
    ...(primaryAreaId ? { primaryAreaId } : {}),
  };
}
