import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  filterNotificationItems,
  INITIAL_NOTIFICATION_VIEW,
  type NotificationRow,
  notificationAction,
  type PendingQuestion,
  parseNotificationViewState,
  projectNotifications,
} from '../components/notifications/model';
import { NotificationsView } from '../components/notifications/NotificationsSurface';

const notice = (overrides: Partial<NotificationRow> = {}): NotificationRow => ({
  _id: 'notice-1',
  type: 'brief_ready',
  title: 'Your brief is ready',
  body: 'One thing moved.',
  status: 'delivered',
  deepLink: '/?view=today',
  createdAt: 100,
  ...overrides,
});
const question = (id = 'q1'): PendingQuestion => ({
  question: { _id: id, prompt: 'Which direction?', reason: 'A decision is needed', createdAt: 100 },
  work: { _id: 'w1', rawText: 'Plan the launch', title: 'Launch', workState: 'active' },
  project: null,
  routine: null,
});
const base = { notifications: [], questions: [], approvals: [], checkin: null };

describe('notification attention projection', () => {
  test('exact duplicates and a pending approval are one badge item, not three', () => {
    const row = notice({
      type: 'approval',
      entityKind: 'approval',
      entityId: 'a1',
      dedupeKey: 'approval:a1',
    });
    const projection = projectNotifications({
      ...base,
      notifications: [row, { ...row, _id: 'notice-2' }],
      approvals: [{ _id: 'a1', title: 'Send the plan', status: 'pending' }],
    });
    expect(projection.count).toBe(1);
    expect(projection.updates).toHaveLength(0);
    expect(projection.attention[0].notificationIds).toEqual(['notice-1', 'notice-2']);
    const read = projectNotifications({
      ...base,
      notifications: [{ ...row, status: 'read' }],
      approvals: [{ _id: 'a1', title: 'Send the plan', status: 'pending' }],
    });
    expect(read.count).toBe(1);
    expect(read.attention[0].unread).toBe(false);
  });

  test('opening a question never resolves it, and different questions remain distinct', () => {
    const projection = projectNotifications({
      ...base,
      notifications: [notice({ type: 'work_question', dedupeKey: 'question:q1', status: 'read' })],
      questions: [question(), question('q2')],
    });
    expect(projection.attention.map((item) => item.id)).toEqual(['question:q1', 'question:q2']);
    expect(projection.count).toBe(2);
  });

  test('work-level conductor notices are not incorrectly merged with different questions', () => {
    const projection = projectNotifications({
      ...base,
      notifications: [
        notice({ type: 'work_question', entityKind: 'work', entityId: 'w1', dedupeKey: 'missed-move:w1:10' }),
      ],
      questions: [question()],
    });
    expect(projection.attention).toHaveLength(1);
    expect(projection.updates).toHaveLength(1);
    expect(projection.count).toBe(2);
  });

  test('routine delivery and question share the exact run identity, not the entire routine', () => {
    const today = question();
    today.question.dedupeKey = 'routine-question:r1:2026-09-10';
    today.routine = { _id: 'r1', title: 'Daily reflection', areaId: 'area1' };
    const yesterday = question('q2');
    yesterday.question.dedupeKey = 'routine-question:r1:2026-09-09';
    yesterday.routine = today.routine;
    const projection = projectNotifications({
      ...base,
      questions: [today, yesterday],
      notifications: [notice({ type: 'work_question', dedupeKey: 'routine-notification:r1:2026-09-10' })],
    });
    expect(projection.count).toBe(2);
    expect(projection.updates).toHaveLength(0);
    expect(projection.attention[0].notificationIds).toEqual(['notice-1']);
    expect(projection.attention[1].notificationIds).toEqual([]);
  });

  test('put-down questions remain reachable without badge pressure', () => {
    const q = question();
    q.work!.workState = 'archived';
    const projection = projectNotifications({
      ...base,
      questions: [q],
      notifications: [notice({ type: 'work_question', dedupeKey: 'question:q1' })],
    });
    expect(projection.count).toBe(0);
    expect(projection.updates).toHaveLength(1);
    expect(projection.updates[0].context).toContain('you put this down');
    expect(projection.updates[0].action).toEqual({ kind: 'work', workId: 'w1', areaId: undefined });
  });

  test('current check-in is one outstanding action even after its notice is read or dismissed', () => {
    for (const status of ['delivered', 'read', 'dismissed']) {
      const projection = projectNotifications({
        ...base,
        checkin: { _id: 'c1', localDate: '2026-09-10', status: 'open' },
        notifications: [notice({ type: 'daily_checkin', entityKind: 'checkin', entityId: 'c1', status })],
      });
      expect(projection.count).toBe(1);
      expect(projection.updates).toHaveLength(0);
    }
    expect(
      projectNotifications({ ...base, checkin: { _id: 'c1', localDate: '2026-09-10', status: 'answered' } })
        .count,
    ).toBe(0);
  });

  test('terminal, mail, and wake deliveries do not pollute the execution inbox', () => {
    const notifications = ['acted', 'dismissed', 'expired'].map((status) => notice({ _id: status, status }));
    notifications.push(
      ...['mail_message', 'urgent_mail', 'work_wake'].map((type) => notice({ _id: type, type })),
    );
    const projection = projectNotifications({ ...base, notifications });
    expect(projection.count).toBe(0);
    expect(projection.updates).toEqual([]);
  });

  test('dedupe uses durable identity, not title; counts and unread filters agree', () => {
    const projection = projectNotifications({
      ...base,
      notifications: [
        notice({ dedupeKey: 'brief:1' }),
        notice({ _id: 'duplicate', dedupeKey: 'brief:1' }),
        notice({ _id: 'different', dedupeKey: 'brief:2', status: 'read' }),
      ],
    });
    expect(projection.updates).toHaveLength(2);
    expect(projection.count).toBe(1);
    expect(projection.unreadUpdates).toBe(1);
    expect(filterNotificationItems(projection.updates, 'unread')).toHaveLength(1);
  });

  test('navigation rejects arbitrary external links and preserves supported context', () => {
    for (const deepLink of [
      'javascript:alert(1)',
      '//evil.test',
      '/\\evil.test',
      '/\nevil.test',
      'https://evil.test',
    ]) {
      expect(notificationAction(notice({ type: 'agent_error', deepLink }))).toBeNull();
    }
    expect(notificationAction(notice({ type: 'agent_error', deepLink: '/?view=areas&area=a1' }))).toEqual({
      kind: 'area',
      areaId: 'a1',
    });
    expect(notificationAction(notice({ entityKind: 'work', entityId: 'w1' }))).toEqual({
      kind: 'work',
      workId: 'w1',
    });
  });

  test('known shell destinations use state actions and routine briefs retain their Area context', () => {
    expect(notificationAction(notice({ deepLink: '/?view=today' }))).toEqual({ kind: 'today' });
    expect(notificationAction(notice({ type: 'agent_error', deepLink: '/?view=files' }))).toEqual({
      kind: 'view',
      view: 'files',
    });
    expect(
      notificationAction(notice({ entityKind: 'project', entityId: 'p1', deepLink: '/?area=a1&project=p1' })),
    ).toEqual({ kind: 'area', areaId: 'a1' });
    expect(
      notificationAction(notice({ type: 'agent_error', deepLink: '/settings?tab=connections' })),
    ).toEqual({
      kind: 'url',
      url: '/settings?tab=connections',
    });
  });

  test('view restoration validates filter, position, and selection without saving content', () => {
    expect(parseNotificationViewState('garbage')).toEqual(INITIAL_NOTIFICATION_VIEW);
    expect(parseNotificationViewState('{"filter":"unknown","scrollTop":-10,"selectedId":4}')).toEqual(
      INITIAL_NOTIFICATION_VIEW,
    );
    expect(
      parseNotificationViewState(
        '{"filter":"approval","scrollTop":80,"selectedId":"approval:a1","body":"private"}',
      ),
    ).toEqual({ filter: 'approval', scrollTop: 80, selectedId: 'approval:a1' });
  });

  test('presentation uses semantic sections, meaningful buttons, and the shared counts', () => {
    const projection = projectNotifications({ ...base, questions: [question()], notifications: [notice()] });
    const html = renderToStaticMarkup(
      <NotificationsView
        projection={projection}
        onRead={async () => {}}
        onDismiss={async () => {}}
        onAction={() => {}}
      />,
    );
    expect(html).toContain('Needs your attention');
    expect(html).toContain('1 waiting on you · 1 unread updates');
    expect(html).toContain('Filter notifications');
    expect(html).toContain('Unread');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('Approve</button>');
    expect(html).not.toContain('border-beam');
  });
});
