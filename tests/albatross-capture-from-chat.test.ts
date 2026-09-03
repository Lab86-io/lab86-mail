import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  captureFromChat,
  chatCaptureExternalId,
  chatCaptureRawText,
} from '../lib/albatross/capture-from-chat';

const user = {
  userId: 'user_chat',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

interface Options {
  held?: any[];
  summaries?: any[];
  workIds?: string[];
  summariesFail?: boolean;
}

function makeDependencies(options: Options = {}) {
  const captures: any[] = [];
  const mutations: Array<{ name: string; args: any }> = [];
  const queries: Array<{ name: string; args: any }> = [];
  const deps = {
    captureWork: async (input: any) => {
      captures.push(input);
      return {
        captureId: 'capture-9',
        status: 'split' as const,
        workIds: options.workIds ?? ['work-1', 'work-2'],
      };
    },
    query: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      queries.push({ name, args });
      if ('externalId' in args) return options.held ?? [];
      if (options.summariesFail) throw new Error('convex down');
      return (
        options.summaries ??
        (args.workIds as string[]).map((id) => ({
          id,
          title: `Title ${id}`,
          shape: 'quick',
          horizon: null,
          captureId: 'capture-9',
        }))
      );
    },
    mutate: async (fn: any, args: any) => {
      mutations.push({ name: getFunctionName(fn), args });
      return null;
    },
  };
  return { deps: deps as any, captures, mutations, queries };
}

describe('chatCaptureExternalId', () => {
  test('needs both a conversation and a message', () => {
    expect(chatCaptureExternalId('conv-1', 'msg-1')).toBe('chat:conv-1:msg-1');
    expect(chatCaptureExternalId('conv-1', undefined)).toBeNull();
    expect(chatCaptureExternalId(undefined, 'msg-1')).toBeNull();
    expect(chatCaptureExternalId(' ', 'msg-1')).toBeNull();
  });
});

describe('chatCaptureRawText', () => {
  test('joins the user text and the reply with one blank line', () => {
    expect(chatCaptureRawText(' plan the move ', ' 1. Book movers\n2. Pack ')).toBe(
      'plan the move\n\n1. Book movers\n2. Pack',
    );
    expect(chatCaptureRawText('plan the move')).toBe('plan the move');
    expect(chatCaptureRawText('plan the move', '   ')).toBe('plan the move');
  });
});

describe('captureFromChat', () => {
  test('captures the user text plus the reply as one chat capture and stamps the reply id', async () => {
    const { deps, captures, mutations, queries } = makeDependencies();
    const result = await captureFromChat(
      {
        text: 'plan the move',
        replyText: '1. Book movers\n2. Pack',
        conversationId: 'conv-1',
        sourceMessageId: 'msg-1',
      },
      user,
      deps,
    );
    expect(captures).toEqual([{ rawText: 'plan the move\n\n1. Book movers\n2. Pack', source: 'chat' }]);
    expect(queries[0].args).toEqual({ userId: 'user_chat', externalId: 'chat:conv-1:msg-1' });
    expect(mutations).toEqual([
      {
        name: 'albatrossChatCapture:stampExternalId',
        args: { userId: 'user_chat', workIds: ['work-1', 'work-2'], externalId: 'chat:conv-1:msg-1' },
      },
    ]);
    expect(result).toEqual({
      captureId: 'capture-9',
      workIds: ['work-1', 'work-2'],
      work: [
        { id: 'work-1', title: 'Title work-1', shape: 'quick', horizon: null },
        { id: 'work-2', title: 'Title work-2', shape: 'quick', horizon: null },
      ],
      existing: false,
      fallback: undefined,
    });
  });

  test('a second Hold on the same reply returns the existing Work and writes nothing', async () => {
    const held = [
      {
        id: 'work-7',
        title: 'Plan the move',
        shape: 'project',
        horizon: { kind: 'now' },
        captureId: 'capture-3',
      },
    ];
    const { deps, captures, mutations } = makeDependencies({ held });
    const result = await captureFromChat(
      { text: 'plan the move', replyText: 'steps', conversationId: 'conv-1', sourceMessageId: 'msg-1' },
      user,
      deps,
    );
    expect(captures).toHaveLength(0);
    expect(mutations).toHaveLength(0);
    expect(result).toEqual({
      captureId: 'capture-3',
      workIds: ['work-7'],
      work: [{ id: 'work-7', title: 'Plan the move', shape: 'project', horizon: { kind: 'now' } }],
      existing: true,
    });
  });

  test('without a message id there is no idempotency lookup and no stamp', async () => {
    const { deps, mutations, queries } = makeDependencies();
    await captureFromChat({ text: 'book the dentist', conversationId: 'conv-1' }, user, deps);
    expect(queries.map((query) => 'externalId' in query.args)).toEqual([false]);
    expect(mutations).toHaveLength(0);
  });

  test('an explicit shape and horizon are applied to each Work after the split', async () => {
    const { deps, captures, mutations } = makeDependencies({ workIds: ['work-1'] });
    const horizon = { kind: 'later' as const, notBefore: 1_800_000_000_000, label: 'after the wedding' };
    await captureFromChat({ text: 'renew the passport', shape: 'project', horizon }, user, deps);
    expect(captures[0]).toEqual({ rawText: 'renew the passport', source: 'chat' });
    expect(mutations).toEqual([
      { name: 'albatrossWorkV2:setShape', args: { userId: 'user_chat', workId: 'work-1', shape: 'project' } },
      { name: 'albatrossWorkV2:setHorizon', args: { userId: 'user_chat', workId: 'work-1', horizon } },
    ]);
  });

  test('falls back to plain summaries when the summary query fails', async () => {
    const { deps } = makeDependencies({ summariesFail: true, workIds: ['work-1'] });
    const result = await captureFromChat({ text: 'renew the passport', shape: 'project' }, user, deps);
    expect(result.work).toEqual([{ id: 'work-1', title: 'Work', shape: 'project', horizon: null }]);
  });

  test('rejects empty text', async () => {
    const { deps } = makeDependencies();
    await expect(captureFromChat({ text: '   ' }, user, deps)).rejects.toThrow('text required');
  });
});
