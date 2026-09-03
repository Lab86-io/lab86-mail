import { describeProvider } from '../ai/client';
import { generateTextForCurrentUser } from '../ai/gateway';
import { stripEmoji } from '../shared/format';
import type { DailyReportCalendarItem, DailyReportProse } from '../shared/types';
import type { BriefLane } from './brief-score';

// The one model call of the budget brief. The model writes three things: the
// lede, one line per selected item, and the week-ahead paragraph. Everything
// else in the edition is deterministic. Decided by Jakob on 2026-09-03.

export const LEDE_MAX_SENTENCES = 4;
export const WEEK_AHEAD_MAX_SENTENCES = 4;
export const ITEM_LINE_MAX_WORDS = 20;
export const AREA_LINE_MAX_WORDS = 24;

export interface BriefProseItemInput {
  key: string;
  lane: BriefLane;
  sender: string;
  subject: string;
  receivedAt: number | null;
  dueAt?: number | null;
  // The deterministic reason line, as grounding for the model.
  whyItMatters?: string;
  // Real message bodies, newest last, bounded by the caller.
  messages: Array<{ from: string; date: number | null; body: string }>;
}

export interface BriefProseInput {
  firstName: string | null;
  kind: 'morning' | 'evening' | 'manual';
  now: number;
  timezone: string;
  items: BriefProseItemInput[];
  // Forward calendar: today through +7 days.
  calendar: DailyReportCalendarItem[];
  // Open tasks with a due date inside the week.
  tasks: Array<{ title: string; dueAt: number | null }>;
  // At most 3 area lines.
  areas: Array<{ name: string; line: string }>;
  tomorrowIntent?: string | null;
  // One short weather sentence, or null.
  weather?: string | null;
}

export interface BriefProseResult extends DailyReportProse {
  lines: Record<string, string>;
}

export const BRIEF_PROSE_SYSTEM_PROMPT = `You write a short morning letter for one person. You are their assistant, not a narrator.
Return only JSON: {"lede":"...","items":[{"key":"...","line":"..."}],"weekAhead":"..."}.

Rules:
- lede: at most 4 sentences. Say what matters today and why, in plain words. Name people. No greeting line, no sign-off.
- items: one line per supplied item key, at most 20 words each. Say why the email matters or what to do. Use the real message bodies. If there is nothing useful to add beyond sender and subject, return an empty line for that key.
- weekAhead: at most 4 sentences about the next seven days. Use the supplied weekday names and dates exactly. Name the day for each event or deadline. Say which days are open. Example of the level: "This Thursday you can send the passport form. Friday is open."
- Use only supplied facts. Never invent people, dates, events, or outcomes.
- Plain English. Sentence case. No bullet lists, no headings, no emoji, no exclamation marks, no ALL-CAPS words.
- Never write the word "AI". Never mention models, assistants, or this brief itself.
- Never summarize a summary: each line comes from the email, not from the reason field.`;

// ---- Day table -------------------------------------------------------------

export interface BriefWeekDay {
  index: number;
  // Local calendar date key, YYYY-MM-DD in the user's timezone.
  dayKey: string;
  weekday: string;
  // Short label such as "Thu Sep 4".
  label: string;
  isToday: boolean;
  isTomorrow: boolean;
  startAt: number;
}

export function localDayKey(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

function formatIn(at: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(new Date(at));
  }
}

// Seven days starting today, computed in the user's timezone.
export function briefWeekDays(now: number, timeZone: string, count = 7): BriefWeekDay[] {
  const days: BriefWeekDay[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = now + index * 86_400_000;
    days.push({
      index,
      dayKey: localDayKey(at, timeZone),
      weekday: formatIn(at, timeZone, { weekday: 'long' }),
      label: formatIn(at, timeZone, { weekday: 'short', month: 'short', day: 'numeric' }),
      isToday: index === 0,
      isTomorrow: index === 1,
      startAt: at,
    });
  }
  return days;
}

export function localTimeLabel(at: number, timeZone: string): string {
  return formatIn(at, timeZone, { hour: 'numeric', minute: '2-digit' });
}

export function eventsByDay(
  calendar: DailyReportCalendarItem[],
  days: BriefWeekDay[],
  timeZone: string,
): Map<string, DailyReportCalendarItem[]> {
  const byDay = new Map<string, DailyReportCalendarItem[]>(days.map((day) => [day.dayKey, []]));
  for (const event of [...calendar].sort((a, b) => a.startAt - b.startAt)) {
    const key = localDayKey(event.startAt, timeZone);
    byDay.get(key)?.push(event);
  }
  return byDay;
}

function eventPhrase(event: DailyReportCalendarItem, timeZone: string): string {
  return event.allDay ? event.title : `${event.title} at ${localTimeLabel(event.startAt, timeZone)}`;
}

function joinList(values: string[]): string {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

// ---- Deterministic fallbacks ----------------------------------------------

export function weekAheadFallback(input: {
  calendar: DailyReportCalendarItem[];
  tasks: Array<{ title: string; dueAt: number | null }>;
  now: number;
  timezone: string;
}): string {
  const days = briefWeekDays(input.now, input.timezone);
  const byDay = eventsByDay(input.calendar, days, input.timezone);
  const dueByDay = new Map<string, string[]>();
  for (const task of input.tasks) {
    if (typeof task.dueAt !== 'number') continue;
    const key = localDayKey(task.dueAt, input.timezone);
    const list = dueByDay.get(key) || [];
    list.push(task.title);
    dueByDay.set(key, list);
  }
  const sentences: string[] = [];
  const open: string[] = [];
  for (const day of days) {
    const events = byDay.get(day.dayKey) || [];
    const due = dueByDay.get(day.dayKey) || [];
    const name = day.isToday ? 'Today' : day.isTomorrow ? 'Tomorrow' : day.weekday;
    if (!events.length && !due.length) {
      if (!day.isToday) open.push(day.weekday);
      continue;
    }
    const parts = [
      ...events.slice(0, 3).map((event) => eventPhrase(event, input.timezone)),
      ...due.slice(0, 2).map((title) => `${title} is due`),
    ];
    sentences.push(`${name}: ${joinList(parts)}.`);
  }
  if (open.length) {
    sentences.push(open.length === 1 ? `${open[0]} is open.` : `${joinList(open.slice(0, 4))} are open.`);
  }
  if (!sentences.length) return 'The next seven days are open.';
  return clampSentences(sentences.join(' '), WEEK_AHEAD_MAX_SENTENCES);
}

export function ledeFallback(input: {
  firstName: string | null;
  kind: 'morning' | 'evening' | 'manual';
  items: Array<{ lane: BriefLane; sender: string; subject: string }>;
  todayEventCount: number;
}): string {
  const answers = input.items.filter((item) => item.lane === 'answer');
  const today = input.items.filter((item) => item.lane === 'today');
  const know = input.items.filter((item) => item.lane === 'know');
  const sentences: string[] = [];
  const opener =
    input.kind === 'evening'
      ? 'Here is where the day ends.'
      : input.kind === 'morning'
        ? 'Here is your morning.'
        : 'Here is where things stand.';
  sentences.push(
    input.firstName ? `${input.firstName}, ${opener.charAt(0).toLowerCase()}${opener.slice(1)}` : opener,
  );
  if (answers.length) {
    const names = joinList(
      answers
        .map((item) => item.sender || item.subject)
        .filter(Boolean)
        .slice(0, 3),
    );
    sentences.push(
      answers.length === 1
        ? `${names} is waiting on a reply about ${answers[0].subject}.`
        : `${names} are waiting on replies.`,
    );
  } else {
    sentences.push('Nobody is waiting on a reply.');
  }
  if (today.length || input.todayEventCount) {
    const parts: string[] = [];
    if (input.todayEventCount) {
      parts.push(`${input.todayEventCount} ${input.todayEventCount === 1 ? 'event' : 'events'}`);
    }
    if (today.length) parts.push(`${today.length} ${today.length === 1 ? 'deadline' : 'deadlines'}`);
    sentences.push(`Today holds ${joinList(parts)}.`);
  }
  if (know.length) {
    sentences.push(`${know.length} more ${know.length === 1 ? 'thread is' : 'threads are'} worth a look.`);
  }
  return clampSentences(sentences.join(' '), LEDE_MAX_SENTENCES);
}

// ---- Clamps ----------------------------------------------------------------

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;
const AI_WORD = /\bAI\b/;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function clampSentences(text: string, max: number): string {
  return splitSentences(text).slice(0, max).join(' ');
}

export function clampWords(text: string, max: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return `${words
    .slice(0, max)
    .join(' ')
    .replace(/[,;:]$/, '')}.`;
}

// Removes emoji, exclamation marks, and any sentence that names "AI". Returns
// an empty string when nothing survives.
export function sanitizeProse(text: string, maxSentences: number): string {
  const clean = stripEmoji(String(text || ''))
    .replace(/!+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  const kept = splitSentences(clean).filter((sentence) => !AI_WORD.test(sentence));
  return kept.slice(0, maxSentences).join(' ');
}

export function sanitizeLine(text: string, maxWords = ITEM_LINE_MAX_WORDS): string {
  const clean = stripEmoji(String(text || ''))
    .replace(/!+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || AI_WORD.test(clean)) return '';
  return clampWords(clean, maxWords);
}

// ---- Model output ----------------------------------------------------------

export function parseBriefProse(
  text: string,
  keys: string[],
): { lede: string; lines: Record<string, string>; weekAhead: string } | null {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const allowed = new Set(keys);
  const lines: Record<string, string> = {};
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  for (const entry of rawItems) {
    const key = typeof entry?.key === 'string' ? entry.key : '';
    if (!allowed.has(key)) continue;
    const line = sanitizeLine(typeof entry?.line === 'string' ? entry.line : '');
    if (line) lines[key] = line;
  }
  return {
    lede: sanitizeProse(typeof parsed.lede === 'string' ? parsed.lede : '', LEDE_MAX_SENTENCES),
    lines,
    weekAhead: sanitizeProse(
      typeof parsed.weekAhead === 'string' ? parsed.weekAhead : '',
      WEEK_AHEAD_MAX_SENTENCES,
    ),
  };
}

export function buildBriefProsePrompt(input: BriefProseInput): string {
  const days = briefWeekDays(input.now, input.timezone);
  const byDay = eventsByDay(input.calendar, days, input.timezone);
  const week = days.map((day) => ({
    weekday: day.weekday,
    date: day.label,
    isToday: day.isToday,
    events: (byDay.get(day.dayKey) || []).slice(0, 8).map((event) => ({
      title: event.title,
      time: event.allDay ? 'all day' : localTimeLabel(event.startAt, input.timezone),
      location: event.location || null,
    })),
    due: input.tasks
      .filter(
        (task) => typeof task.dueAt === 'number' && localDayKey(task.dueAt, input.timezone) === day.dayKey,
      )
      .slice(0, 6)
      .map((task) => task.title),
  }));
  const data = {
    reader: input.firstName || null,
    edition: input.kind,
    now: `${days[0].weekday}, ${days[0].label}, ${localTimeLabel(input.now, input.timezone)} (${input.timezone})`,
    weather: input.weather || null,
    tomorrowIntent: input.tomorrowIntent || null,
    items: input.items.map((item) => ({
      key: item.key,
      lane: item.lane,
      sender: item.sender,
      subject: item.subject,
      received: item.receivedAt
        ? formatIn(item.receivedAt, input.timezone, { weekday: 'short', month: 'short', day: 'numeric' })
        : null,
      due:
        typeof item.dueAt === 'number'
          ? formatIn(item.dueAt, input.timezone, { weekday: 'long', month: 'short', day: 'numeric' })
          : null,
      reason: item.whyItMatters || null,
      messages: item.messages,
    })),
    week,
    areas: input.areas,
  };
  return [
    'Write the letter from this data. Return only the JSON object.',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
}

export async function writeBriefProse(
  input: BriefProseInput,
  deps: {
    generate?: typeof generateTextForCurrentUser | null;
    userId?: string | null;
  } = {},
): Promise<BriefProseResult> {
  const days = briefWeekDays(input.now, input.timezone);
  const todayEventCount = (eventsByDay(input.calendar, days, input.timezone).get(days[0].dayKey) || [])
    .length;
  const fallback: BriefProseResult = {
    lede: ledeFallback({
      firstName: input.firstName,
      kind: input.kind,
      items: input.items,
      todayEventCount,
    }),
    lines: {},
    weekAhead: weekAheadFallback({
      calendar: input.calendar,
      tasks: input.tasks,
      now: input.now,
      timezone: input.timezone,
    }),
    model: 'local',
  };
  const generate = deps.generate === undefined ? generateTextForCurrentUser : deps.generate;
  if (!generate) return fallback;
  try {
    const { text } = await generate({
      feature: 'daily_brief_prose',
      speed: 'primary',
      userId: deps.userId,
      system: BRIEF_PROSE_SYSTEM_PROMPT,
      prompt: buildBriefProsePrompt(input),
    });
    const parsed = parseBriefProse(
      text,
      input.items.map((item) => item.key),
    );
    if (!parsed) return fallback;
    return {
      lede: parsed.lede || fallback.lede,
      lines: parsed.lines,
      weekAhead: parsed.weekAhead || fallback.weekAhead,
      model: describeProvider().primary || 'primary',
    };
  } catch (error) {
    console.warn('[brief-prose] model call failed; using the deterministic letter:', error);
    return fallback;
  }
}
