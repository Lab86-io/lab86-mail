// Shape action execution (docs/chat-agentic-pass.md, section 3).
//
// One ShapeAction maps to either a navigation through the client store or a
// mutation through the tool registry. The dependencies are injected so the
// mapping is testable without a browser; components/ai-elements/shapes/
// shape-actions.ts binds the real store, callTool, and query client.

import type { ShapeAction } from '../ai/tool-shapes';

export type RsvpStatus = 'yes' | 'no' | 'maybe';

export interface ShapeActionStore {
  setPrimaryView: (view: 'mail' | 'calendar' | 'tasks' | 'albatrosses' | 'areas' | 'files') => void;
  setSelectedThread: (id: string | null) => void;
  setThreadAccount: (account: string | null) => void;
  setPendingReplyBody: (body: string | null) => void;
  setPendingOpenWorkId: (workId: string | null) => void;
  setSelectedWorkId: (workId: string | null) => void;
  setSelectedAreaId: (areaId: string | null) => void;
  setCalendarSearchTarget: (
    target: { accountId: string; calendarId: string; eventId: string; startIso: string } | null,
  ) => void;
  setPendingOpenCardId: (cardId: string | null) => void;
  setPendingOpenBoardId: (boardId: string | null) => void;
}

export interface ShapeActionDeps {
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  store: ShapeActionStore;
  /** Push the Files deep link and raise the navigate event. */
  openDocument: (documentId: string, path?: string) => void;
  openUrl: (url: string) => void;
  /** Invalidate react-query caches after a mutation. */
  invalidate: (queryKeys: string[]) => void;
  now?: () => number;
  /** The account to use for hold_slot when the shape has none. */
  defaultAccount?: string;
}

export interface ShapeActionOptions {
  rsvp?: RsvpStatus;
  note?: string;
}

export type ShapeActionResult =
  | { kind: 'navigated' }
  | { kind: 'done'; label: string; operationId?: string }
  | { kind: 'error'; message: string };

/** 8:00 the next morning, local time. */
export function snoozeUntilTomorrow(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

/** The visible label for an action button. */
export function actionLabel(action: ShapeAction, rsvp?: RsvpStatus): string {
  switch (action.kind) {
    case 'open_thread':
    case 'open_event':
    case 'open_task':
    case 'open_work':
    case 'open_area':
    case 'open_document':
      return 'Open';
    case 'open_board':
      return 'Open board';
    case 'open_url':
      return action.label || 'Open link';
    case 'reply_thread':
      return 'Reply';
    case 'archive_thread':
      return 'Archive';
    case 'snooze_thread':
      return 'Snooze';
    case 'rsvp_event':
      return rsvp === 'no' ? 'Decline' : rsvp === 'maybe' ? 'Maybe' : 'Accept';
    case 'delete_event':
      return 'Delete';
    case 'hold_slot':
      return 'Hold';
    case 'complete_task':
      return 'Complete';
    case 'import_file':
      return 'Import';
    case 'undo_operation':
      return 'Undo';
    case 'remember_sender':
      return 'Remember';
  }
}

export interface ActionEntry {
  key: string;
  label: string;
  action: ShapeAction;
  rsvp?: RsvpStatus;
  /** Ask before running: a two-button row inside the card. */
  confirm?: boolean;
  /** Needs a short text from the user before running. */
  prompt?: 'note';
  danger?: boolean;
  /** True when the action changes data. Navigation is false. */
  mutating: boolean;
}

const NAVIGATION_KINDS = new Set<ShapeAction['kind']>([
  'open_thread',
  'reply_thread',
  'open_event',
  'open_task',
  'open_board',
  'open_work',
  'open_area',
  'open_document',
  'open_url',
]);

export function isNavigationAction(action: ShapeAction): boolean {
  return NAVIGATION_KINDS.has(action.kind);
}

/**
 * Expand a shape's actions into button entries. RSVP becomes three entries
 * (Accept first, Decline and Maybe after); delete asks for confirmation;
 * remember asks for the note. Order is kept: the first entry is primary.
 */
export function planActionEntries(actions: ShapeAction[]): ActionEntry[] {
  const entries: ActionEntry[] = [];
  actions.forEach((action, index) => {
    const base = `${action.kind}-${index}`;
    const mutating = !isNavigationAction(action);
    if (action.kind === 'rsvp_event') {
      for (const rsvp of ['yes', 'no', 'maybe'] as const) {
        entries.push({ key: `${base}-${rsvp}`, label: actionLabel(action, rsvp), action, rsvp, mutating });
      }
      return;
    }
    entries.push({
      key: base,
      label: actionLabel(action),
      action,
      mutating,
      confirm: action.kind === 'delete_event' || undefined,
      prompt: action.kind === 'remember_sender' ? 'note' : undefined,
      danger: action.kind === 'delete_event' || undefined,
    });
  });
  return entries;
}

/** The visible entries (at most two) and the rest for the menu. */
export function splitActionEntries(
  entries: ActionEntry[],
  visible = 2,
): { visible: ActionEntry[]; more: ActionEntry[] } {
  return { visible: entries.slice(0, visible), more: entries.slice(visible) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'That did not work.';
}

const MAIL_KEYS = ['search', 'thread'];

/** Run one action. Navigation resolves at once; mutations await the tool. */
export async function executeShapeAction(
  action: ShapeAction,
  deps: ShapeActionDeps,
  options: ShapeActionOptions = {},
): Promise<ShapeActionResult> {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  try {
    switch (action.kind) {
      case 'open_thread':
        store.setThreadAccount(action.account);
        store.setSelectedThread(action.threadId);
        store.setPrimaryView('mail');
        return { kind: 'navigated' };
      case 'reply_thread':
        // The same path the ui_open_reply tool takes in AIBar.
        store.setThreadAccount(action.account);
        store.setSelectedThread(action.threadId);
        store.setPendingReplyBody('');
        store.setPrimaryView('mail');
        return { kind: 'navigated' };
      case 'open_event':
        // setPrimaryView clears the calendar target unless the view is the
        // calendar, so the view goes first.
        store.setPrimaryView('calendar');
        store.setCalendarSearchTarget({
          accountId: action.account,
          calendarId: action.calendarId || '',
          eventId: action.eventId,
          startIso: action.startIso || '',
        });
        return { kind: 'navigated' };
      case 'open_task':
        if (action.boardId) store.setPendingOpenBoardId(action.boardId);
        store.setPendingOpenCardId(action.cardId);
        store.setPrimaryView('tasks');
        return { kind: 'navigated' };
      case 'open_board':
        store.setPendingOpenBoardId(action.boardId);
        store.setPrimaryView('tasks');
        return { kind: 'navigated' };
      case 'open_work':
        // AppShell consumes the pending id: it selects the Work and shows it.
        store.setPendingOpenWorkId(action.workId);
        store.setPrimaryView('albatrosses');
        return { kind: 'navigated' };
      case 'open_area':
        // The rail's openArea: a fresh area context carries no stale thread.
        store.setSelectedThread(null);
        store.setSelectedWorkId(null);
        store.setSelectedAreaId(action.areaId);
        store.setPrimaryView('areas');
        return { kind: 'navigated' };
      case 'open_document':
        deps.openDocument(action.documentId, action.path);
        return { kind: 'navigated' };
      case 'open_url':
        if (!/^https?:\/\//i.test(action.url))
          return { kind: 'error', message: 'This link cannot be opened.' };
        deps.openUrl(action.url);
        return { kind: 'navigated' };
      case 'archive_thread':
        await deps.callTool('archive_thread', { account: action.account, threadId: action.threadId });
        deps.invalidate(MAIL_KEYS);
        return { kind: 'done', label: 'Archived' };
      case 'snooze_thread': {
        let messageId = action.messageId;
        if (!messageId) {
          // The snooze tool acts on one message. Look the latest one up.
          const thread = await deps.callTool('get_thread', {
            account: action.account,
            threadId: action.threadId,
          });
          const messages = Array.isArray(thread?.messages) ? thread.messages : [];
          const latest = [...messages].sort((a, b) => (b.date ?? 0) - (a.date ?? 0))[0];
          messageId =
            typeof latest?._id === 'string'
              ? latest._id
              : typeof latest?.id === 'string'
                ? latest.id
                : undefined;
        }
        if (!messageId) return { kind: 'error', message: 'No message to snooze.' };
        await deps.callTool('snooze_thread', {
          account: action.account,
          threadId: action.threadId,
          messageId,
          untilTs: snoozeUntilTomorrow(now()),
        });
        deps.invalidate(MAIL_KEYS);
        return { kind: 'done', label: 'Snoozed until tomorrow' };
      }
      case 'rsvp_event': {
        if (!action.calendarId) return { kind: 'error', message: 'Open this event to choose its calendar.' };
        const status = options.rsvp ?? 'yes';
        const result = await deps.callTool('calendar_rsvp_event', {
          account: action.account,
          calendarId: action.calendarId,
          eventId: action.eventId,
          status,
        });
        deps.invalidate(['calendar']);
        const label = status === 'no' ? 'Declined' : status === 'maybe' ? 'Marked maybe' : 'Accepted';
        return { kind: 'done', label, operationId: result?.operationId };
      }
      case 'delete_event': {
        if (!action.calendarId) return { kind: 'error', message: 'Open this event to choose its calendar.' };
        const result = await deps.callTool('calendar_delete_event', {
          account: action.account,
          calendarId: action.calendarId,
          eventId: action.eventId,
        });
        deps.invalidate(['calendar']);
        return { kind: 'done', label: 'Deleted', operationId: result?.operationId };
      }
      case 'hold_slot': {
        const account = action.account || deps.defaultAccount;
        if (!account) return { kind: 'error', message: 'No calendar account to hold this on.' };
        const result = await deps.callTool('calendar_create_event', {
          account,
          title: action.title || 'Hold',
          startIso: action.startIso,
          endIso: action.endIso,
        });
        deps.invalidate(['calendar']);
        return { kind: 'done', label: 'Held', operationId: result?.operationId };
      }
      case 'complete_task':
        await deps.callTool('tasks_update_card', { cardId: action.cardId, completed: true });
        deps.invalidate(['tasks']);
        return { kind: 'done', label: 'Completed' };
      case 'import_file':
        if (!action.mimeType) return { kind: 'error', message: 'This file type cannot be imported.' };
        await deps.callTool('google_file_import', {
          connectionId: action.connectionId,
          fileId: action.fileId,
          mimeType: action.mimeType,
        });
        deps.invalidate(['documents', 'files']);
        return { kind: 'done', label: 'Imported' };
      case 'undo_operation':
        await deps.callTool('undo_operation', { operationId: action.operationId });
        deps.invalidate([...MAIL_KEYS, 'calendar', 'tasks']);
        return { kind: 'done', label: 'Undone' };
      case 'remember_sender': {
        const notes = (options.note || '').trim();
        if (!notes) return { kind: 'error', message: 'Write the note first.' };
        await deps.callTool('remember', { email: action.email, notes });
        return { kind: 'done', label: 'Remembered' };
      }
    }
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}
