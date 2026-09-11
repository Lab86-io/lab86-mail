// A fixture agent turn for the chat preview harness (app/dev/chat-preview).
// It replays a UI message chunk stream with realistic delays: text in short
// word chunks, tool input start → input available → output available with a
// `data-tool-shape` for threads, event, task, receipt, and count; one
// reasoning part; one failed tool; one show_plan. The transport implements
// the AI SDK ChatTransport so useChat consumes it exactly like the network.

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type { ToolShape } from '../ai/tool-shapes';

export interface FixtureStep {
  /** Milliseconds to wait before this chunk. */
  delay: number;
  chunk: UIMessageChunk;
}

const HOUR = 60 * 60 * 1000;

function isoAt(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

/** The five shapes the harness shows. `now` keys the relative dates. */
export function fixtureShapes(now = Date.now()): {
  threads: ToolShape;
  event: ToolShape;
  task: ToolShape;
  receipt: ToolShape;
  count: ToolShape;
} {
  const account = 'jakob@lab86.io';
  const tomorrow = new Date(now + 24 * HOUR);
  tomorrow.setHours(14, 0, 0, 0);
  const threadActions = (threadId: string, messageId: string) =>
    [
      { kind: 'open_thread', account, threadId },
      { kind: 'archive_thread', account, threadId },
      { kind: 'snooze_thread', account, threadId, messageId },
    ] as const;
  return {
    threads: {
      kind: 'threads',
      title: 'Threads from Acme',
      account,
      activity: {
        running: 'Searching mail for from:acme',
        done: 'Searched mail for from:acme',
        failed: 'Could not search mail',
      },
      actions: [],
      total: 11,
      items: [
        {
          account,
          threadId: 't1',
          messageId: 'm1',
          subject: 'Q4 renewal terms',
          from: 'Dana Whitfield <dana@acme.com>',
          fromEmail: 'dana@acme.com',
          dateIso: isoAt(now, -2 * HOUR),
          snippet: 'Attached the revised order form with the discount schedule you asked for.',
          unread: true,
          messageCount: 3,
          actions: [...threadActions('t1', 'm1')],
        },
        {
          account,
          threadId: 't2',
          messageId: 'm2',
          subject: 'Security questionnaire',
          from: 'Priya Nair <priya@acme.com>',
          fromEmail: 'priya@acme.com',
          dateIso: isoAt(now, -26 * HOUR),
          snippet: 'Legal needs the SOC 2 letter before Friday.',
          unread: true,
          messageCount: 1,
          actions: [...threadActions('t2', 'm2')],
        },
        {
          account,
          threadId: 't3',
          messageId: 'm3',
          subject: 'Re: onboarding call notes',
          from: 'Marcus Lee <marcus@acme.com>',
          fromEmail: 'marcus@acme.com',
          dateIso: isoAt(now, -3 * 24 * HOUR),
          snippet: 'Thanks, this is all we need for now.',
          unread: false,
          messageCount: 5,
          actions: [...threadActions('t3', 'm3')],
        },
      ],
    },
    event: {
      kind: 'event',
      title: 'Acme renewal call',
      account,
      activity: {
        running: 'Looking up the calendar',
        done: 'Found the renewal call',
        failed: 'Could not read the calendar',
      },
      actions: [],
      item: {
        account,
        calendarId: 'primary',
        eventId: 'e1',
        title: 'Acme renewal call',
        startIso: tomorrow.toISOString(),
        endIso: new Date(tomorrow.getTime() + 30 * 60 * 1000).toISOString(),
        location: 'Google Meet',
        attendees: ['Dana Whitfield', 'Priya Nair', 'Marcus Lee', 'You'],
        calendarName: 'Work',
        actions: [
          {
            kind: 'open_event',
            account,
            calendarId: 'primary',
            eventId: 'e1',
            startIso: tomorrow.toISOString(),
          },
          { kind: 'rsvp_event', account, calendarId: 'primary', eventId: 'e1' },
          { kind: 'delete_event', account, calendarId: 'primary', eventId: 'e1' },
        ],
      },
    },
    task: {
      kind: 'task',
      title: 'Send Acme the revised order form',
      activity: {
        running: 'Reading the task',
        done: 'Read the task',
        failed: 'Could not read the task',
      },
      actions: [],
      item: {
        cardId: 'c1',
        boardId: 'b1',
        title: 'Send Acme the revised order form',
        description: 'Dana asked for the discount schedule in the order form before the renewal call.',
        column: 'Doing',
        dueIso: isoAt(now, 0),
        priority: 'high',
        labels: ['sales'],
        actions: [
          { kind: 'open_task', boardId: 'b1', cardId: 'c1' },
          { kind: 'complete_task', cardId: 'c1' },
        ],
      },
    },
    receipt: {
      kind: 'receipt',
      title: 'Archived one thread',
      summary: 'The weekly newsletter is out of the inbox.',
      account,
      activity: {
        running: 'Archiving the newsletter',
        done: 'Archived the newsletter',
        failed: 'Could not archive the newsletter',
      },
      surface: 'mail',
      operationId: 'op1',
      target: { threadId: 't9', subject: 'This week in product' },
      actions: [
        { kind: 'undo_operation', operationId: 'op1' },
        { kind: 'open_thread', account, threadId: 't9' },
      ],
    },
    count: {
      kind: 'count',
      title: 'Unread this week',
      summary: 'Inbox, all accounts',
      activity: {
        running: 'Counting unread threads',
        done: 'Counted unread threads',
        failed: 'Could not count unread threads',
      },
      actions: [],
      value: 128,
      label: 'unread threads this week',
    },
  };
}

/** Split text into 3-8 word chunks, each one a text-delta step. */
export function textSteps(id: string, text: string, delay = 110): FixtureStep[] {
  const words = text.split(' ');
  const steps: FixtureStep[] = [];
  let index = 0;
  let size = 3;
  while (index < words.length) {
    const slice = words.slice(index, index + size);
    index += size;
    size = size >= 8 ? 3 : size + 2;
    const delta = (steps.length ? ' ' : '') + slice.join(' ');
    steps.push({ delay, chunk: { type: 'text-delta', id, delta } });
  }
  return steps;
}

function toolSteps(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  outcome: { output: unknown; shape?: ToolShape } | { errorText: string },
  delays: { start: number; input: number; output: number },
): FixtureStep[] {
  const steps: FixtureStep[] = [
    { delay: delays.start, chunk: { type: 'tool-input-start', toolCallId, toolName } },
    {
      delay: delays.input,
      chunk: { type: 'tool-input-delta', toolCallId, inputTextDelta: JSON.stringify(input) },
    },
    { delay: 40, chunk: { type: 'tool-input-available', toolCallId, toolName, input } },
  ];
  if ('errorText' in outcome) {
    steps.push({
      delay: delays.output,
      chunk: { type: 'tool-output-error', toolCallId, errorText: outcome.errorText },
    });
    return steps;
  }
  steps.push({
    delay: delays.output,
    chunk: { type: 'tool-output-available', toolCallId, output: outcome.output },
  });
  if (outcome.shape) {
    steps.push({ delay: 0, chunk: { type: 'data-tool-shape', id: toolCallId, data: outcome.shape } });
  }
  return steps;
}

/** The first assistant turn: three lookups, a thought, three actions, a plan. */
export function fixtureTurn(turn: number, now = Date.now()): FixtureStep[] {
  const shapes = fixtureShapes(now);
  const messageId = `fixture-${turn}`;
  if (turn > 0) {
    return [
      { delay: 200, chunk: { type: 'start', messageId } },
      { delay: 0, chunk: { type: 'start-step' } },
      { delay: 300, chunk: { type: 'text-start', id: `${messageId}-t1` } },
      ...textSteps(
        `${messageId}-t1`,
        'That is everything from the first pass. Ask for more when you want the next step.',
      ),
      { delay: 0, chunk: { type: 'text-end', id: `${messageId}-t1` } },
      { delay: 0, chunk: { type: 'finish-step' } },
      { delay: 0, chunk: { type: 'finish' } },
    ];
  }
  return [
    { delay: 350, chunk: { type: 'start', messageId } },
    { delay: 0, chunk: { type: 'start-step' } },
    { delay: 250, chunk: { type: 'text-start', id: `${messageId}-t1` } },
    ...textSteps(`${messageId}-t1`, 'Let me look at your inbox, the calendar, and the board first.'),
    { delay: 0, chunk: { type: 'text-end', id: `${messageId}-t1` } },
    ...toolSteps(
      'c1',
      'search_threads',
      { query: 'from:acme', limit: 8 },
      { output: { ok: true, threads: [], total: 11 }, shape: shapes.threads },
      { start: 300, input: 220, output: 1400 },
    ),
    ...toolSteps(
      'c2',
      'calendar_get_event',
      { account: 'jakob@lab86.io', eventId: 'e1' },
      { output: { ok: true, event: { id: 'e1' } }, shape: shapes.event },
      { start: 120, input: 180, output: 900 },
    ),
    ...toolSteps(
      'c3',
      'tasks_get_card',
      { cardId: 'c1' },
      { output: { ok: true, card: { cardId: 'c1' } }, shape: shapes.task },
      { start: 100, input: 160, output: 700 },
    ),
    { delay: 0, chunk: { type: 'finish-step' } },
    { delay: 200, chunk: { type: 'start-step' } },
    { delay: 100, chunk: { type: 'reasoning-start', id: `${messageId}-r1` } },
    {
      delay: 600,
      chunk: {
        type: 'reasoning-delta',
        id: `${messageId}-r1`,
        delta: 'Two Acme threads need a reply before the renewal call tomorrow. ',
      },
    },
    {
      delay: 700,
      chunk: {
        type: 'reasoning-delta',
        id: `${messageId}-r1`,
        delta: 'The newsletter can go. Count unread for context, then fetch the pricing page.',
      },
    },
    { delay: 500, chunk: { type: 'reasoning-end', id: `${messageId}-r1` } },
    { delay: 200, chunk: { type: 'text-start', id: `${messageId}-t2` } },
    ...textSteps(
      `${messageId}-t2`,
      'Two of those need a reply before the call. I will clear the newsletter.',
    ),
    { delay: 0, chunk: { type: 'text-end', id: `${messageId}-t2` } },
    ...toolSteps(
      'c4',
      'archive_thread',
      { account: 'jakob@lab86.io', threadId: 't9' },
      { output: { ok: true, operationId: 'op1' }, shape: shapes.receipt },
      { start: 300, input: 200, output: 800 },
    ),
    ...toolSteps(
      'c5',
      'count_threads',
      { query: 'is:unread newer_than:7d' },
      { output: { ok: true, count: 128 }, shape: shapes.count },
      { start: 100, input: 180, output: 600 },
    ),
    ...toolSteps(
      'c6',
      'web_fetch',
      { url: 'https://acme.example/pricing' },
      { errorText: 'Fetch timed out after 20s' },
      { start: 100, input: 200, output: 2200 },
    ),
    ...toolSteps(
      'c7',
      'show_plan',
      { title: 'Before the renewal call', steps: [] },
      {
        output: {
          ok: true,
          component: 'plan',
          payload: {
            id: 'plan-1',
            title: 'Before the renewal call',
            description: 'Three steps, in order.',
            todos: [
              { id: 'step-1', label: 'Reply to Dana with the order form', status: 'in_progress' },
              { id: 'step-2', label: 'Send Priya the SOC 2 letter', status: 'pending' },
              { id: 'step-3', label: 'Confirm the call with Marcus', status: 'pending' },
            ],
          },
        },
      },
      { start: 200, input: 300, output: 500 },
    ),
    { delay: 0, chunk: { type: 'finish-step' } },
    { delay: 250, chunk: { type: 'start-step' } },
    { delay: 200, chunk: { type: 'text-start', id: `${messageId}-t3` } },
    ...textSteps(
      `${messageId}-t3`,
      'The pricing page did not load, so the plan leaves it out. Dana and Priya are the two replies that matter before tomorrow at 2 PM, and the order form task is already in Doing. Say the word and I draft both replies now.',
      140,
    ),
    { delay: 0, chunk: { type: 'text-end', id: `${messageId}-t3` } },
    { delay: 0, chunk: { type: 'finish-step' } },
    { delay: 0, chunk: { type: 'finish' } },
  ];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Stream the steps with their delays. Stops on abort. */
export function stepsToStream(steps: FixtureStep[], options: { speed?: number; signal?: AbortSignal } = {}) {
  const speed = options.speed ?? 1;
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      for (const step of steps) {
        if (options.signal?.aborted) break;
        await sleep(step.delay / speed, options.signal);
        if (options.signal?.aborted) break;
        controller.enqueue(step.chunk);
      }
      controller.close();
    },
  });
}

/** A ChatTransport that replays the fixture turn. Each send advances the turn. */
export function createFixtureTransport(options: { speed?: number } = {}): ChatTransport<UIMessage> {
  let turn = 0;
  return {
    async sendMessages({ abortSignal }) {
      const steps = fixtureTurn(turn);
      turn += 1;
      return stepsToStream(steps, { speed: options.speed, signal: abortSignal });
    },
    async reconnectToStream() {
      return null;
    },
  };
}
