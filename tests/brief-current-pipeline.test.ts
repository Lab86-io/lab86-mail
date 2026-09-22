import { expect, test } from 'bun:test';
import { projectBriefMail } from '../lib/jev/report';
import { composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import { migrateDailyReport } from '../lib/store/daily-reports';
import { assessment, NOW, policy, report, reportItem, thread } from './fixtures/jev';

function currentEdition() {
  const edition = report();
  edition.prose = {
    lede: 'The launch review is next.',
    yesterday: 'You finished the release checklist yesterday.',
    weekAhead: 'The review is on Thursday.',
    model: 'writer',
  };
  edition.sections.waiting = [
    reportItem({
      threadId: 'waiting-for-legal',
      subject: 'Legal approval',
      lane: 'follow_up_owed',
      budgetLane: 'know',
      jev: assessment({ obligations: [{ ...assessment().obligations[0], kind: 'waiting' }] }),
    }),
  ];
  edition.sections.since = {
    previousGeneratedAt: NOW - 86_400_000,
    completions: [
      { artifactKind: 'work', artifactId: 'release', title: 'Release checklist', completedAt: NOW - 1000 },
    ],
    agentActions: [],
  };
  edition.document = composeBudgetBriefDocument({ report: edition, prose: { ...edition.prose, lines: {} } });
  return edition;
}

test('reading a current edition preserves its recap, waiting threads, and continuity evidence', () => {
  const edition = currentEdition();
  const read = migrateDailyReport(edition, NOW);
  expect(read.prose?.yesterday).toBe(edition.prose!.yesterday);
  expect(read.sections.waiting).toEqual(edition.sections.waiting);
  expect(read.sections.since).toEqual(edition.sections.since);
});

test('a live mail update preserves the recap and unrelated waiting section', () => {
  const edition = currentEdition();
  const live = projectBriefMail(
    edition,
    [thread({ jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })],
    policy,
    NOW,
  );
  expect(live.prose?.yesterday).toBe(edition.prose!.yesterday);
  expect(live.document?.regions.some((region) => region.id === 'yesterday')).toBe(true);
  expect(live.sections.waiting).toEqual(edition.sections.waiting);
});

test('a waiting thread is removed when its latest assessment resolves the obligation', () => {
  const edition = currentEdition();
  const live = projectBriefMail(
    edition,
    [thread({ _id: 'waiting-for-legal', jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })],
    policy,
    NOW,
  );
  expect(live.sections.waiting).toEqual([]);
  expect(JSON.stringify(live.document)).not.toContain('Legal approval');
});

test('a waiting thread with a new request returns to the actionable lane exactly once', () => {
  const edition = currentEdition();
  const live = projectBriefMail(
    edition,
    [thread({ _id: 'waiting-for-legal', jev: assessment({ sourceRevision: 'new-request' }) })],
    policy,
    NOW,
  );
  expect(live.sections.waiting).toEqual([]);
  expect(live.sections.answer?.filter((item) => item.threadId === 'waiting-for-legal')).toHaveLength(1);
});
