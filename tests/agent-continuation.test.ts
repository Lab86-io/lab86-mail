import { expect, test } from 'bun:test';
import { Chat } from '@ai-sdk/react';
import { convertToModelMessages } from 'ai';
import { forwardAgentStream } from '../lib/ai/loop';
import { compactMessage } from '../lib/store/chat-sessions';

test('Continue retains the successful read and interrupted turn with the same user request identity', async () => {
  const requests: any[] = [];
  const chat = new Chat({
    transport: {
      sendMessages: async (request) => {
        requests.push(structuredClone({ messages: request.messages, body: request.body }));
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: `assistant-${requests.length}` });
            if (requests.length === 1) {
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: 'read',
                toolName: 'document_get',
                input: { documentId: 'deck' },
              });
              controller.enqueue({
                type: 'tool-output-available',
                toolCallId: 'read',
                output: { document: { documentId: 'deck', currentRevision: 4 } },
              });
              controller.enqueue({ type: 'error', errorText: 'network error' });
            } else controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        });
      },
      reconnectToStream: async () => null,
    },
  });
  await chat.sendMessage({ text: 'Restyle the slides' });
  expect(chat.status).toBe('error');
  await chat.sendMessage(undefined, { body: { continuation: true } });
  expect(requests[1].body).toEqual({ continuation: true });
  expect(requests[1].messages[0].id).toBe(requests[0].messages[0].id);
  expect(requests[1].messages[1].parts).toContainEqual(
    expect.objectContaining({
      toolCallId: 'read',
      state: 'output-available',
      output: { document: { documentId: 'deck', currentRevision: 4 } },
    }),
  );
});

test('restored uncertainty survives model conversion without inventing a successful output', async () => {
  const message = compactMessage({
    id: 'assistant',
    role: 'assistant',
    parts: [
      {
        type: 'tool-document_edit',
        toolCallId: 'edit',
        state: 'input-available',
        input: { documentId: 'deck' },
      },
    ],
  });
  const model: any[] = await convertToModelMessages([message]);
  const result = model
    .flatMap((row) => (Array.isArray(row.content) ? row.content : []))
    .find((part) => part.type === 'tool-result');
  expect(result.output.type).toBe('error-text');
  expect(result.output.value).toContain('outcome not confirmed');
});

test('recoverable tool errors do not become fatal stream errors; a later stream failure remains identifiable', async () => {
  const events: any[] = [];
  async function* chunks(fatal = false) {
    yield { type: 'tool-input-available', toolCallId: 'edit', toolName: 'document_edit', input: {} };
    yield { type: 'tool-output-error', toolCallId: 'edit', errorText: 'height must be at least 1' };
    if (fatal) yield { type: 'error', errorText: 'provider disconnected' };
  }
  const writer: any = { write: (chunk: unknown) => events.push(chunk) };
  expect((await forwardAgentStream(writer, chunks())).error).toBeUndefined();
  const interrupted = await forwardAgentStream(writer, chunks(true));
  expect((interrupted.error as Error).message).toBe('provider disconnected');
});
