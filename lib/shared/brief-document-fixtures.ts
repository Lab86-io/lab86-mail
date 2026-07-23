import type { BriefDocumentV2 } from './brief-document';

const now = 1_790_000_000_000;

export const richBriefDocumentFixture: BriefDocumentV2 = {
  version: 2,
  title: 'Thursday Brief',
  summary: 'A product review leads the day, followed by two replies and an afternoon planning block.',
  generatedAt: now,
  regions: [
    {
      id: 'lead',
      intent: "today's one big thing",
      summary: 'Prepare for the product review at 10:00 AM.',
      tree: {
        kind: 'hero',
        emphasis: 'primary',
        tone: 'neutral',
        surface: 'elevated',
        children: [
          {
            kind: 'text',
            emphasis: 'primary',
            tone: 'neutral',
            role: 'kicker',
            text: 'Your day, composed',
          },
          {
            kind: 'text',
            emphasis: 'primary',
            tone: 'neutral',
            role: 'lede',
            text: 'The product review is the hinge of the day. Clear the two replies before it, then protect the afternoon planning block.',
          },
        ],
      },
    },
    {
      id: 'signals',
      summary: 'Two replies, three due tasks, and four events need attention.',
      tree: {
        kind: 'grid',
        emphasis: 'standard',
        tone: 'neutral',
        columns: 3,
        children: [
          {
            kind: 'stat',
            emphasis: 'standard',
            tone: 'urgent',
            label: 'Overdue',
            queryValue: { name: 'tasks_overdue' },
          },
          {
            kind: 'stat',
            emphasis: 'standard',
            tone: 'warning',
            label: 'Due today',
            queryValue: { name: 'tasks_due_today' },
          },
          {
            kind: 'stat',
            emphasis: 'standard',
            tone: 'neutral',
            label: 'Events',
            queryValue: { name: 'events_today' },
          },
        ],
      },
    },
    {
      id: 'work',
      summary: 'The live work queue and day timeline.',
      tree: {
        kind: 'split',
        emphasis: 'standard',
        tone: 'neutral',
        ratio: 'lead',
        children: [
          {
            kind: 'group',
            emphasis: 'standard',
            tone: 'neutral',
            title: 'Needs you',
            kicker: 'Before the review',
            surface: 'plain',
            collapsible: false,
            children: [
              {
                kind: 'entity_list',
                emphasis: 'standard',
                tone: 'neutral',
                variant: 'rows',
                items: [
                  {
                    ref: { kind: 'thread', id: 'thread-1', account: 'account-1', label: 'Launch plan' },
                    framing: { reason: 'A direct question has waited since Tuesday.', lane: 'Reply' },
                    actions: [
                      {
                        action: 'open_thread',
                        label: 'Open',
                        payload: { account: 'account-1', threadId: 'thread-1' },
                        style: 'secondary',
                      },
                      {
                        action: 'resolve_thread',
                        label: 'Resolve',
                        payload: { account: 'account-1', threadId: 'thread-1' },
                        style: 'quiet',
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'query_list',
                emphasis: 'standard',
                tone: 'warning',
                title: 'Due today',
                query: { name: 'tasks_due_today' },
                limit: 6,
                variant: 'compact',
                emptyText: 'Nothing due today.',
              },
            ],
          },
          {
            kind: 'timeline',
            emphasis: 'standard',
            tone: 'neutral',
            title: 'Today',
            items: [
              {
                label: 'Product review',
                at: now + 3_600_000,
                detail: 'Bring the launch-risk decision.',
                ref: { kind: 'event', id: 'event-1', account: 'account-1' },
                actions: [
                  {
                    action: 'open_event',
                    label: 'Open event',
                    payload: { account: 'account-1', eventId: 'event-1' },
                    style: 'secondary',
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      id: 'extras',
      summary: 'A checklist, chart, collection, prompt, and visual detail.',
      tree: {
        kind: 'stack',
        emphasis: 'standard',
        tone: 'neutral',
        density: 'airy',
        children: [
          {
            kind: 'checklist',
            emphasis: 'standard',
            tone: 'neutral',
            title: 'Review prep',
            items: [
              {
                label: 'Read the launch memo',
                detail: 'Focus on the open risk.',
                checked: false,
                ref: { kind: 'task', id: 'task-1' },
                action: {
                  action: 'toggle_task',
                  label: 'Complete',
                  payload: { cardId: 'task-1', completed: true },
                  style: 'quiet',
                },
              },
            ],
          },
          {
            kind: 'chart',
            emphasis: 'standard',
            tone: 'neutral',
            variant: 'bar',
            title: 'Meeting load',
            description: 'Minutes by day',
            data: [
              { label: 'Thu', value: 120 },
              { label: 'Fri', value: 45 },
            ],
            sourceRefs: [{ kind: 'derived', id: 'calendar:week' }],
          },
          {
            kind: 'collection',
            emphasis: 'standard',
            tone: 'neutral',
            title: 'Keep reading',
            variant: 'shelf',
            items: [
              {
                title: 'Launch memo',
                meta: '8 min',
                badge: 'Priority',
                actions: [],
              },
            ],
          },
          {
            kind: 'prompt',
            emphasis: 'standard',
            tone: 'neutral',
            variant: 'capture',
            placeholder: 'Capture something for later…',
          },
          {
            kind: 'actions',
            emphasis: 'standard',
            tone: 'neutral',
            actions: [
              {
                action: 'create_task',
                label: 'Add follow-up task',
                payload: { title: 'Follow up after the product review' },
                style: 'primary',
              },
            ],
          },
          {
            kind: 'divider',
            emphasis: 'muted',
            tone: 'neutral',
            variant: 'flourish',
          },
          {
            kind: 'canvas',
            emphasis: 'muted',
            tone: 'neutral',
            canvasId: 'day-shape',
            title: 'Shape of the day',
            html: '<!doctype html><html><body><p>Morning focus → review → planning</p></body></html>',
            fallbackText: 'Morning focus, then the review, then planning.',
            allowedActions: [],
            height: 'compact',
          },
        ],
      },
    },
  ],
};

export const quietBriefDocumentFixture: BriefDocumentV2 = {
  version: 2,
  title: 'A quiet Friday',
  summary: 'Nothing urgent is waiting. One event and a clear task list leave room for focused work.',
  generatedAt: now,
  regions: [
    {
      id: 'quiet',
      summary: 'Nothing urgent is waiting.',
      tree: {
        kind: 'group',
        emphasis: 'muted',
        tone: 'positive',
        title: 'Room to focus',
        surface: 'plain',
        collapsible: false,
        children: [
          {
            kind: 'text',
            emphasis: 'standard',
            tone: 'positive',
            role: 'lede',
            text: 'Nothing urgent is waiting. Keep the morning open for the work that needs uninterrupted attention.',
          },
          {
            kind: 'query_list',
            emphasis: 'muted',
            tone: 'neutral',
            query: { name: 'events_today' },
            limit: 4,
            variant: 'compact',
            emptyText: 'Your calendar is clear.',
          },
        ],
      },
    },
  ],
};

export const degenerateBriefDocumentFixture = {
  version: 2,
  title: 'Degenerate brief',
  summary: 'Fallback copy survives malformed and future nodes.',
  generatedAt: now,
  regions: [
    {
      id: 'broken',
      summary: 'This region remains readable.',
      tree: {
        kind: 'future_layout',
        emphasis: 'neon',
        children: [
          {
            kind: 'future_leaf',
            fallbackText: 'A future leaf becomes a readable card.',
          },
          {
            kind: 'actions',
            actions: [
              { action: 'future_action', label: 'Dead action', payload: {}, style: 'laser' },
              { action: 'open_view', label: 'Tasks', payload: { view: 'tasks' }, style: 'primary' },
            ],
          },
          {
            kind: 'query_list',
            query: { name: 'future_query' },
            variant: 'tiles',
            emptyText: 'This query is not available yet.',
          },
        ],
      },
    },
  ],
} as const;

export const futureBriefDocumentFixture = {
  version: 3,
  title: 'A future brief',
  summary: 'Update Albatross to see the full composed edition.',
  generatedAt: now,
  regions: [],
} as const;

export const briefDocumentFixtures = {
  rich: richBriefDocumentFixture,
  quiet: quietBriefDocumentFixture,
  degenerate: degenerateBriefDocumentFixture,
  future: futureBriefDocumentFixture,
} as const;
