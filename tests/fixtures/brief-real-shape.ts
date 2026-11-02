import { composeBudgetBriefDocument } from '../../lib/mail/brief-budget-document';
import type { DailyReport, DailyReportItem } from '../../lib/shared/types';
import { assessment, NOW, report, reportItem } from './jev';

// An edition with the shape and the size of a real production edition: 260 KB in
// total, 221 KB of `sections`, 118 KB of `sections.overflow`. Every person,
// address, and subject is invented.
const PEOPLE = ['Maya Okafor', 'Lars Whitfield', 'Priya Nandakumar', 'Theo Marchetti', 'Ines Valcourt'];

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fullItem(index: number, patch: Partial<DailyReportItem> = {}): DailyReportItem {
  const person = PEOPLE[index % PEOPLE.length];
  const evidence =
    `${person} wrote that the review needs an answer before the planning call on Thursday. `.repeat(3);
  return reportItem({
    threadId: `thread-${index}`,
    subject: `Quarter plan review, part ${index}: please confirm the numbers for the launch`,
    people: [person, 'Owner'],
    sender: person,
    senderEmail: `person${index}@example.test`,
    whyItMatters: `${person} needs your answer before the planning call on Thursday.`,
    line: `${person} needs your answer before the planning call on Thursday.`,
    openLoops: [evidence, evidence],
    surfacedBecause: ['jev', 'jev_reply'],
    firstSurfacedAt: NOW - 86_400_000,
    inInbox: true,
    jev: assessment({
      obligations: [
        { kind: 'reply', evidence: { messageId: `m${index}`, text: evidence }, probability: 0.98 },
        { kind: 'action', evidence: { messageId: `m${index}`, text: evidence }, probability: 0.74 },
      ],
    }),
    ...patch,
  });
}

// The stored form of an overflow row (slimOverflowItem in lib/store/daily-reports.ts).
function overflowItem(index: number): DailyReportItem {
  const person = PEOPLE[index % PEOPLE.length];
  return {
    account: 'account-a',
    threadId: `overflow-${index}`,
    subject: `Update ${index} on the vendor contract and the renewal schedule`,
    people: [],
    whyItMatters: `${person} sent a change to the vendor contract that may need a review from you.`,
    line: `${person} sent a change to the vendor contract that may need a review from you.`,
    unread: true,
    sender: person,
    receivedAt: NOW - index * 60_000,
    score: 4,
    budgetLane: 'know',
    lane: 'fyi',
    inInbox: true,
    senderEmail: `person${index}@example.test`,
    jev: {
      sourceRevision: `revision-${index}`,
      meaningfulChange: false,
      obligations: [{ kind: 'reply' }],
    },
  };
}

export function realShapeEdition(): DailyReport {
  const answer = [0, 1, 2, 3, 4].map((index) => fullItem(index));
  const today = [5, 6, 7, 8].map((index) => fullItem(index, { budgetLane: 'today' }));
  const know = [9, 10, 11].map((index) => fullItem(index, { budgetLane: 'know' }));
  const edition = report(answer);
  const overflow: DailyReportItem[] = [];
  while (bytes(overflow) < 118_000) overflow.push(overflowItem(overflow.length));
  edition.sections = {
    ...edition.sections,
    answer,
    today,
    know,
    overflow,
    replyOwed: answer,
    timeSensitive: today,
    waiting: [fullItem(20, { budgetLane: undefined }), fullItem(21, { budgetLane: undefined })],
    calendar: Array.from({ length: 20 }, (_, index) => ({
      account: 'account-a',
      eventId: `event-${index}`,
      title: `Planning call ${index}`,
      startAt: NOW + index * 3_600_000,
      endAt: NOW + index * 3_600_000 + 1_800_000,
      location: 'Room 12',
      description: 'Review the quarter plan and the launch numbers. '.repeat(4),
      scope: 'week' as const,
    })),
    mcp: [
      { server: 'github', kind: 'pull_request', title: 'Stage the launch', state: 'open' },
      { server: 'slack', kind: 'mention', title: 'Launch channel' },
    ],
    tasks: [
      {
        cardId: 'card-a',
        boardId: 'board-a',
        columnId: 'todo',
        title: 'Review the support handoff',
        scope: 'week',
      },
    ],
  };
  // Grow the legacy lanes until `sections` has the real size.
  let filler = 30;
  const tracked: DailyReportItem[] = [];
  while (bytes(edition.sections) + bytes(tracked) < 221_000) tracked.push(fullItem(filler++));
  edition.sections.tracked = tracked;
  const prose = {
    model: 'fixture',
    lede: 'Make room for the planning call. Maya needs a decision on the numbers first.',
    weekAhead: 'The team review is on Thursday. Leave Wednesday afternoon for preparation.',
  };
  edition.prose = prose;
  edition.stats = { ...edition.stats, noise: 42, overflow: overflow.length, selected: 12 };
  edition.services = ['gmail'];
  edition.status = 'ready';
  edition.artifactStatus = 'ready';
  edition.artifactSource = 'document-v2';
  edition.document = composeBudgetBriefDocument({
    report: edition,
    prose: {
      ...prose,
      lines: Object.fromEntries(
        [...answer, ...today, ...know].map((item) => [`${item.account}:${item.threadId}`, item.line || '']),
      ),
    },
    areas: [{ areaId: 'launch', name: 'Launch', line: 'The release checklist is complete.' }],
    timezone: 'America/New_York',
  });
  return edition;
}

export function realShapeBytes(edition: DailyReport) {
  return {
    total: bytes(edition),
    sections: bytes(edition.sections),
    overflow: bytes(edition.sections.overflow),
  };
}
