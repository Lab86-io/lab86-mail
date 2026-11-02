import { z } from 'zod';
import { recordOperation, registerUndoExecutor } from '../ai/operations';
import { api, convexQuery } from '../hosted/convex';
import { obligationActionDefaults } from '../obligations/action-deps';
import {
  NEEDS_YOU_GROUP_LABELS,
  NEEDS_YOU_GROUP_ORDER,
  type NeedsYouGroupId,
  type NeedsYouSnapshot,
  OBLIGATION_DUES,
  OBLIGATION_KINDS,
  OBLIGATION_SOURCE_LABELS,
  OBLIGATION_SOURCES,
  OBLIGATION_STATES,
  type ObligationAction,
  type ObligationView,
} from '../obligations/contract';
import { groupNeedsYou } from '../obligations/groups';
import { type ObligationCaller, runObligationAction } from '../obligations/service';
import { truncateText } from '../shared/text';
import { parseIsoInTimezone } from '../shared/timezones';
import { defineTool, type ToolContext } from './registry';

// Needs you for the chat (docs/needs-you.md). The model reads the ledger and
// runs the same actions as the page, through the same service and the same
// Undo window. Done, Later, and Not mine change only the user's own list, so
// their risk class is `write_self` and they do not ask for approval.
//
// The model never gets a one-time code value. A `code` item says that a code
// exists and names its issuer. Its fields come from an allow list, because
// the stored excerpt can quote the subject of the code mail.

/** The ledger calls that the tools make. Tests replace them. */
export const needsYouToolDeps = {
  service: obligationActionDefaults,
  snapshot: (userId: string) => convexQuery<NeedsYouSnapshot>(api.obligationViews.snapshotFor, { userId }),
  recordOperation,
  now: () => Date.now(),
};

const OFF_MESSAGE = 'Needs you is not available for this account.';
const LIST_LIMIT = 40;
const WHY_CHARS = 300;
const HIDDEN = '[hidden]';
const UNDO_KIND = 'needs_you_undo';
const CLOSED_GROUP: NeedsYouGroupId = 'closed_today';

function userIdOf(ctx: ToolContext) {
  if (!ctx.userId) throw new Error('Needs you needs a signed-in user.');
  return ctx.userId;
}

function callerOf(ctx: ToolContext): ObligationCaller {
  return {
    userId: userIdOf(ctx),
    ...(ctx.userEmail ? { email: ctx.userEmail } : {}),
    ...(ctx.userName ? { name: ctx.userName } : {}),
  };
}

function isoOf(ms: number) {
  return new Date(ms).toISOString();
}

/** The name of the service that sent a code. A display name can hold digits, so long runs go. */
function codeIssuer(view: ObligationView) {
  return (view.code?.issuer?.trim() || view.asker).replace(/\d{4,}/g, HIDDEN);
}

/** The only title and asker that a tool result gives for a code item. */
function safeTitleOf(view: ObligationView) {
  return view.kind === 'code'
    ? { title: `Sign-in code for ${codeIssuer(view)}`, asker: codeIssuer(view) }
    : { title: view.title, asker: view.asker };
}

/** A live code can also sit in the text of another item of the same thread. */
function withoutCodes(text: string, codes: readonly string[]) {
  return codes.reduce((clean, code) => clean.replaceAll(code, HIDDEN), text);
}

function listItem(view: ObligationView, group: NeedsYouGroupId, codes: readonly string[]) {
  const named = safeTitleOf(view);
  const common = {
    id: view.id,
    group,
    groupLabel: NEEDS_YOU_GROUP_LABELS[group],
    kind: view.kind,
    state: view.state,
    source: view.source,
    sourceName: OBLIGATION_SOURCE_LABELS[view.source],
    due: view.due,
    title: withoutCodes(named.title, codes),
    asker: withoutCodes(named.asker, codes),
  };
  if (view.kind === 'code') {
    const expiresAt = view.code?.expiresAt ?? view.dueAt;
    return {
      ...common,
      code: {
        available: Boolean(view.code),
        issuer: codeIssuer(view),
        ...(expiresAt ? { expiresAt: isoOf(expiresAt) } : {}),
      },
    };
  }
  return {
    ...common,
    ...(view.dueAt ? { dueAt: isoOf(view.dueAt) } : {}),
    ...(view.why ? { why: truncateText(withoutCodes(view.why, codes), WHY_CHARS) } : {}),
    ...(view.sourceLabel ? { where: withoutCodes(view.sourceLabel, codes) } : {}),
    ...(view.accountId ? { account: view.accountId } : {}),
    ...(view.threadId ? { threadId: view.threadId } : {}),
    ...(view.url ? { url: view.url } : {}),
    ...(view.workId ? { workId: view.workId } : {}),
    ...(view.workTitle ? { workTitle: view.workTitle } : {}),
  };
}

const ListItem = z.object({
  id: z.string(),
  group: z.string(),
  groupLabel: z.string(),
  kind: z.enum(OBLIGATION_KINDS),
  state: z.enum(OBLIGATION_STATES),
  source: z.enum(OBLIGATION_SOURCES),
  sourceName: z.string(),
  due: z.enum(OBLIGATION_DUES),
  dueAt: z.string().optional(),
  title: z.string(),
  asker: z.string(),
  why: z.string().optional(),
  where: z.string().optional(),
  account: z.string().optional(),
  threadId: z.string().optional(),
  url: z.string().optional(),
  workId: z.string().optional(),
  workTitle: z.string().optional(),
  code: z.object({ available: z.boolean(), issuer: z.string(), expiresAt: z.string().optional() }).optional(),
});

/** "5 open: 2 now, 3 today." */
function countLine(counts: Partial<Record<NeedsYouGroupId, number>>) {
  const open = NEEDS_YOU_GROUP_ORDER.filter((id) => id !== CLOSED_GROUP && counts[id]);
  if (!open.length) return 'Nothing is open.';
  const total = open.reduce((sum, id) => sum + (counts[id] ?? 0), 0);
  const parts = open.map((id) => `${counts[id]} ${NEEDS_YOU_GROUP_LABELS[id].toLowerCase()}`);
  return `${total} open: ${parts.join(', ')}.`;
}

export const needsYouList = defineTool({
  name: 'needs_you_list',
  description:
    "Read the user's Needs you list: one item for each thing that the user must do or waits for, from mail, Slack, Jira, Granola, Drive, GitHub, Bitbucket, and the calendar. Each item has its group (Now, Today, This week, After this week, No due date, Waiting on others), title, asker, source, due, why, and id. Use it first for a question on what the user owes or what needs attention. A closed item shows only when you ask for the group closed_today. A code item says that a code exists and never gives its value: send the user to the Needs you page to copy it.",
  category: 'tasks',
  mutating: false,
  input: z.object({
    group: z
      .enum(NEEDS_YOU_GROUP_ORDER as unknown as [NeedsYouGroupId, ...NeedsYouGroupId[]])
      .optional()
      .describe('Only this group.'),
    source: z.enum(OBLIGATION_SOURCES).optional().describe('Only items from this source.'),
  }),
  output: z.object({
    enabled: z.boolean(),
    items: z.array(ListItem),
    counts: z.record(z.string(), z.number()).optional(),
    total: z.number().optional(),
    summary: z.string().optional(),
    message: z.string().optional(),
  }),
  async handler({ group, source }, ctx) {
    const userId = userIdOf(ctx);
    const off = { enabled: false, items: [], message: OFF_MESSAGE };
    if (!needsYouToolDeps.service.flag(userId)) return off;
    const snapshot = await needsYouToolDeps.snapshot(userId);
    if (!snapshot.enabled) return off;
    const wanted = source ? snapshot.items.filter((item) => item.source === source) : snapshot.items;
    const codes = snapshot.items.flatMap((item) => (item.code?.value ? [item.code.value] : []));
    const groups = groupNeedsYou(wanted, [], needsYouToolDeps.now(), snapshot.timezone);
    const counts = Object.fromEntries(groups.map((entry) => [entry.id, entry.entries.length]));
    const shown = groups.filter((entry) => (group ? entry.id === group : entry.id !== CLOSED_GROUP));
    const rows = shown.flatMap((entry) =>
      entry.entries.flatMap((row) =>
        row.type === 'obligation' ? [listItem(row.obligation, entry.id, codes)] : [],
      ),
    );
    return {
      enabled: true,
      items: rows.slice(0, LIST_LIMIT),
      counts,
      total: rows.length,
      summary: countLine(counts),
    };
  },
});

const ActionResult = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  state: z.enum(OBLIGATION_STATES).optional(),
  title: z.string().optional(),
  asker: z.string().optional(),
  snoozedUntil: z.string().optional(),
  undoUntil: z.string().optional(),
  operationId: z.string().optional(),
  summary: z.string().optional(),
  message: z.string().optional(),
});

/** Runs one action through the page's service and records the Undo for Activity. */
async function runAction(name: string, verb: string, id: string, action: ObligationAction, ctx: ToolContext) {
  const caller = callerOf(ctx);
  if (!needsYouToolDeps.service.flag(caller.userId)) return { ok: false, message: OFF_MESSAGE };
  const { obligation, undoUntil } = await runObligationAction(caller, id, action, needsYouToolDeps.service);
  const named = safeTitleOf(obligation);
  const operationId = await needsYouToolDeps.recordOperation({
    userId: caller.userId,
    tool: name,
    surface: 'albatross',
    summary: `${verb}: ${named.title}`,
    target: { obligationId: id },
    ...(undoUntil ? { inverse: { kind: UNDO_KIND, payload: { id } } } : {}),
  });
  return {
    ok: true,
    id,
    state: obligation.state,
    ...named,
    ...(obligation.snoozedUntil ? { snoozedUntil: isoOf(obligation.snoozedUntil) } : {}),
    ...(undoUntil ? { undoUntil: isoOf(undoUntil) } : {}),
    ...(operationId ? { operationId } : {}),
    summary: undoUntil ? 'Undo stays open for 10 seconds.' : undefined,
  };
}

/** The Undo of a chat action: the page's Undo, with the same window. */
export async function undoNeedsYouAction(payload: { id?: unknown }, ctx: { userId: string }) {
  await runObligationAction(
    { userId: ctx.userId },
    String(payload?.id ?? ''),
    { action: 'undo' },
    needsYouToolDeps.service,
  );
}

registerUndoExecutor(UNDO_KIND, undoNeedsYouAction);

const ItemInput = z.object({ id: z.string().min(1).describe('The item id from needs_you_list.') });

export const needsYouDone = defineTool({
  name: 'needs_you_done',
  description:
    'Mark one Needs you item done, as the Done button on the page does. It closes the item and sends nothing. Undo stays open for 10 seconds. Call it only when the user says that the item is done.',
  category: 'tasks',
  mutating: true,
  risk: 'write_self',
  input: ItemInput,
  output: ActionResult,
  handler: ({ id }, ctx) => runAction('needs_you_done', 'Marked done', id, { action: 'done' }, ctx),
});

export const needsYouLater = defineTool({
  name: 'needs_you_later',
  description:
    'Move one Needs you item to a later time, as the Later button on the page does. It comes back at that time in the app, with no push. The time must be in the future and at most 90 days away. Undo stays open for 10 seconds.',
  category: 'tasks',
  mutating: true,
  risk: 'write_self',
  input: ItemInput.extend({
    until: z
      .string()
      .min(1)
      .describe("When it comes back: an ISO time. A time with no offset is the user's."),
  }),
  output: ActionResult,
  async handler({ id, until }, ctx) {
    const wake = parseIsoInTimezone(until, ctx.userTimezone, 'until');
    return runAction('needs_you_later', 'Moved to later', id, { action: 'later', until: wake }, ctx);
  },
});

export const needsYouNotMine = defineTool({
  name: 'needs_you_not_mine',
  description:
    'Mark one Needs you item as not for the user, as the Not mine button on the page does. It closes the item. For mail it also records that this thread is not for the user, and closes the other items of the thread. Undo stays open for 10 seconds. Call it only when the user says so.',
  category: 'tasks',
  mutating: true,
  risk: 'write_self',
  input: ItemInput,
  output: ActionResult,
  handler: ({ id }, ctx) =>
    runAction('needs_you_not_mine', 'Marked not mine', id, { action: 'not_mine' }, ctx),
});

export const NEEDS_YOU_TOOLS = [needsYouList, needsYouDone, needsYouLater, needsYouNotMine];
