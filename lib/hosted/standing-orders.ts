// Standing orders: one list of everything Albatross does on its own, each with
// a pause switch. Web (Settings, Standing orders), iOS, and macOS read and
// write it through /api/standing-orders.
//
// Most switches already have a home (a routine's status, a smart rule's
// `enabled`, the sorting and prepared-work preferences, the one-time code
// cleanup preference). This module reads and writes those homes, so a pause
// here and a change on the original surface are the same change. The Brief
// schedule, the mail watches, and the assistant's risk classes have no other
// home; they live in one per-user document (userDocs kind `standingOrders`).

import type { ToolRisk } from '../ai/approval';
import { runWithAiRequestContext } from '../ai/context';
import { SMART_CATEGORY_LABELS } from '../mail/smart-categories';
import type { SmartCategoryId, SmartRule } from '../shared/types';
import { kvGet, kvList, kvUpsert } from '../store/kv';
import { setSmartRuleEnabled } from '../store/smart-rules';
import { api, convexMutation, convexQuery } from './convex';

export const STANDING_ORDER_SWITCHES = [
  'brief',
  'watches',
  'risk:write_self',
  'risk:reach_person',
  'risk:destructive',
] as const;
export type StandingOrderSwitch = (typeof STANDING_ORDER_SWITCHES)[number];
/** true means paused. */
export type StandingOrderSwitches = Record<StandingOrderSwitch, boolean>;

const DOC_KIND = 'standingOrders';
const DOC_KEY = 'default';

export type StandingOrderGroup = 'schedule' | 'mail' | 'assistant';
/** How the order acts: on its own, as a draft that waits, or only after a question. */
export type StandingOrderMode = 'runs_alone' | 'draft' | 'asks_first';

export interface StandingOrder {
  /** `brief`, `watches`, `sorting`, `prepare`, `code_cleanup`, `routine:<id>`, `rule:<id>`, or `risk:<class>`. */
  id: string;
  group: StandingOrderGroup;
  title: string;
  detail: string;
  mode: StandingOrderMode;
  paused: boolean;
  /** No switch. `risk:read` only: looking things up cannot be paused. */
  locked: boolean;
  /** Sub-items the order covers, for example the Albatrosses a watch waits on. */
  items: Array<{ id: string; label: string; detail?: string }>;
  /** Where the order is edited in full. */
  href?: string;
}

export interface RoutineRow {
  id: string;
  title: string;
  kind: 'task' | 'checkin' | 'task_and_checkin' | 'review';
  cadence: 'daily' | 'weekly' | 'weekdays' | 'custom';
  daysOfWeek: number[] | null;
  localTime: string;
  timezone: string;
  paused: boolean;
  nextRunAt: number | null;
  projectTitle: string | null;
}

export interface WatchRow {
  workId: string;
  title: string;
  kind: 'reply' | 'step';
  waitingOn: string[];
}

export interface StandingOrderSources {
  switches: StandingOrderSwitches;
  routines: RoutineRow[];
  watches: WatchRow[];
  rules: SmartRule[];
  sortingEnabled: boolean;
  prepareEnabled: boolean;
  codeCleanupEnabled: boolean;
}

export function normalizeStandingOrderSwitches(value: unknown): StandingOrderSwitches {
  const paused =
    value && typeof value === 'object' && (value as { paused?: unknown }).paused
      ? ((value as { paused: Record<string, unknown> }).paused ?? {})
      : {};
  return Object.fromEntries(
    STANDING_ORDER_SWITCHES.map((key) => [key, (paused as Record<string, unknown>)[key] === true]),
  ) as StandingOrderSwitches;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function routineWhen(row: RoutineRow): string {
  const at = `at ${row.localTime}`;
  if (row.cadence === 'daily') return `Every day ${at}`;
  if (row.cadence === 'weekdays') return `Every weekday ${at}`;
  const days = (row.daysOfWeek ?? []).filter((day) => day >= 0 && day <= 6).map((day) => DAY_NAMES[day]);
  if (row.cadence === 'weekly') return days.length ? `Every ${days[0]} ${at}` : `Every week ${at}`;
  return days.length ? `${days.join(', ')} ${at}` : `On its own schedule ${at}`;
}

function routineAction(kind: RoutineRow['kind']): string {
  if (kind === 'task') return 'adds a task';
  if (kind === 'checkin') return 'asks a check-in question';
  if (kind === 'review') return 'asks for a review';
  return 'adds a task and asks a check-in question';
}

function ruleDetail(rule: SmartRule): string {
  const who =
    rule.scope === 'sender'
      ? `mail from ${rule.match}`
      : rule.scope === 'domain'
        ? `mail from ${rule.match}`
        : rule.scope === 'subject_pattern'
          ? `mail with “${rule.match}” in the subject`
          : rule.scope === 'thread'
            ? 'one conversation'
            : `mail that matches ${rule.match}`;
  switch (rule.effect) {
    case 'never_main':
      return `Keeps ${who} out of Main.`;
    case 'always_noise':
      return `Files ${who} under Noise.`;
    case 'always_category':
      return `Files ${who} under ${rule.category ? SMART_CATEGORY_LABELS[rule.category as SmartCategoryId] || rule.category : 'a category'}.`;
    case 'always_custom_label':
      return `Files ${who} under a label.`;
    case 'never_custom_label':
      return `Keeps ${who} out of a label.`;
    default:
      return `Sorts ${who}.`;
  }
}

const RISK_ORDERS: Array<{ risk: ToolRisk; title: string; detail: string; mode: StandingOrderMode }> = [
  {
    risk: 'read',
    title: 'Look things up',
    detail: 'Reads your mail, calendar, files, and the web to answer you. It changes nothing.',
    mode: 'runs_alone',
  },
  {
    risk: 'write_self',
    title: 'Change your own things',
    detail:
      'Archives, labels, snoozes, and edits your tasks, notes, and private calendar holds. Each change shows in Activity with Undo.',
    mode: 'runs_alone',
  },
  {
    risk: 'reach_person',
    title: 'Reach another person',
    detail:
      'Scheduled email, invitations, changes that notify attendees, and answers to invitations. Always asks you first.',
    mode: 'asks_first',
  },
  {
    risk: 'destructive',
    title: 'Changes that cannot be undone',
    detail:
      'Deleting a board, a column, a draft, or a label, canceling a scheduled email, and forgetting notes about a person. Always asks you first.',
    mode: 'asks_first',
  },
];

/** Every standing order, in page order: schedule, mail, then the assistant. */
export function buildStandingOrders(sources: StandingOrderSources): StandingOrder[] {
  const orders: StandingOrder[] = [
    {
      id: 'brief',
      group: 'schedule',
      title: 'Daily Brief',
      detail: 'Writes your Brief each morning in your time zone.',
      mode: 'runs_alone',
      paused: sources.switches.brief,
      locked: false,
      items: [],
    },
    ...sources.routines.map(
      (row): StandingOrder => ({
        id: `routine:${row.id}`,
        group: 'schedule',
        title: row.title,
        detail: `${routineWhen(row)}, ${routineAction(row.kind)}${row.projectTitle ? ` for ${row.projectTitle}` : ''}.`,
        mode: 'runs_alone',
        paused: row.paused,
        locked: false,
        items: [],
      }),
    ),
    {
      id: 'sorting',
      group: 'mail',
      title: 'Sorting',
      detail: 'Reads new mail to find what needs a reply, what you wait on, and what can wait.',
      mode: 'runs_alone',
      paused: !sources.sortingEnabled,
      locked: false,
      items: [],
      href: '/settings?tab=jev',
    },
    ...sources.rules.map(
      (rule): StandingOrder => ({
        id: `rule:${rule._id}`,
        group: 'mail',
        title: rule.name,
        detail: ruleDetail(rule),
        mode: 'runs_alone',
        paused: !rule.enabled,
        locked: false,
        items: [],
      }),
    ),
    {
      id: 'watches',
      group: 'mail',
      title: 'Reply and step watches',
      detail: sources.watches.length
        ? `Checks new mail for the replies and confirmations that ${sources.watches.length === 1 ? '1 Albatross waits' : `${sources.watches.length} Albatrosses wait`} on, and checks those steps off.`
        : 'Checks new mail for the replies and confirmations that your Albatrosses wait on. Nothing waits now.',
      mode: 'runs_alone',
      paused: sources.switches.watches,
      locked: false,
      items: sources.watches.map((watch) => ({
        id: watch.workId,
        label: watch.title,
        detail:
          watch.kind === 'reply'
            ? watch.waitingOn.length
              ? `Waits for a reply from ${watch.waitingOn.join(', ')}`
              : 'Waits for a reply'
            : 'Waits for a confirmation',
      })),
    },
    {
      id: 'prepare',
      group: 'mail',
      title: 'Prepared work',
      detail: 'Researches and drafts what is ahead, in the Brief. Drafts wait there until you use them.',
      mode: 'draft',
      paused: !sources.prepareEnabled,
      locked: false,
      items: [],
    },
    {
      id: 'code_cleanup',
      group: 'mail',
      title: 'One-time code cleanup',
      detail: 'After you use a sign-in code from the iPhone keyboard, archives the email that carried it.',
      mode: 'runs_alone',
      paused: !sources.codeCleanupEnabled,
      locked: false,
      items: [],
    },
    ...RISK_ORDERS.map(
      (entry): StandingOrder => ({
        id: `risk:${entry.risk}`,
        group: 'assistant',
        title: entry.title,
        detail: entry.detail,
        mode: entry.mode,
        paused: entry.risk === 'read' ? false : sources.switches[`risk:${entry.risk}` as StandingOrderSwitch],
        locked: entry.risk === 'read',
        items: [],
      }),
    ),
  ];
  return orders;
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

export interface StandingOrderDependencies {
  readSwitches(userId: string): Promise<StandingOrderSwitches>;
  writeSwitches(userId: string, switches: StandingOrderSwitches): Promise<void>;
  overview(userId: string): Promise<{ routines: RoutineRow[]; watches: WatchRow[] }>;
  setRoutinePaused(userId: string, routineId: string, paused: boolean): Promise<void>;
  listRules(userId: string): Promise<SmartRule[]>;
  setRuleEnabled(userId: string, ruleId: string, enabled: boolean): Promise<void>;
  sortingPolicy(userId: string): Promise<{ preferences: any; corrections: unknown[]; revision: number }>;
  saveSortingPolicy(
    userId: string,
    policy: { preferences: any; corrections: unknown[]; revision: number },
  ): Promise<void>;
  contentPreferences(userId: string): Promise<{ enabled: boolean; prepare: boolean }>;
  saveContentPreferences(userId: string, prefs: { enabled: boolean; prepare: boolean }): Promise<void>;
  notificationPreferences(userId: string): Promise<Record<string, any>>;
  saveCodeCleanup(userId: string, current: Record<string, any>, enabled: boolean): Promise<void>;
}

function asUser<T>(userId: string, run: () => Promise<T>) {
  return runWithAiRequestContext({ userId, agent: 'user' }, run);
}

const convexApi = api as any;

export const standingOrderDefaults: StandingOrderDependencies = {
  readSwitches: (userId) =>
    asUser(userId, async () => normalizeStandingOrderSwitches(await kvGet(DOC_KIND, DOC_KEY))),
  writeSwitches: (userId, switches) =>
    asUser(userId, async () => {
      await kvUpsert(DOC_KIND, DOC_KEY, { paused: switches, updatedAt: Date.now() });
    }),
  overview: (userId) => convexQuery(convexApi.standingOrders.overview, { userId }),
  setRoutinePaused: async (userId, routineId, paused) => {
    await convexMutation(convexApi.standingOrders.setRoutinePaused, { userId, routineId, paused });
  },
  listRules: (userId) => asUser(userId, () => kvList<SmartRule>('smartRule', { limit: 1000 })),
  setRuleEnabled: (userId, ruleId, enabled) =>
    asUser(userId, async () => {
      await setSmartRuleEnabled(ruleId, enabled);
    }),
  sortingPolicy: (userId) => convexQuery(convexApi.jev.policy, { userId }),
  saveSortingPolicy: async (userId, policy) => {
    await convexMutation(convexApi.jev.saveSettings, { userId, ...policy });
  },
  contentPreferences: (userId) =>
    asUser(userId, async () => {
      const doc = await kvGet<{ enabled?: boolean; prepare?: boolean }>('contentPreferences', 'default');
      return { enabled: doc?.enabled !== false, prepare: doc?.prepare !== false };
    }),
  saveContentPreferences: async (userId, prefs) => {
    await convexMutation(convexApi.content.savePreferences, { userId, ...prefs });
  },
  notificationPreferences: (userId) =>
    convexQuery(convexApi.albatrossNotifications.mobilePreferences, { userId }),
  saveCodeCleanup: async (userId, current, enabled) => {
    // Only the required fields and this one flag: the mutation keeps every
    // optional field it is not given.
    await convexMutation(convexApi.albatrossNotifications.saveMobilePreferences, {
      userId,
      nativePushEnabled: current.nativePushEnabled,
      newMailPushEnabled: current.newMailPushEnabled,
      eventSuggestionPushEnabled: current.eventSuggestionPushEnabled,
      eveningCheckinEnabled: current.eveningCheckinEnabled,
      eveningCheckinLocalTime: current.eveningCheckinLocalTime,
      inAppEnabled: current.inAppEnabled,
      emailFallbackEnabled: current.emailFallbackEnabled,
      emailFallbackDelayMinutes: current.emailFallbackDelayMinutes,
      timezone: current.timezone,
      oneTimeCodeCleanupEnabled: enabled,
    });
  },
};

export async function listStandingOrders(
  userId: string,
  deps: StandingOrderDependencies = standingOrderDefaults,
): Promise<StandingOrder[]> {
  const [switches, overview, rules, sorting, content, notifications] = await Promise.all([
    deps.readSwitches(userId),
    deps.overview(userId),
    deps.listRules(userId),
    deps.sortingPolicy(userId),
    deps.contentPreferences(userId),
    deps.notificationPreferences(userId),
  ]);
  return buildStandingOrders({
    switches,
    routines: overview.routines,
    watches: overview.watches,
    rules: [...rules].sort((a, b) => b.createdAt - a.createdAt),
    sortingEnabled: sorting.preferences?.enabled !== false,
    prepareEnabled: content.enabled && content.prepare,
    codeCleanupEnabled: notifications.oneTimeCodeCleanupEnabled === true,
  });
}

export class StandingOrderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'StandingOrderError';
  }
}

function isSwitch(id: string): id is StandingOrderSwitch {
  return (STANDING_ORDER_SWITCHES as readonly string[]).includes(id);
}

/** Pause or resume one standing order. Returns the order as it now stands. */
export async function setStandingOrderPaused(
  userId: string,
  id: string,
  paused: boolean,
  deps: StandingOrderDependencies = standingOrderDefaults,
): Promise<StandingOrder> {
  if (id === 'risk:read') throw new StandingOrderError('Looking things up cannot be paused.');
  if (isSwitch(id)) {
    const current = await deps.readSwitches(userId);
    await deps.writeSwitches(userId, { ...current, [id]: paused });
    forgetCachedSwitches(userId);
  } else if (id.startsWith('routine:')) {
    await deps.setRoutinePaused(userId, id.slice('routine:'.length), paused);
  } else if (id.startsWith('rule:')) {
    const ruleId = id.slice('rule:'.length);
    const rules = await deps.listRules(userId);
    if (!rules.some((rule) => rule._id === ruleId)) throw new StandingOrderError('Rule not found.', 404);
    await deps.setRuleEnabled(userId, ruleId, !paused);
  } else if (id === 'sorting') {
    const policy = await deps.sortingPolicy(userId);
    await deps.saveSortingPolicy(userId, {
      preferences: { ...policy.preferences, enabled: !paused },
      corrections: policy.corrections,
      revision: policy.revision,
    });
  } else if (id === 'prepare') {
    const content = await deps.contentPreferences(userId);
    // Resuming prepared work needs connected content on as well.
    await deps.saveContentPreferences(userId, {
      enabled: paused ? content.enabled : true,
      prepare: !paused,
    });
  } else if (id === 'code_cleanup') {
    await deps.saveCodeCleanup(userId, await deps.notificationPreferences(userId), !paused);
  } else {
    throw new StandingOrderError('Unknown standing order.', 404);
  }
  const order = (await listStandingOrders(userId, deps)).find((entry) => entry.id === id);
  if (!order) throw new StandingOrderError('Standing order not found.', 404);
  return order;
}

// ---------------------------------------------------------------------------
// Enforcement reads (agent loop, cron routes)
// ---------------------------------------------------------------------------

// The agent reads the switches once per run, and a cron once per user. A
// short cache keeps a busy chat from reading the same row on every turn; a
// write from this process drops the entry at once.
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: StandingOrderSwitches }>();

function forgetCachedSwitches(userId: string) {
  cache.delete(userId);
}

export function resetStandingOrderCacheForTest() {
  cache.clear();
}

export async function loadStandingOrderSwitches(
  userId: string,
  read: (userId: string) => Promise<StandingOrderSwitches> = standingOrderDefaults.readSwitches,
  now = Date.now(),
): Promise<StandingOrderSwitches> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = await read(userId);
  cache.set(userId, { at: now, value });
  return value;
}

/**
 * Risk classes the user paused for the assistant. A failed read pauses
 * nothing: approval for reaching people and for changes that cannot be undone
 * stays on either way, so the fallback never skips a question.
 */
export async function pausedAssistantRisks(
  userId: string,
  read?: (userId: string) => Promise<StandingOrderSwitches>,
): Promise<Set<ToolRisk>> {
  try {
    const switches = await loadStandingOrderSwitches(userId, read);
    const paused = new Set<ToolRisk>();
    for (const risk of ['write_self', 'reach_person', 'destructive'] as const)
      if (switches[`risk:${risk}`]) paused.add(risk);
    return paused;
  } catch (error) {
    console.warn('[standing-orders] could not read the assistant switches', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return new Set();
  }
}

/** True when the user paused the morning Brief or the mail watches. A failed read runs them. */
export async function isStandingOrderPaused(
  userId: string,
  id: 'brief' | 'watches',
  read?: (userId: string) => Promise<StandingOrderSwitches>,
): Promise<boolean> {
  try {
    return (await loadStandingOrderSwitches(userId, read))[id];
  } catch {
    return false;
  }
}
