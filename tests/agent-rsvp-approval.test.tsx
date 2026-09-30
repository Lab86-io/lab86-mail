import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertToModelMessages, type ModelMessage, readUIMessageStream, type UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageView } from '../components/shell/AIBar';
import { isToolApprovalPart } from '../lib/ai/approval';
import * as gateway from '../lib/ai/gateway';
import { runAgent } from '../lib/ai/loop';
import { sanitizeToolPairs } from '../lib/ai/message-sanitize';
import { groupMessageParts } from '../lib/chat/work-log';
import * as narrative from '../lib/narrative/service';
import * as memories from '../lib/store/memories';
import { TOOLS } from '../lib/tools';

// Repro of the 2026-09-30 demo bug: "Accept the Board prep sync invitation"
// showed "Calendar rsvp event failed — This step ended before a result was
// received", and no audit line for calendar_rsvp_event. The server stopped the
// call at the approval gate, but the web chat put the waiting call in a work
// log row. The row could not show the approval card, so the user could never
// answer, and the settled log marked the call as failed.

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

const RSVP = { account: 'acct_google', calendarId: 'primary', eventId: 'evt_board_prep', status: 'yes' };
const USER_TEXT = 'Accept the "Board prep sync" invitation on Friday.';

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

function model(parts: LanguageModelV3StreamPart[]) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}

function stubRuntime(entry: MockLanguageModelV3) {
  const spies = [
    spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue([
      { userId: 'owner', source: 'lab86', provider: 'openai', modelName: 'model-0', model: entry },
    ] as any),
    spyOn(gateway, 'recordAgentUsage').mockResolvedValue(undefined),
    spyOn(gateway, 'hasPlatformAi').mockReturnValue(true),
    spyOn(narrative, 'narrativePrompt').mockResolvedValue(''),
    spyOn(memories, 'listMemories').mockResolvedValue([]),
  ];
  for (const spy of spies) restores.push(() => spy.mockRestore());
}

/**
 * Run one agent turn and read its response stream the way the web chat does.
 * A continuation after an approval answer grows the same assistant message.
 */
async function chatTurn(
  entry: MockLanguageModelV3,
  messages: ModelMessage[],
  continued?: UIMessage,
): Promise<UIMessage> {
  stubRuntime(entry);
  // No signed-in run, so a mutating call skips the Convex execution checkpoint.
  const agent = await runAgent({ runId: 'rsvp-run', userId: null, messages, userTimezone: 'UTC' });
  const chunks = (await agent.toUIMessageStreamResponse().text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, message: continued })) last = message;
  if (!last) throw new Error('The agent sent no message.');
  return last;
}

function rsvpPart(message: UIMessage): any {
  const part = message.parts.find((entry: any) => entry.type === 'tool-calendar_rsvp_event');
  if (!part) throw new Error('No calendar_rsvp_event part.');
  return part;
}

describe('assistant RSVP through the approval gate', () => {
  test('the RSVP call shows an approval card, and the approved answer runs the tool once', async () => {
    const handler = spyOn(TOOLS.calendar_rsvp_event, 'handler').mockResolvedValue({
      ok: true,
      operationId: 'op_rsvp',
    } as any);
    restores.push(() => handler.mockRestore());
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    restores.push(() => log.mockRestore());

    // Turn one: the model asks to RSVP. The SDK stops at the approval gate.
    const first = await chatTurn(
      model([
        {
          type: 'tool-call',
          toolCallId: 'rsvp-1',
          toolName: 'calendar_rsvp_event',
          input: JSON.stringify(RSVP),
        },
        finish('tool-calls'),
      ]),
      [{ role: 'user', content: USER_TEXT }],
    );
    const waiting = rsvpPart(first);
    expect(waiting.state).toBe('approval-requested');
    expect(isToolApprovalPart(waiting)).toBe(true);
    expect(handler).not.toHaveBeenCalled();

    // The waiting call stays out of the work log, so the chat can draw its card.
    const segments = groupMessageParts(first.parts);
    expect(segments.some((segment) => segment.kind === 'work-log')).toBe(false);
    expect(segments).toContainEqual(expect.objectContaining({ kind: 'part', part: waiting }));

    // The finished turn shows the approval card, not a failed step.
    const markup = renderToStaticMarkup(<MessageView message={first} />);
    expect(markup).toContain('data-tool-approval="calendar_rsvp_event"');
    expect(markup).not.toContain('This step ended before a result was received.');
    expect(markup).not.toContain('data-work-state="failed"');

    // The user approves. The chat sends the answer back, and the server runs the call.
    const answered: UIMessage = {
      ...first,
      parts: first.parts.map((part: any) =>
        part === waiting
          ? { ...part, state: 'approval-responded', approval: { ...part.approval, approved: true } }
          : part,
      ) as UIMessage['parts'],
    };
    const user: UIMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: USER_TEXT }] };
    const history = sanitizeToolPairs(await convertToModelMessages([user, answered]));
    const second = await chatTurn(
      model([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'You accepted Board prep sync.' },
        { type: 'text-end', id: 't' },
        finish(),
      ]),
      history,
      answered,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject(RSVP);
    expect(rsvpPart(second)).toMatchObject({ state: 'output-available', output: { ok: true } });
    expect(
      logs.some((line) => line.startsWith('[audit]') && line.includes('"tool":"calendar_rsvp_event"')),
    ).toBe(true);
  });

  test('a denied answer keeps the card with the choice and never runs the tool', () => {
    const denied = {
      type: 'tool-calendar_rsvp_event',
      toolCallId: 'rsvp-2',
      state: 'output-denied',
      input: RSVP,
      approval: { id: 'approval-2', approved: false },
    };
    const segments = groupMessageParts([denied]);
    expect(segments).toEqual([{ kind: 'part', index: 0, part: denied }]);
    const markup = renderToStaticMarkup(
      <MessageView message={{ id: 'a-2', role: 'assistant', parts: [denied] }} />,
    );
    expect(markup).toContain('data-tool-approval="calendar_rsvp_event"');
    expect(markup).not.toContain('This step ended before a result was received.');
  });

  test('the approval predicate needs an approval id and a gate state', () => {
    const base = { type: 'tool-calendar_rsvp_event', toolCallId: 'x', approval: { id: 'a' } };
    for (const state of ['approval-requested', 'approval-responded', 'output-denied'])
      expect(isToolApprovalPart({ ...base, state })).toBe(true);
    for (const state of ['input-available', 'output-available', 'output-error'])
      expect(isToolApprovalPart({ ...base, state })).toBe(false);
    expect(isToolApprovalPart({ ...base, state: 'approval-requested', approval: {} })).toBe(false);
    expect(isToolApprovalPart(null)).toBe(false);
    expect(isToolApprovalPart('approval-requested')).toBe(false);
    // A finished call joins the work log again.
    const done = { ...base, state: 'output-available', output: { ok: true } };
    expect(groupMessageParts([done])[0].kind).toBe('work-log');
  });
});
