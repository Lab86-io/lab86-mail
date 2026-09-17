import { useState } from 'react';
import { DailyCheckin } from '../../components/albatross/DailyCheckin';
import { AlbatrossList, AlbatrossRow } from '../../components/albatross/primitives';
import { projectNotifications } from '../../components/notifications/model';
import { NotificationsView } from '../../components/notifications/NotificationsSurface';
import { BriefCanvas } from '../../components/report/brief-canvas/BriefCanvas';
import { AssistantLauncher } from '../../components/shell/ShellActions';
import { Button } from '../../components/ui/button';
import { letterBriefDocumentFixture } from '../../lib/shared/brief-document-fixtures';

const work = [
  { _id: 'reply', title: 'Review the studio proposal', workState: 'needs_you', openQuestions: 1 },
  { _id: 'plan', title: 'Plan the next release', workState: 'active', openQuestions: 0 },
  { _id: 'waiting', title: 'Confirm the delivery date', workState: 'waiting', openQuestions: 0 },
  { _id: 'done', title: 'Share the review notes', workState: 'done', openQuestions: 0 },
];
const checkin = {
  _id: 'style-checkin',
  localDate: '2026-09-15',
  status: 'open',
  candidateItems: [{ kind: 'work' as const, id: 'reply', title: 'Review the studio proposal' }],
};
const projection = projectNotifications({
  notifications: [],
  questions: [
    {
      question: { _id: 'question', prompt: 'Which direction should the proposal take?', createdAt: 1 },
      work: { _id: 'reply', title: 'Studio proposal', rawText: 'Studio proposal', workState: 'active' },
      project: null,
      routine: null,
    },
  ],
  approvals: [{ _id: 'approval', title: 'Review the proposal', status: 'pending', createdAt: 1 }],
  checkin: { ...checkin, createdAt: 1 },
});

export function AlbatrossStylesPreview() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [brief, setBrief] = useState(false);
  return (
    <main className="flex h-dvh flex-col bg-[var(--color-workspace-frame)] p-3 text-[var(--color-text)]">
      <nav aria-label="Preview controls" className="mb-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            setNotifications(false);
            setBrief(false);
          }}
        >
          Work preview
        </Button>
        <Button variant="outline" onClick={() => setBrief(true)}>
          Brief preview
        </Button>
        <Button variant="outline" onClick={() => setNotifications(true)}>
          Notifications preview
        </Button>
        <Button onClick={() => setOpen(true)}>Open check-in</Button>
      </nav>
      <div className="workspace-panel">
        {brief ? (
          <div className="w-full overflow-y-auto p-5">
            <BriefCanvas value={letterBriefDocumentFixture} />
          </div>
        ) : notifications ? (
          <NotificationsView
            projection={projection}
            onRead={async () => {}}
            onDismiss={async () => {}}
            onAction={() => {}}
          />
        ) : (
          <AlbatrossList className="m-5 h-fit w-full">
            {work.map((item) => (
              <li key={item._id}>
                <AlbatrossRow item={{ ...item, rawText: item.title }} onOpen={() => {}} />
              </li>
            ))}
          </AlbatrossList>
        )}
      </div>
      <DailyCheckin checkin={checkin} open={open} onOpenChange={setOpen} />
      {!open && (
        <AssistantLauncher
          placement="corner"
          shortcut="⌘K"
          onOpen={() => setOpen(true)}
          phrases={['Ask', 'Get this off my mind', 'Talk through my brief']}
          rotateMs={600}
        />
      )}
    </main>
  );
}
