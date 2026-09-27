import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { POST } from '../app/api/agent/route';
import {
  APPROVAL_GATED_TOOLS,
  approvalSummary,
  createApprovalAutoContinueGuard,
  respondedApprovalIds,
  toolNeedsApproval,
} from '../lib/ai/approval';
import * as gateway from '../lib/ai/gateway';
import { forwardAgentStream, liftToolsForAgent, runAgent } from '../lib/ai/loop';
import { sanitizeToolPairs } from '../lib/ai/message-sanitize';
import { buildSystemPrompt, isWebOnlyTool, normalizeClientPlatform } from '../lib/ai/system-prompt';
import * as narrative from '../lib/narrative/service';
import * as memories from '../lib/store/memories';
import { TOOLS } from '../lib/tools';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function model(...turns: LanguageModelV3StreamPart[][]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of turns[index++] ?? []) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}

function finish(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
  };
}

function text(value: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: value },
    { type: 'text-end', id: 't' },
  ];
}

const SEND = {
  account: 'acct_1',
  to: 'sam@example.test',
  subject: 'Quarterly numbers',
  body: 'Here they are.',
  scheduledFor: Date.UTC(2031, 0, 2, 15, 0),
};

async function run(
  models: MockLanguageModelV3[],
  messages: ModelMessage[],
  extra: Partial<Parameters<typeof runAgent>[0]> = {},
) {
  const runtimeSpy = spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue(
    models.map((entry, index) => ({
      userId: 'owner',
      source: 'lab86',
      provider: 'openai',
      modelName: `model-${index}`,
      model: entry,
    })) as any,
  );
  const usage = spyOn(gateway, 'recordAgentUsage').mockResolvedValue(undefined);
  const context = spyOn(narrative, 'narrativePrompt').mockResolvedValue('');
  const memory = spyOn(memories, 'listMemories').mockResolvedValue([]);
  const platform = spyOn(gateway, 'hasPlatformAi').mockReturnValue(true);
  for (const spy of [runtimeSpy, usage, context, memory, platform]) restores.push(() => spy.mockRestore());
  const agent = await runAgent({ runId: 'approval-run', userId: 'owner', messages, ...extra });
  const events = (await agent.toUIMessageStreamResponse().text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  return { events, steps: await agent.steps };
}

function handlerSpy(name: string) {
  const spy = spyOn(TOOLS[name], 'handler').mockResolvedValue({ ok: true, scheduleId: 'sched_1' } as any);
  restores.push(() => spy.mockRestore());
  return spy;
}

describe('server-enforced approval for tools that reach another person', () => {
  test('schedule_send stops at an approval request and never runs without an answer', async () => {
    const handler = handlerSpy('schedule_send');
    const { events } = await run(
      [
        model([
          { type: 'tool-call', toolCallId: 'send-1', toolName: 'schedule_send', input: JSON.stringify(SEND) },
          finish('tool-calls'),
        ]),
      ],
      [{ role: 'user', content: 'Schedule the numbers to Sam for Thursday.' }],
      { userTimezone: 'UTC' },
    );
    expect(handler).not.toHaveBeenCalled();
    const request = events.find((event) => event.type === 'tool-approval-request');
    expect(request).toMatchObject({ toolCallId: 'send-1' });
    // Native clients get the card text beside the request.
    const card = events.find((event) => event.type === 'data-tool-approval');
    expect(card).toMatchObject({
      id: 'send-1',
      data: {
        approvalId: request.approvalId,
        toolName: 'schedule_send',
        title: 'Schedule this email to sam@example.test',
        confirmLabel: 'Schedule',
      },
    });
    expect(card.data.metadata).toContainEqual({ label: 'Send at', value: 'Jan 2, 2031, 3:00 PM' });
  });

  const pending = (approved: boolean): ModelMessage[] => [
    { role: 'user', content: 'Schedule the numbers to Sam for Thursday.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'send-1', toolName: 'schedule_send', input: SEND },
        { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'send-1' },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approval-1', approved }] },
  ];

  test('an approved answer runs the call once on the next request', async () => {
    const handler = handlerSpy('schedule_send');
    // No signed-in run here, so the call skips the Convex execution checkpoint.
    const { events } = await run(
      [model([...text('Scheduled.'), finish()])],
      sanitizeToolPairs(pending(true)),
      {
        userId: null,
      },
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ to: 'sam@example.test', subject: 'Quarterly numbers' });
    expect(
      events.some((event) => event.type === 'tool-output-available' && event.toolCallId === 'send-1'),
    ).toBe(true);
  });

  test('a denied answer never runs the call', async () => {
    const handler = handlerSpy('schedule_send');
    const { events } = await run(
      [model([...text('Not sent.'), finish()])],
      sanitizeToolPairs(pending(false)),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'tool-output-denied' && event.toolCallId === 'send-1')).toBe(
      true,
    );
  });

  test('the gate covers invitations and attendee notices, and skips private writes', () => {
    const lifted = liftToolsForAgent('batch', 'UTC');
    for (const name of APPROVAL_GATED_TOOLS) expect(typeof lifted[name].needsApproval).toBe('function');
    for (const name of ['archive_thread', 'tasks_create_card', 'save_draft'])
      expect(lifted[name].needsApproval).toBeUndefined();
    const needs = (name: string, input: unknown) => lifted[name].needsApproval(input, {});
    const event = { account: 'a', title: 'Review', startIso: '2031-01-02T10:00', endIso: '2031-01-02T11:00' };
    expect(needs('schedule_send', SEND)).toBe(true);
    // Malformed input skips the gate so the model gets its field errors first.
    expect(needs('schedule_send', { to: 'sam@example.test' })).toBe(false);
    expect(needs('calendar_create_event', event)).toBe(false);
    expect(needs('calendar_create_event', { ...event, attendees: [{ email: 'sam@example.test' }] })).toBe(
      true,
    );
    expect(needs('calendar_update_event', { matchTitle: 'Review', title: 'Review 2' })).toBe(false);
    expect(needs('calendar_update_event', { matchTitle: 'Review', notifyParticipants: true })).toBe(true);
    expect(needs('calendar_update_event', { eventId: 'e', attendees: [{ email: 'sam@example.test' }] })).toBe(
      true,
    );
    expect(needs('calendar_delete_event', { matchTitle: 'Review' })).toBe(false);
    expect(needs('calendar_delete_event', { matchTitle: 'Review', notifyParticipants: true })).toBe(true);
    expect(needs('calendar_delete_recurring_series', { title: 'Standup', notifyParticipants: true })).toBe(
      true,
    );
    expect(toolNeedsApproval('archive_thread', {})).toBe(false);
    // An answer to an invitation reaches the organizer, so it asks too.
    expect(needs('calendar_rsvp_event', { account: 'a', calendarId: 'c', eventId: 'e', status: 'yes' })).toBe(
      true,
    );
  });

  test('each gated call has a plain approval card', () => {
    const invite = approvalSummary(
      'calendar_create_event',
      {
        account: 'work@example.test',
        title: 'Review',
        startIso: '2031-01-02T10:00',
        attendees: [1, 2, 3, 4, 5].map((n) => ({ email: `p${n}@example.test` })),
      },
      'UTC',
    );
    expect(invite.title).toBe('Send invitations for “Review”');
    expect(invite.metadata).toContainEqual({
      label: 'Invitees',
      value: 'p1@example.test, p2@example.test, p3@example.test, p4@example.test, and 1 more',
    });
    expect(invite.metadata).toContainEqual({ label: 'Starts', value: '2031-01-02 10:00' });
    const update = approvalSummary(
      'calendar_update_event',
      {
        matchTitle: 'Review',
        title: 'Budget review',
        notifyParticipants: true,
        startIso: '2031-01-02T15:00:00Z',
      },
      'America/New_York',
    );
    expect(update.title).toBe('Update “Review”');
    expect(update.confirmLabel).toBe('Update and notify');
    expect(update.metadata).toContainEqual({ label: 'New title', value: 'Budget review' });
    expect(update.metadata).toContainEqual({ label: 'Starts', value: 'Jan 2, 2031, 10:00 AM' });
    const cancel = approvalSummary('calendar_delete_event', { matchTitle: 'Standup', deleteSeries: true });
    expect(cancel).toMatchObject({ intent: 'destructive', denyLabel: 'Keep it' });
    expect(cancel.description).toContain('every event in the series');
    expect(approvalSummary('unknown_tool', {}).title).toBe('Approve this action');
    for (const summary of [invite, update, cancel])
      expect(`${summary.title} ${summary.description}`).not.toMatch(/\bAI\b/);
  });

  test('history keeps answered approvals and drops unanswered ones', () => {
    const unanswered: ModelMessage[] = [
      { role: 'user', content: 'Send it.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Waiting for approval.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'schedule_send', input: SEND },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
        ],
      },
      { role: 'user', content: 'Never mind.' },
    ];
    const cleaned = sanitizeToolPairs(unanswered) as any[];
    expect(cleaned[1].content).toEqual([{ type: 'text', text: 'Waiting for approval.' }]);
    const answered = sanitizeToolPairs([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'schedule_send', input: SEND },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
          { type: 'tool-approval-response', approvalId: 'stray', approved: true },
        ],
      },
    ] as ModelMessage[]) as any[];
    expect(answered[0].content).toHaveLength(2);
    expect(answered[1].content).toEqual([
      { type: 'tool-approval-response', approvalId: 'a1', approved: true },
    ]);
  });

  test('the web chat continues once per answered approval', () => {
    const answered = [
      { role: 'user', parts: [] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool-schedule_send', state: 'approval-responded', approval: { id: 'a1', approved: true } },
        ],
      },
    ];
    expect(respondedApprovalIds(answered)).toEqual(['a1']);
    let complete = true;
    const guard = createApprovalAutoContinueGuard(() => complete);
    expect(guard(answered)).toBe(true);
    expect(guard(answered)).toBe(false);
    const other = createApprovalAutoContinueGuard(() => complete);
    complete = false;
    expect(other(answered)).toBe(false);
    expect(respondedApprovalIds([{ role: 'user', parts: [] }])).toEqual([]);
  });

  test('forwardAgentStream skips the approval card when it never saw the call', async () => {
    const written: any[] = [];
    async function* chunks() {
      yield { type: 'tool-approval-request', approvalId: 'a', toolCallId: 'unknown' };
    }
    await forwardAgentStream({ write: (chunk: any) => written.push(chunk) } as any, chunks());
    expect(written.map((chunk) => chunk.type)).toEqual(['tool-approval-request']);
  });
});

describe('native chats get a native tool set and prompt', () => {
  test('ios and macos omit web-only UI tools and point drafting at show_message_draft', () => {
    const web = Object.keys(liftToolsForAgent('b', 'UTC'));
    expect(web).toContain('ui_open_reply');
    for (const platform of ['ios', 'macos'] as const) {
      const native = Object.keys(liftToolsForAgent('b', 'UTC', undefined, { clientPlatform: platform }));
      expect(native.some(isWebOnlyTool)).toBe(false);
      expect(native).toContain('show_message_draft');
      const prompt = buildSystemPrompt({ email: 'u@example.test' }, { clientPlatform: platform });
      expect(prompt).not.toMatch(/\bui_[a-z_]+/);
      expect(prompt).not.toContain('ui_extras');
      expect(prompt).toContain('then call show_message_draft with the reply');
      expect(prompt).toContain('Never say that a reply or compose window is open.');
    }
    const webPrompt = buildSystemPrompt();
    expect(webPrompt).toContain('ui_open_reply');
    expect(webPrompt).toContain('ui_extras');
  });

  test('the agent route reads clientPlatform and defaults to web', async () => {
    expect(normalizeClientPlatform('ios')).toBe('ios');
    expect(normalizeClientPlatform('macos')).toBe('macos');
    expect(normalizeClientPlatform('android')).toBe('web');
    expect(normalizeClientPlatform(undefined)).toBe('web');
    expect(typeof POST).toBe('function');
  });

  test('a native run sends the model no ui tools and the native prompt', async () => {
    const mock = model([...text('Done.'), finish()]);
    await run([mock], [{ role: 'user', content: 'Reply to Sam.' }], { clientPlatform: 'ios' });
    const call = mock.doStreamCalls[0];
    const names = (call.tools ?? []).map((entry: any) => entry.name);
    expect(names).toContain('show_message_draft');
    expect(names.some((name: string) => name.startsWith('ui_'))).toBe(false);
    const system = JSON.stringify(call.prompt[0]);
    expect(system).toContain('This chat runs in the native app.');
  });
});

describe('user-facing failure text', () => {
  test('a rejected key names the settings section and never says AI', async () => {
    const failing = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      },
    });
    const { events } = await run([failing], [{ role: 'user', content: 'Hi' }]);
    const message = events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('');
    expect(message).toContain('Open Settings, then Intelligence');
    expect(message).not.toMatch(/\bAI\b/);
  });

  test('a provider failure after retries never says AI', async () => {
    const failing = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error('Invalid JSON response'), { statusCode: 502, responseBody: 'x' });
      },
    });
    const { events } = await run([failing], [{ role: 'user', content: 'Hi' }]);
    const message = events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('');
    expect(message).toContain('model provider');
    expect(message).not.toMatch(/\bAI\b/);
  });
});
