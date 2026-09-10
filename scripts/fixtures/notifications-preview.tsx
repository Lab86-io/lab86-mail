/** Real Notifications UI with synthetic, account-free mutation responses. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type NotificationRow, projectNotifications } from '../../components/notifications/model';
import { NotificationsView } from '../../components/notifications/NotificationsSurface';

const now = Date.UTC(2026, 8, 10, 14);
const initialRows: NotificationRow[] = [
  {
    _id: 'approval-notice',
    type: 'approval',
    title: 'Review the launch email',
    body: 'The email is drafted. Nothing has been sent.',
    status: 'delivered',
    entityKind: 'approval',
    entityId: 'a1',
    deepLink: '/?view=albatrosses',
    createdAt: now,
    dedupeKey: 'approval:a1',
  },
  ...Array.from({ length: 24 }, (_, index) => ({
    _id: `n${index}`,
    type: 'brief_ready',
    title: index === 0 ? 'Your brief is ready' : `Project update ${index}`,
    body: 'A synthetic update about the work. This detail has enough context to understand the next step without opening another page.',
    status: index < 2 ? 'delivered' : 'read',
    deepLink: '/?view=today',
    createdAt: now - (index + 1) * 60_000,
    dedupeKey: `brief:${index}`,
  })),
];

declare global {
  interface Window {
    notificationPreview: {
      failNextRead: boolean;
      failNextDismiss: boolean;
      holdNextDismiss: boolean;
      releaseDismiss?: () => void;
      actions: unknown[];
      reads: string[];
      dismissed: string[];
      resolveApproval?: () => void;
    };
  }
}
window.notificationPreview = {
  failNextRead: false,
  failNextDismiss: false,
  holdNextDismiss: false,
  actions: [],
  reads: [],
  dismissed: [],
};

function Preview() {
  const [rows, setRows] = useState(initialRows);
  const [approvalPending, setApprovalPending] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [loading, setLoading] = useState(() => new URLSearchParams(location.search).has('loading'));
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setLoading(false), 600);
    return () => clearTimeout(timer);
  }, [loading]);
  window.notificationPreview.resolveApproval = () => setApprovalPending(false);
  const projection = projectNotifications({
    notifications: rows,
    questions: [
      {
        question: {
          _id: 'q1',
          prompt: 'Which direction should the launch take?',
          reason: 'The creative direction will shape the next draft.',
          createdAt: now - 300_000,
        },
        work: { _id: 'w1', title: 'Launch Albatross', rawText: 'Launch Albatross', workState: 'active' },
        project: null,
        routine: null,
      },
    ],
    approvals: approvalPending
      ? [
          {
            _id: 'a1',
            title: 'Review the launch email',
            detail: 'The email is drafted. Nothing has been sent.',
            status: 'pending',
            intentId: 'w1',
            createdAt: now,
          },
        ]
      : [],
    checkin: { _id: 'c1', localDate: '2026-09-10', status: 'open', createdAt: now - 600_000 },
  });
  return (
    <div className="flex h-dvh flex-col bg-[var(--color-bg)] font-sans text-[var(--color-text)]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 text-xs">
        <span data-preview-badge>Notifications · {projection.count}</span>
        <button type="button" className="h-11" onClick={() => setMounted(!mounted)}>
          {mounted ? 'Leave notifications' : 'Return to notifications'}
        </button>
      </div>
      <main className="min-h-0 flex-1">
        {mounted && (
          <NotificationsView
            projection={loading ? { attention: [], updates: [], unreadUpdates: 0, count: 0 } : projection}
            isLoading={loading}
            storageKey="notifications-synthetic-view"
            currentMove={{
              workId: 'w1',
              workTitle: 'Launch Albatross',
              stepTitle: 'Review the first draft',
              phase: 'active',
            }}
            onRead={async (item) => {
              if (window.notificationPreview.failNextRead) {
                window.notificationPreview.failNextRead = false;
                throw new Error('Synthetic read failure');
              }
              window.notificationPreview.reads.push(...item.unreadNotificationIds);
              setRows((current) =>
                current.map((row) =>
                  item.unreadNotificationIds.includes(row._id) ? { ...row, status: 'read' } : row,
                ),
              );
            }}
            onDismiss={async (item) => {
              if (window.notificationPreview.failNextDismiss) {
                window.notificationPreview.failNextDismiss = false;
                throw new Error('Synthetic dismiss failure');
              }
              if (window.notificationPreview.holdNextDismiss) {
                window.notificationPreview.holdNextDismiss = false;
                await new Promise<void>((resolve) => {
                  window.notificationPreview.releaseDismiss = resolve;
                });
              }
              window.notificationPreview.dismissed.push(...item.notificationIds);
              setRows((current) =>
                current.map((row) =>
                  item.notificationIds.includes(row._id) ? { ...row, status: 'dismissed' } : row,
                ),
              );
            }}
            onAction={(action) => {
              window.notificationPreview.actions.push(action);
            }}
            onOpenActivity={() => setMounted(false)}
          />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
