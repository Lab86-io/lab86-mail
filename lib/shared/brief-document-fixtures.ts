import type { BriefDocumentV2 } from './brief-document';

const now = 1_790_000_000_000;

export const richBriefDocumentFixture: BriefDocumentV2 = {
  version: 2,
  title: 'Thursday Brief',
  summary: 'A product review leads the day, followed by two replies and an afternoon planning block.',
  generatedAt: now,
  timezone: 'UTC',
  regions: [
    {
      id: 'lead',
      intent: "today's one big thing",
      summary: 'Prepare for the product review at 10:00 AM.',
      tree: {
        kind: 'hero',
        footprint: 'feature',
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

// The letter (2026-09-03): lede, three lanes as mail rows, the week ahead,
// three area lines. This is the shape the composer now writes.
function letterThread(
  id: string,
  subject: string,
  lane: 'answer' | 'today' | 'know',
  sender: string,
  reason?: string,
) {
  return {
    ref: { kind: 'thread' as const, id, account: 'jakob@example.com', label: subject },
    framing: { lane, sender, ...(reason ? { reason } : {}) },
    actions: [
      {
        action: 'open_thread',
        label: 'Open',
        payload: { account: 'jakob@example.com', threadId: id },
        style: 'quiet' as const,
      },
    ],
  };
}

export const letterBriefDocumentFixture: BriefDocumentV2 = {
  version: 2,
  title: 'The Thursday Brief',
  summary:
    'Two replies wait on you before the review at ten. The passport form can go out this week. The afternoon is open.',
  generatedAt: now,
  timezone: 'UTC',
  regions: [
    {
      id: 'lede',
      summary: 'Two replies wait on you before the review at ten.',
      tree: {
        kind: 'hero',
        emphasis: 'primary',
        tone: 'neutral',
        surface: 'plain',
        children: [
          {
            kind: 'text',
            emphasis: 'primary',
            tone: 'neutral',
            role: 'lede',
            text: 'Two replies wait on you before the review at ten. The passport form can go out this week. The afternoon is open.',
          },
        ],
      },
    },
    {
      id: 'answer',
      summary: 'Answer: 2 replies owed.',
      tree: {
        kind: 'entity_list',
        emphasis: 'primary',
        tone: 'neutral',
        title: 'Answer',
        variant: 'rows',
        items: [
          letterThread(
            'thread-review-deck',
            'Review deck for Thursday',
            'answer',
            'Maya Chen',
            'Maya sent the deck on Tuesday and asked for your notes before the review.',
          ),
          letterThread(
            'thread-lease',
            'Lease renewal: two options',
            'answer',
            'Daniel Ortiz',
            'The landlord needs a choice by Friday. Both options are in the last message.',
          ),
        ],
      },
    },
    {
      id: 'today',
      summary: 'Today: 1 event; 1 deadline.',
      tree: {
        kind: 'entity_list',
        emphasis: 'standard',
        tone: 'neutral',
        title: 'Today',
        variant: 'rows',
        items: [
          {
            ref: {
              kind: 'event',
              id: 'event-product-review',
              account: 'jakob@example.com',
              label: 'Product review',
            },
            framing: { lane: 'today', reason: '10:00 AM to 10:45 AM, Room 2' },
            actions: [
              {
                action: 'open_event',
                label: 'Open',
                payload: { account: 'jakob@example.com', eventId: 'event-product-review' },
                style: 'quiet',
              },
            ],
          },
          letterThread(
            'thread-passport',
            'Passport renewal: form due',
            'today',
            'Passport Office',
            'The form is due today. The attachment in the first message is the one to send.',
          ),
        ],
      },
    },
    {
      id: 'know',
      summary: 'Know: 1 thread.',
      tree: {
        kind: 'entity_list',
        emphasis: 'standard',
        tone: 'neutral',
        title: 'Know',
        variant: 'rows',
        items: [
          letterThread(
            'thread-vendor',
            'Vendor contract signed',
            'know',
            'Priya Raman',
            'Priya confirmed the signature. No reply is needed.',
          ),
        ],
      },
    },
    {
      id: 'week-ahead',
      summary: 'This Thursday you can send the passport form. Friday is open.',
      tree: {
        kind: 'text',
        emphasis: 'standard',
        tone: 'neutral',
        role: 'body',
        text: 'This Thursday you can send the passport form. The lease answer goes out on Friday morning. Saturday and Sunday are open.',
      },
    },
    {
      id: 'areas',
      summary: 'Areas: Home, Product.',
      tree: {
        kind: 'entity_list',
        emphasis: 'muted',
        tone: 'neutral',
        title: 'Areas',
        variant: 'compact',
        items: [
          {
            ref: { kind: 'area', id: 'area-home', label: 'Home' },
            framing: { reason: 'Choose the lease option before Friday.' },
            actions: [
              { action: 'open_area', label: 'Open', payload: { areaId: 'area-home' }, style: 'quiet' },
            ],
          },
          {
            ref: { kind: 'area', id: 'area-product', label: 'Product' },
            framing: { reason: 'Notes for the review deck are the next move.' },
            actions: [
              { action: 'open_area', label: 'Open', payload: { areaId: 'area-product' }, style: 'quiet' },
            ],
          },
        ],
      },
    },
  ],
};

// The area pulse (2026-09-03): lede, three pulse lines, one prompt, live open work.
export const areaPulseDocumentFixture: BriefDocumentV2 = {
  version: 2,
  title: 'Home',
  summary: 'The lease is the only open decision. Nothing else changed this week.',
  generatedAt: now,
  regions: [
    {
      id: 'lede',
      summary: 'The lease is the only open decision.',
      tree: {
        kind: 'hero',
        emphasis: 'primary',
        tone: 'neutral',
        surface: 'plain',
        children: [
          {
            kind: 'text',
            emphasis: 'primary',
            tone: 'neutral',
            role: 'lede',
            text: 'The lease is the only open decision. Nothing else changed this week.',
          },
        ],
      },
    },
    {
      id: 'pulse',
      summary: 'Last change: Daniel sent two lease options. Next move: choose one.',
      tree: {
        kind: 'stack',
        emphasis: 'standard',
        tone: 'neutral',
        density: 'standard',
        children: [
          {
            kind: 'text',
            emphasis: 'standard',
            tone: 'neutral',
            role: 'body',
            text: 'Last change: Daniel sent two lease options on Tuesday.',
          },
          {
            kind: 'text',
            emphasis: 'standard',
            tone: 'neutral',
            role: 'body',
            text: 'Next move: choose one option and reply before Friday.',
          },
          {
            kind: 'text',
            emphasis: 'standard',
            tone: 'neutral',
            role: 'body',
            text: 'Open question: does the longer term include the parking space?',
          },
        ],
      },
    },
    {
      id: 'ask',
      summary: 'Add a thought to this area.',
      tree: {
        kind: 'prompt',
        emphasis: 'muted',
        tone: 'neutral',
        variant: 'capture',
        placeholder: 'Get this out of my head',
      },
    },
    {
      id: 'open-work',
      summary: 'Open work in this area.',
      tree: {
        kind: 'query_list',
        emphasis: 'standard',
        tone: 'neutral',
        title: 'Open work',
        query: { name: 'area_open_work', areaId: 'area-home' },
        limit: 6,
        variant: 'rows',
        emptyText: 'No open work.',
      },
    },
  ],
};

export const briefDocumentFixtures = {
  rich: richBriefDocumentFixture,
  quiet: quietBriefDocumentFixture,
  degenerate: degenerateBriefDocumentFixture,
  future: futureBriefDocumentFixture,
  letter: letterBriefDocumentFixture,
  areaPulse: areaPulseDocumentFixture,
} as const;
