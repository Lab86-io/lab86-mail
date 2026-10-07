import { describe, expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  compactMessage,
  getChatSession,
  getWorkThreadSession,
  listScopedChatSessions,
  mergeThreadMessages,
  saveChatSession,
} from '../lib/store/chat-sessions';

// The Work thread's chat session (docs/albatross-thread.md): saves from two
// devices merge, an older Work chat moves to the canonical id, and personal
// details never stay in saved history. These tests use the in-process store
// (no Convex configured).

const at = (id: string, createdAt?: number, role = 'user') => ({
  id,
  role,
  parts: [{ type: 'text', text: id }],
  ...(createdAt === undefined ? {} : { metadata: { createdAt } }),
});
const ids = (messages: readonly any[]) => messages.map((message) => message.id);

describe('mergeThreadMessages', () => {
  test('a message another device wrote after this copy loaded stays, in time order', () => {
    const stored = [at('m1', 100), at('m2', 200), at('b1', 300), at('b2', 320)];
    const incoming = [at('m1', 100), at('m2', 200), at('a1', 310)];
    expect(ids(mergeThreadMessages(stored, incoming, 250))).toEqual(['m1', 'm2', 'b1', 'a1', 'b2']);
  });

  test('a stored message older than the loaded copy and missing from the save was removed on purpose', () => {
    const stored = [at('m1', 100), at('retry-old', 200)];
    const incoming = [at('m1', 100), at('retry-new', 260)];
    expect(ids(mergeThreadMessages(stored, incoming, 250))).toEqual(['m1', 'retry-new']);
  });

  test('the saved copy of an id wins', () => {
    const stored = [{ ...at('m1', 100), parts: [{ type: 'text', text: 'old' }] }];
    const incoming = [{ ...at('m1', 100), parts: [{ type: 'text', text: 'new' }] }];
    expect(mergeThreadMessages(stored, incoming, 0)[0].parts[0].text).toBe('new');
  });

  test('a message without a time keeps its place', () => {
    const stored = [at('legacy'), at('b1', 500)];
    const incoming = [at('legacy'), at('a1', 400)];
    expect(ids(mergeThreadMessages(stored, incoming, 300))).toEqual(['legacy', 'a1', 'b1']);
  });
});

describe('saved history privacy', () => {
  test('personal_details_get output is dropped from saved chats', () => {
    const message = compactMessage({
      id: 'a',
      role: 'assistant',
      parts: [
        {
          type: 'tool-personal_details_get',
          toolCallId: 'c',
          state: 'output-available',
          input: {},
          output: { details: [{ key: 'phone', value: '+15555550100' }] },
        },
      ],
    });
    expect(JSON.stringify(message)).not.toContain('5555550100');
    expect(message.parts[0].output).toMatchObject({ outputOmitted: true });
  });
});

describe('Work thread sessions', () => {
  const user = { userId: `thread-session-${Date.now()}`, agent: 'user' as const };

  test('saves of a work thread merge with the stored copy when the client sends baseUpdatedAt', async () => {
    await runWithAiRequestContext(user, async () => {
      const id = 'work-k1abc';
      const first = await saveChatSession(id, [at('m1', 100), at('b1', 300)], undefined, {
        kind: 'work',
        workId: 'k1abc',
      });
      const merged = await saveChatSession(id, [at('m1', 100), at('a1', 310)], undefined, undefined, {
        baseUpdatedAt: 200,
      });
      expect(ids(merged.messages)).toEqual(['m1', 'b1', 'a1']);
      expect(first.scope).toEqual({ kind: 'work', workId: 'k1abc' });
      // Without baseUpdatedAt a save replaces, as for every other chat.
      const replaced = await saveChatSession(id, [at('m1', 100)]);
      expect(ids(replaced.messages)).toEqual(['m1']);
    });
  });

  test('an older Work chat moves to the canonical id once', async () => {
    await runWithAiRequestContext({ ...user, userId: `${user.userId}-adopt` }, async () => {
      await saveChatSession('chat-older-1', [at('x1', 50)], 'Old', { kind: 'work', workId: 'k2abc' });
      // updatedAt decides which chat is newer.
      await Bun.sleep(5);
      await saveChatSession('chat-newer-2', [at('y1', 60)], 'Newer', { kind: 'work', workId: 'k2abc' });
      const thread = await getWorkThreadSession('k2abc');
      expect(thread?._id).toBe('work-k2abc');
      expect(ids(thread?.messages || [])).toEqual(['y1']);
      expect(await getChatSession('chat-newer-2')).toBeNull();
      expect(await getChatSession('chat-older-1')).not.toBeNull();
      const again = await getWorkThreadSession('k2abc');
      expect(ids(again?.messages || [])).toEqual(['y1']);
      expect(
        (await listScopedChatSessions({ kind: 'work', workId: 'k2abc' })).map((row) => row._id).sort(),
      ).toEqual(['chat-older-1', 'work-k2abc']);
    });
  });

  test('a Work with no chat has no thread session yet', async () => {
    await runWithAiRequestContext({ ...user, userId: `${user.userId}-none` }, async () => {
      expect(await getWorkThreadSession('k3abc')).toBeNull();
    });
  });
});

describe('merged messages reach the client', () => {
  test('a save returns the messages it kept from another device, and the client adds them in place', async () => {
    const { addMergedThreadMessages } = await import('../lib/albatross/thread-contract');
    await runWithAiRequestContext({ userId: `merge-return-${Date.now()}`, agent: 'user' }, async () => {
      const id = 'work-k9abc';
      await saveChatSession(id, [at('m1', 100), at('phone1', 300)], undefined, {
        kind: 'work',
        workId: 'k9abc',
      });
      // The desktop loaded at 200 and never saw phone1.
      const saved = await saveChatSession(id, [at('m1', 100), at('d1', 310)], undefined, undefined, {
        baseUpdatedAt: 200,
      });
      expect(ids(saved.mergedMessages || [])).toEqual(['phone1']);
      const desktop = addMergedThreadMessages([at('m1', 100), at('d1', 310)], saved.mergedMessages as any[]);
      expect(ids(desktop)).toEqual(['m1', 'phone1', 'd1']);
      // The next desktop save holds phone1, so nothing is lost.
      const next = await saveChatSession(id, [...desktop, at('d2', 400)], undefined, undefined, {
        baseUpdatedAt: saved.updatedAt,
      });
      expect(ids(next.messages)).toEqual(['m1', 'phone1', 'd1', 'd2']);
      expect(next.mergedMessages).toBeUndefined();
    });
  });

  test('addMergedThreadMessages ignores known ids', async () => {
    const { addMergedThreadMessages } = await import('../lib/albatross/thread-contract');
    expect(ids(addMergedThreadMessages([at('a', 1)], [at('a', 1)]))).toEqual(['a']);
  });
});
