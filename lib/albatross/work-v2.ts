import { createHash } from 'node:crypto';
import { z } from 'zod';

export const workSplitSchema = z.object({
  work: z
    .array(
      z.object({
        title: z.string().min(1).max(180),
        rawText: z.string().min(1).max(20_000),
        primaryAreaName: z.string().max(120).nullish(),
        relatedAreaNames: z.array(z.string().max(120)).max(6).default([]),
      }),
    )
    .min(1)
    .max(20),
});

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

export function shouldComposeWorkBrief(input: ProjectPromotionInput) {
  const actions = input.actions || [];
  if (projectPromotionDecision(input).promote) return true;
  if (actions.length >= 5) return true;
  return actions.some((action) => Boolean(action.startIso || action.endIso));
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
