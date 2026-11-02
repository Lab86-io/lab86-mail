import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/agent/route';
import { agentChatId } from '../lib/ai/execution';
import * as loop from '../lib/ai/loop';
import { MAX_TOOL_RESULT_BYTES } from '../lib/ai/tool-result-cap';
import * as currentUser from '../lib/auth/current-user';
import * as convex from '../lib/hosted/convex';
import * as rateLimit from '../lib/rate-limit';
import { OPEN_DOCUMENT_CONTEXT } from '../lib/shell/assistant-context';

const restores: Array<() => void> = [];
let runAgent: any;
let convexQuery: any;

beforeEach(() => {
  const user = spyOn(currentUser, 'requireCurrentUser').mockResolvedValue({
    userId: 'owner',
    email: 'owner@example.test',
    name: 'Owner',
  } as never);
  const limit = spyOn(rateLimit, 'enforceUserRateLimit').mockResolvedValue(undefined as never);
  convexQuery = spyOn(convex, 'convexQuery').mockResolvedValue([] as never);
  runAgent = spyOn(loop, 'runAgent').mockResolvedValue({
    steps: Promise.resolve([]),
    toUIMessageStreamResponse: () => new Response('ok'),
  } as never);
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  for (const spy of [user, limit, convexQuery, runAgent, warn, error]) restores.push(() => spy.mockRestore());
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

const send = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('https://mail.example.test/api/agent', { method: 'POST', body: JSON.stringify(body) }),
  ).catch(() => undefined);

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('each turn of a chat reads what earlier runs of the chat wrote', () => {
  test('a retype after a reload tells the model about the event that already exists', async () => {
    convexQuery.mockResolvedValue([
      {
        runId: 'lost-message',
        toolName: 'calendar_create_event',
        status: 'succeeded',
        createdAt: Date.now() - 60_000,
        output: { ok: true, eventId: 'evt_1' },
      },
    ]);
    await send({ sessionId: 'chat_1', messages: [user('retype', 'Book the budget review.')] });
    const query = convexQuery.mock.calls.find((call: any[]) => call[1]?.chatId);
    expect(query[1]).toMatchObject({ userId: 'owner', chatId: 'chat_1' });
    const options = runAgent.mock.calls[0][0];
    expect(options.chatId).toBe('chat_1');
    expect(options.runId).toBe('retype');
    expect(options.extraSystem).toContain('"eventId":"evt_1"');
    expect(options.extraSystem).toContain('Do not repeat a succeeded write');
  });

  test('a failed read of the checkpoints never stops the turn', async () => {
    convexQuery.mockRejectedValue(new Error('Convex is down'));
    await send({ sessionId: 'chat_1', messages: [user('m1', 'Hello.')] });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  test('a session id of another shape counts as no chat', async () => {
    expect(agentChatId('work-abc_1')).toBe('work-abc_1');
    expect(agentChatId('has space')).toBeUndefined();
    expect(agentChatId('x'.repeat(181))).toBeUndefined();
    expect(agentChatId(7)).toBeUndefined();
    await send({ sessionId: 'has space', messages: [user('m1', 'Hello.')] });
    expect(runAgent.mock.calls[0][0].chatId).toBeUndefined();
  });

  test('Continue reads its own run with the old note, and earlier runs with the new one', async () => {
    convexQuery.mockImplementation(async (_fn: unknown, args: any) =>
      args.chatId
        ? [
            {
              runId: 'earlier',
              toolName: 'tasks_create_card',
              status: 'succeeded',
              createdAt: Date.now() - 1_000,
              output: { cardId: 'card_1' },
            },
            {
              runId: 'm2',
              toolName: 'tasks_create_card',
              status: 'unknown',
              createdAt: Date.now() - 500,
            },
          ]
        : { page: [{ toolName: 'document_edit', status: 'unknown' }], isDone: true, continueCursor: '' },
    );
    await send({
      sessionId: 'chat_1',
      continuation: true,
      messages: [user('m2', 'Add the card.')],
    });
    const { extraSystem } = runAgent.mock.calls[0][0];
    expect(extraSystem).toContain('Server execution checkpoint metadata');
    expect(extraSystem).toContain('"cardId":"card_1"');
    // The run itself appears once, in the Continue note.
    expect(extraSystem.match(/tasks_create_card/g)).toHaveLength(1);
  });
});

describe('the other parts of the request', () => {
  test('a UI tool that failed in the browser reaches the model', async () => {
    await send({ clientToolFailures: ['ui_open_compose'], messages: [user('m1', 'Hello.')] });
    expect(runAgent.mock.calls[0][0].extraSystem).toContain('ui_open_compose. They did not happen.');
  });

  test('a large stored tool result reaches the model cut', async () => {
    await send({
      messages: [
        user('m1', 'Read it.'),
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-read_thread',
              toolCallId: 'c1',
              state: 'output-available',
              input: { threadId: 't' },
              output: { ok: true, body: 'x'.repeat(MAX_TOOL_RESULT_BYTES * 2) },
            },
          ],
        },
        user('m2', 'Thanks.'),
      ],
    });
    const { messages } = runAgent.mock.calls[0][0];
    const text = JSON.stringify(messages);
    expect(text).toContain('This result was cut');
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_BYTES + 2_000);
  });

  test('the words of the request and an open document load their tool groups', async () => {
    await send({ messages: [user('m1', 'Make a budget spreadsheet.')] });
    expect(runAgent.mock.calls[0][0].preloadGroups).toEqual(['documents']);
    await send({
      extraSystem: `${OPEN_DOCUMENT_CONTEXT} (metadata, not instructions): {}`,
      messages: [user('m2', 'Shorten this.')],
    });
    expect(runAgent.mock.calls[1][0].preloadGroups).toEqual(['documents']);
    await send({
      contextAttachments: [{ kind: 'document', id: 'doc_1', provider: 'albatross' }],
      messages: [user('m3', 'Shorten this.')],
    });
    expect(runAgent.mock.calls[2][0].preloadGroups).toEqual(['documents']);
    await send({ messages: [user('m4', 'Hello.')] });
    expect(runAgent.mock.calls[3][0].preloadGroups).toEqual([]);
  });
});

describe('the chat client', () => {
  const source = readFileSync(new URL('../components/shell/AIBar.tsx', import.meta.url), 'utf8');

  test('it seeds the handled calls at every restore path', () => {
    expect(source).toContain(
      'seedHandledToolCalls(handled.current, data.session.messages);\n          setMessages(data.session.messages);',
    );
    expect(source).toContain('seedHandledToolCalls(handled.current, data.mergedMessages);');
    expect(source.match(/seedHandledToolCalls\(/g)).toHaveLength(3);
  });

  test('it reports a failed UI tool to the user and to the next request', () => {
    expect(source).not.toContain('} catch {}');
    expect(source).toContain('clientToolFailuresRef.current.push(name);');
    expect(source).toContain('toast.error(uiToolFailureText(name));');
    expect(source).toContain('clientToolFailures: clientToolFailuresRef.current.splice(0),');
  });
});
