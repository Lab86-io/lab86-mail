import {
  composeEditorialDocument,
  defaultEditorialPlan,
  type EditorialPlan,
  editorialModules,
} from '../../lib/brief/editorial';
import { composeBudgetBriefDocument } from '../../lib/mail/brief-budget-document';
import { NOW, report, reportItem } from './jev';

export function editorialFixture() {
  const edition = report([
    reportItem({
      subject: 'Confirm the launch budget',
      sender: 'Maya',
      whyItMatters: 'Maya needs your approval before the launch review.',
    }),
  ]);
  edition.prose = {
    model: 'fixture',
    lede: 'Make room for the launch review. Maya needs a budget decision first; the rest of the day has room to move.',
    yesterday: 'You finished the release checklist yesterday. The remaining decision is the launch budget.',
    weekAhead: 'The team review is on Thursday. Leave Wednesday afternoon for preparation.',
  };
  edition.sections.calendar = [
    {
      account: 'account-a',
      eventId: 'review',
      title: 'Launch review',
      startAt: NOW + 3_600_000,
      endAt: NOW + 5_400_000,
      scope: 'week',
    },
  ];
  edition.sections.tasks = [
    {
      cardId: 'check',
      boardId: 'launch',
      columnId: 'todo',
      title: 'Review the support handoff',
      description: 'Confirm the owner and share the release notes.',
      dueAt: NOW + 86_400_000,
      scope: 'week',
    },
  ];
  const letter = composeBudgetBriefDocument({
    report: edition,
    prose: {
      ...edition.prose,
      lines: { 'account-a:thread-a': 'Maya needs your approval before the launch review.' },
    },
    areas: [
      {
        areaId: 'launch',
        name: 'Launch',
        line: 'The release checklist is complete; support still needs an owner.',
      },
    ],
    timezone: 'America/New_York',
  });
  const modules = editorialModules(edition, letter);
  const plan: EditorialPlan = {
    version: 1,
    regions: [
      {
        id: 'opening',
        summary: 'Today’s review and the decision before it.',
        tree: { kind: 'module', id: 'lede', footprint: 'feature' },
      },
      {
        id: 'decision-and-day',
        summary: 'The budget request alongside the calendar.',
        tree: {
          kind: 'split',
          ratio: 'lead',
          children: [
            {
              kind: 'group',
              title: 'Before the review',
              children: [{ kind: 'module', id: 'thread:account-a:thread-a', emphasis: 'primary' }],
            },
            { kind: 'module', id: 'calendar', presentation: 'timeline' },
          ],
        },
      },
      {
        id: 'progress-and-next-step',
        summary: 'Yesterday’s progress and the next task.',
        tree: {
          kind: 'split',
          ratio: 'balanced',
          children: [
            { kind: 'module', id: 'yesterday' },
            { kind: 'module', id: 'tasks', presentation: 'checklist' },
          ],
        },
      },
      {
        id: 'looking-ahead',
        summary: 'The week ahead and the launch area.',
        tree: {
          kind: 'split',
          ratio: 'balanced',
          children: [
            { kind: 'module', id: 'week-ahead' },
            { kind: 'module', id: 'area::launch', presentation: 'compact' },
          ],
        },
      },
      ...defaultEditorialPlan(
        modules.filter(
          (module) =>
            ![
              'lede',
              'thread:account-a:thread-a',
              'calendar',
              'yesterday',
              'tasks',
              'week-ahead',
              'area::launch',
            ].includes(module.id),
        ),
      ).regions,
    ],
  };
  edition.document = composeEditorialDocument(letter, modules, plan);
  edition.editorial = { plan, mode: 'generated' };
  return { edition, letter, modules, plan };
}
