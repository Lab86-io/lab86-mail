// Goal runs (docs/albatross-goal-runs.md). A run works on the whole goal, not
// on one plan step. It talks in the thread while it works, keeps its own
// checklist, and hands over a package of items. These shapes are shared by the
// runner, Convex, the web client, and the native copies (Swift mirrors them).

import { z } from 'zod';
import { truncateText } from '../shared/text';

/** The step key of every goal run. No plan step has this key. */
export const GOAL_STEP_KEY = 'goal';
export const goalStepIdentity = (workId: string) => `goal:${workId}`;
export const isGoalStepKey = (key: string | null | undefined) => key === GOAL_STEP_KEY;
/** Automatic runs start once a day for each Work (G1 Start). */
export const goalAutoIdentity = (workId: string, localDate: string) => `goal:${workId}:${localDate}`;

export const RUN_MESSAGE_MAX = 40;
export const RUN_MESSAGE_TEXT_MAX = 1_500;
export const RUN_MESSAGE_SOURCES_MAX = 8;
export const CHECKLIST_MAX = 12;
export const CHECKLIST_TEXT_MAX = 120;
export const HANDOFF_ITEMS_MAX = 8;
export const HANDOFF_ITEM_TITLE_MAX = 120;
export const HANDOFF_ITEM_NOTE_MAX = 200;
export const HANDOFF_ITEM_BLANKS_MAX = 6;
export const UNSURE_MAX = 4;
export const UNSURE_TEXT_MAX = 200;

export const RUN_SOURCE_KINDS = ['web', 'mail', 'file', 'calendar', 'jira', 'document'] as const;
export type RunSourceKind = (typeof RUN_SOURCE_KINDS)[number];
export const CHECKLIST_STATES = ['todo', 'doing', 'done', 'yours'] as const;
export type ChecklistState = (typeof CHECKLIST_STATES)[number];
export const HANDOFF_ITEM_KINDS = [
  'draft',
  'document',
  'sheet',
  'deck',
  'file',
  'approval',
  'event',
  'page',
] as const;
export type HandoffItemKind = (typeof HANDOFF_ITEM_KINDS)[number];
export const HANDOFF_ITEM_STATES = ['ready', 'blanks', 'check'] as const;
export type HandoffItemState = (typeof HANDOFF_ITEM_STATES)[number];

/** Where a fact in a run message came from. The server fills these from tool calls. */
export interface RunSource {
  kind: RunSourceKind;
  title: string;
  url?: string;
  id?: string;
  accountId?: string;
  /**
   * The locator the server computes for the chip after the title: the host
   * of a web page, "Priya, Jul 30" for mail, the key of a Jira issue, a short
   * date for an event, the kind word of a file when the title lacks it.
   */
  detail?: string;
}

/** Text the model wrote to the user between tool calls. */
export interface RunMessage {
  id: string;
  at: number;
  text: string;
  sources: RunSource[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  state: ChecklistState;
}

/** One thing in the package that a run hands over (G3). */
export interface HandoffItem {
  kind: HandoffItemKind;
  id?: string;
  url?: string;
  accountId?: string;
  title: string;
  state: HandoffItemState;
  blanks?: string[];
  note?: string;
}

/** The goal-run fields of a run view. Every field is optional on old rows. */
export interface GoalRunViewFields {
  goal: boolean;
  messages: RunMessage[];
  checklist: ChecklistItem[];
  items: HandoffItem[];
  unsure: string[];
}

// Model-facing schemas. No .regex: OpenAI Responses rejects patterns.

export const checklistInputSchema = z.object({
  items: z
    .array(
      z.object({
        text: z
          .string()
          .min(1)
          .max(CHECKLIST_TEXT_MAX)
          .describe('One short line, for example "Find the July hours".'),
        state: z
          .enum(CHECKLIST_STATES)
          .describe('todo, doing (what you work on now), done, or yours (only the user can do it).'),
      }),
    )
    .min(1)
    .max(CHECKLIST_MAX)
    .describe('The full list, in order. Send the whole list each time.'),
});

export const handoffItemInputSchema = z.object({
  kind: z.enum(HANDOFF_ITEM_KINDS),
  id: z.string().max(300).optional().describe('The id from the tool result that made it.'),
  url: z.string().max(2_000).optional(),
  accountId: z.string().max(300).optional(),
  title: z.string().min(1).max(HANDOFF_ITEM_TITLE_MAX),
  state: z
    .enum(HANDOFF_ITEM_STATES)
    .describe(
      'ready: nothing left for the user. blanks: fields to fill. check: the user reads it before it goes out.',
    ),
  blanks: z
    .array(z.string().min(1).max(40))
    .max(HANDOFF_ITEM_BLANKS_MAX)
    .optional()
    .describe('The empty fields in this item, by short name, in page order.'),
  note: z.string().max(HANDOFF_ITEM_NOTE_MAX).optional().describe('One sentence about this item.'),
});

export const handoffItemsInputSchema = z
  .array(handoffItemInputSchema)
  .max(HANDOFF_ITEMS_MAX)
  .describe('Everything you made for the user in this run, the most important first.');

export const unsureInputSchema = z
  .array(z.string().min(1).max(UNSURE_TEXT_MAX))
  .max(UNSURE_MAX)
  .describe('Things the user must check, one short line each. Say what you used instead.');

// Normalizers. Convex and the runner both call these, so a row never holds
// more than a client renders.

const oneLine = (text: string, max: number) => truncateText(text.replace(/\s+/g, ' ').trim(), max);

export function cleanChecklist(
  items: ReadonlyArray<{ text: string; state: string }> | undefined,
  idFor: (index: number) => string = (index) => `c${index + 1}`,
): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const item of items || []) {
    const text = oneLine(String(item?.text || ''), CHECKLIST_TEXT_MAX);
    if (!text) continue;
    const state = (CHECKLIST_STATES as readonly string[]).includes(item.state)
      ? (item.state as ChecklistState)
      : 'todo';
    out.push({ id: idFor(out.length), text, state });
    if (out.length === CHECKLIST_MAX) break;
  }
  return out;
}

export function cleanSources(sources: ReadonlyArray<Partial<RunSource>> | undefined): RunSource[] {
  const out: RunSource[] = [];
  const seen = new Set<string>();
  for (const source of sources || []) {
    const kind = source?.kind;
    if (!kind || !(RUN_SOURCE_KINDS as readonly string[]).includes(kind)) continue;
    const title = oneLine(String(source.title || ''), 160);
    const url = source.url ? truncateText(String(source.url).trim(), 2_000) : undefined;
    const id = source.id ? truncateText(String(source.id).trim(), 300) : undefined;
    if (!title || (!url && !id)) continue;
    const key = `${kind}:${url || id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      title,
      ...(url ? { url } : {}),
      ...(id ? { id } : {}),
      ...(source.accountId ? { accountId: truncateText(String(source.accountId), 300) } : {}),
    });
    if (out.length === RUN_MESSAGE_SOURCES_MAX) break;
  }
  return out;
}

/** Adds one message and keeps the newest RUN_MESSAGE_MAX. Empty text adds nothing. */
export function appendRunMessage(
  messages: readonly RunMessage[],
  message: { id: string; at: number; text: string; sources?: ReadonlyArray<Partial<RunSource>> },
): RunMessage[] {
  const text = truncateText(String(message.text || '').trim(), RUN_MESSAGE_TEXT_MAX);
  if (!text) return [...messages];
  return [
    ...messages,
    { id: message.id, at: message.at, text, sources: cleanSources(message.sources) },
  ].slice(-RUN_MESSAGE_MAX);
}

export function cleanUnsure(lines: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const line of lines || []) {
    const text = oneLine(String(line || ''), UNSURE_TEXT_MAX);
    if (text && !out.includes(text)) out.push(text);
    if (out.length === UNSURE_MAX) break;
  }
  return out;
}

export function cleanHandoffItems(items: ReadonlyArray<Partial<HandoffItem>> | undefined): HandoffItem[] {
  const out: HandoffItem[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const kind = item?.kind;
    if (!kind || !(HANDOFF_ITEM_KINDS as readonly string[]).includes(kind)) continue;
    const title = oneLine(String(item.title || ''), HANDOFF_ITEM_TITLE_MAX);
    if (!title) continue;
    const id = item.id ? truncateText(String(item.id).trim(), 300) : undefined;
    const url = item.url ? truncateText(String(item.url).trim(), 2_000) : undefined;
    const key = id || url ? `${kind}:${id || url}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const state = (HANDOFF_ITEM_STATES as readonly string[]).includes(item.state || '')
      ? (item.state as HandoffItemState)
      : 'check';
    const blanks: string[] = [];
    for (const blank of item.blanks || []) {
      const name = oneLine(String(blank || ''), 40);
      if (name && !blanks.some((other) => other.toLowerCase() === name.toLowerCase())) blanks.push(name);
      if (blanks.length === HANDOFF_ITEM_BLANKS_MAX) break;
    }
    const note = item.note ? oneLine(String(item.note), HANDOFF_ITEM_NOTE_MAX) : '';
    out.push({
      kind,
      title,
      state: blanks.length && state === 'ready' ? 'blanks' : state,
      ...(id ? { id } : {}),
      ...(url ? { url } : {}),
      ...(item.accountId ? { accountId: truncateText(String(item.accountId), 300) } : {}),
      ...(blanks.length ? { blanks } : {}),
      ...(note ? { note } : {}),
    });
    if (out.length === HANDOFF_ITEMS_MAX) break;
  }
  return out;
}

/** `LAB86_GOAL_RUNS`: `all`, or a comma list of user ids. Off when empty. */
export function goalRunsEnabled(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.LAB86_GOAL_RUNS || '').trim();
  if (!raw || raw === 'off') return false;
  if (raw === 'all') return true;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}
