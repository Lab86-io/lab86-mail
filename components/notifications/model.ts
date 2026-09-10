import { isClosed } from '@/lib/albatross/work-state';
import { migratePrimaryView, type PrimaryView } from '@/lib/shared/types';

export interface NotificationRow {
  _id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  entityKind?: string;
  entityId?: string;
  deepLink: string;
  dedupeKey?: string;
  createdAt: number;
}

export interface PendingQuestion {
  question: { _id: string; prompt: string; reason?: string; createdAt?: number; dedupeKey?: string };
  work: null | { _id: string; title?: string; rawText: string; workState?: string; status?: string };
  project: null | { _id: string; title: string; areaId?: string };
  routine: null | { _id: string; title: string; areaId?: string };
}

export interface PendingApproval {
  _id: string;
  title: string;
  detail?: string;
  intentId?: string;
  status: string;
  createdAt?: number;
}

export type NotificationAction =
  | { kind: 'work'; workId: string; areaId?: string }
  | { kind: 'area'; areaId: string }
  | { kind: 'checkin'; checkinId: string }
  | { kind: 'url'; url: string }
  | { kind: 'view'; view: PrimaryView }
  | { kind: 'today' }
  | { kind: 'albatrosses' };

export interface NotificationItem {
  id: string;
  kind: 'question' | 'approval' | 'checkin' | 'update';
  title: string;
  body: string;
  context: string;
  source: string;
  createdAt?: number;
  attention: boolean;
  unread: boolean;
  notificationIds: string[];
  unreadNotificationIds: string[];
  action: NotificationAction | null;
  actionLabel: string;
}

export interface NotificationProjection {
  attention: NotificationItem[];
  updates: NotificationItem[];
  count: number;
  unreadUpdates: number;
}

export function visibleExecutionNotifications<T extends Pick<NotificationRow, 'type'>>(rows: T[]): T[] {
  return rows.filter(
    (row) => row.type !== 'mail_message' && row.type !== 'urgent_mail' && row.type !== 'work_wake',
  );
}

export function notificationAction(row: NotificationRow): NotificationAction | null {
  if (row.entityKind === 'work' && row.entityId) return { kind: 'work', workId: row.entityId };
  if (row.entityKind === 'area' && row.entityId) return { kind: 'area', areaId: row.entityId };
  // Notifications are durable, potentially old data. Never follow arbitrary
  // external URLs or protocols from a notification payload.
  if (
    /^\/(?!\/)/.test(row.deepLink) &&
    ![...row.deepLink].some((character) => character === '\\' || character.charCodeAt(0) < 32)
  ) {
    const link = new URL(row.deepLink, 'https://albatross.invalid');
    if (link.pathname === '/') {
      const workId = link.searchParams.get('work');
      if (workId) return { kind: 'work', workId };
      const areaId = link.searchParams.get('area');
      if (areaId) return { kind: 'area', areaId };
      const view = migratePrimaryView(link.searchParams.get('view'));
      if (view === 'today' || view === 'albatrosses') return { kind: view };
      if (view) return { kind: 'view', view };
    }
    return { kind: 'url', url: row.deepLink };
  }
  if (row.type === 'brief_ready' && !row.entityKind) return { kind: 'today' };
  return null;
}

const unreadStatus = (status: string) => status === 'queued' || status === 'delivered';

/** One deterministic projection powers both the footer badge and destination. */
export function projectNotifications(input: {
  notifications: NotificationRow[];
  questions: PendingQuestion[];
  approvals: PendingApproval[];
  checkin: null | { _id: string; status: string; localDate: string; createdAt?: number };
}): NotificationProjection {
  const items = new Map<string, NotificationItem>();
  const questionDeliveryIds = new Map<string, string>();
  for (const row of input.questions) {
    const id = `question:${row.question._id}`;
    questionDeliveryIds.set(id, id);
    // Routine scheduling stores the same durable run identity under two
    // prefixes. Match that exact run, never every question in its project.
    if (row.routine && row.question.dedupeKey?.startsWith(`routine-question:${row.routine._id}:`)) {
      questionDeliveryIds.set(
        row.question.dedupeKey.replace(/^routine-question:/, 'routine-notification:'),
        id,
      );
    }
    const closed = !!row.work && isClosed(row.work);
    items.set(id, {
      id,
      kind: 'question',
      title: row.question.prompt,
      body: row.question.reason || 'Your answer helps Albatross choose the next step.',
      context: `${row.work?.title || row.work?.rawText || row.project?.title || row.routine?.title || 'Albatross'}${closed ? ' · you put this down' : ''}`,
      source: 'Question',
      createdAt: row.question.createdAt,
      attention: !closed,
      unread: false,
      notificationIds: [],
      unreadNotificationIds: [],
      action: row.work
        ? { kind: 'work', workId: row.work._id, areaId: row.routine?.areaId || row.project?.areaId }
        : row.routine?.areaId || row.project?.areaId
          ? { kind: 'area', areaId: (row.routine?.areaId || row.project?.areaId)! }
          : { kind: 'albatrosses' },
      actionLabel: 'Answer in Albatross',
    });
  }
  for (const row of input.approvals) {
    if (row.status !== 'pending' && row.status !== 'claiming') continue;
    const id = `approval:${row._id}`;
    items.set(id, {
      id,
      kind: 'approval',
      title: row.title,
      body: row.detail || 'Review the proposed action before it goes ahead.',
      context: row.status === 'claiming' ? 'Approval is being processed' : 'Waiting for your decision',
      source: 'Approval',
      createdAt: row.createdAt,
      attention: true,
      unread: false,
      notificationIds: [],
      unreadNotificationIds: [],
      action: row.intentId ? { kind: 'work', workId: row.intentId } : { kind: 'albatrosses' },
      actionLabel: 'Review approval',
    });
  }
  if (input.checkin && ['scheduled', 'open'].includes(input.checkin.status)) {
    const row = input.checkin;
    const id = `checkin:${row._id}`;
    items.set(id, {
      id,
      kind: 'checkin',
      title: 'Close the loop on your day',
      body: 'What moved today? What would you like to do tomorrow?',
      context: row.localDate,
      source: 'Daily check-in',
      createdAt: row.createdAt,
      attention: true,
      unread: false,
      notificationIds: [],
      unreadNotificationIds: [],
      action: { kind: 'checkin', checkinId: row._id },
      actionLabel: 'Check in',
    });
  }
  for (const row of [...visibleExecutionNotifications(input.notifications)].sort(
    (a, b) => b.createdAt - a.createdAt,
  )) {
    if (['dismissed', 'expired', 'acted'].includes(row.status)) continue;
    // Work-level conductor notices can describe independent missed moves or
    // staleness decisions. Only explicit question identity proves a duplicate.
    const relatedId =
      row.type === 'work_question' && row.dedupeKey
        ? questionDeliveryIds.get(row.dedupeKey)
        : row.entityId && row.entityKind === 'checkin'
          ? `checkin:${row.entityId}`
          : row.entityId && row.entityKind === 'approval'
            ? `approval:${row.entityId}`
            : undefined;
    const existing =
      (relatedId && items.get(relatedId)) || items.get(`notification:${row.dedupeKey || row._id}`);
    if (existing) {
      if (!existing.notificationIds.includes(row._id)) existing.notificationIds.push(row._id);
      if (unreadStatus(row.status) && !existing.unreadNotificationIds.includes(row._id)) {
        existing.unreadNotificationIds.push(row._id);
      }
      // Put-down work remains reachable but never demands attention.
      existing.unread =
        existing.unreadNotificationIds.length > 0 && !(existing.kind === 'question' && !existing.attention);
      continue;
    }
    const id = `notification:${row.dedupeKey || row._id}`;
    const action = notificationAction(row);
    items.set(id, {
      id,
      kind: 'update',
      title: row.title,
      body: row.body,
      context:
        row.type === 'work_question'
          ? 'Albatross update'
          : row.type === 'agent_error'
            ? 'Agent update'
            : 'Albatross',
      source: row.type === 'brief_ready' ? 'Brief' : row.type === 'agent_error' ? 'Agent' : 'Update',
      createdAt: row.createdAt,
      attention: false,
      unread: unreadStatus(row.status),
      notificationIds: [row._id],
      unreadNotificationIds: unreadStatus(row.status) ? [row._id] : [],
      action,
      actionLabel: action?.kind === 'today' ? 'Open Today' : 'Open context',
    });
  }
  const attention = [...items.values()].filter((row) => row.attention);
  const updates = [...items.values()]
    .filter((row) => !row.attention)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const unreadUpdates = updates.filter((row) => row.unread).length;
  return { attention, updates, unreadUpdates, count: attention.length + unreadUpdates };
}

export type NotificationFilter = 'all' | 'unread' | 'question' | 'approval' | 'checkin';
export interface NotificationViewState {
  filter: NotificationFilter;
  selectedId: string | null;
  scrollTop: number;
}
export const INITIAL_NOTIFICATION_VIEW: NotificationViewState = {
  filter: 'all',
  selectedId: null,
  scrollTop: 0,
};

export function parseNotificationViewState(raw: string | null): NotificationViewState {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value !== 'object') return INITIAL_NOTIFICATION_VIEW;
    return {
      filter: ['all', 'unread', 'question', 'approval', 'checkin'].includes(value.filter)
        ? value.filter
        : 'all',
      selectedId:
        typeof value.selectedId === 'string' && value.selectedId.length < 600 ? value.selectedId : null,
      scrollTop: Number.isFinite(value.scrollTop) && value.scrollTop >= 0 ? value.scrollTop : 0,
    };
  } catch {
    return INITIAL_NOTIFICATION_VIEW;
  }
}

export function filterNotificationItems(items: NotificationItem[], filter: NotificationFilter) {
  return items.filter(
    (item) =>
      filter === 'all' || (filter === 'unread' ? item.unread || item.attention : item.kind === filter),
  );
}
