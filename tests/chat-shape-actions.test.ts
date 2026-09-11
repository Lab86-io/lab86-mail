import { describe, expect, test } from 'bun:test';
import type { ShapeAction } from '../lib/ai/tool-shapes';
import {
  executeShapeAction,
  planActionEntries,
  type ShapeActionDeps,
  splitActionEntries,
} from '../lib/chat/shape-actions';
import { TOOLS } from '../lib/tools';

function harness() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const navigation: Array<[string, unknown]> = [];
  const invalidated: string[] = [];
  const deps: ShapeActionDeps = {
    store: new Proxy(
      {},
      { get: (_target, key) => (value: unknown) => navigation.push([String(key), value]) },
    ) as ShapeActionDeps['store'],
    openDocument: (id) => {
      navigation.push(['document', id]);
    },
    openUrl: (url) => {
      navigation.push(['url', url]);
    },
    invalidate: (keys) => {
      invalidated.push(...keys);
    },
    defaultAccount: 'account-1',
    now: () => new Date(2026, 8, 11, 14).getTime(),
    callTool: async (name, args) => {
      expect(TOOLS[name].input.safeParse(args).success).toBe(true);
      calls.push({ name, args });
      if (name === 'get_thread')
        return {
          messages: [
            { _id: 'newest', date: 20 },
            { _id: 'older', date: 10 },
          ],
        };
      return { ok: true, operationId: 'operation-1' };
    },
  };
  return { deps, calls, navigation, invalidated };
}

describe('actionable chat results', () => {
  const mutations: ShapeAction[] = [
    { kind: 'archive_thread', account: 'account-1', threadId: 'thread-1' },
    { kind: 'snooze_thread', account: 'account-1', threadId: 'thread-1' },
    { kind: 'rsvp_event', account: 'account-1', calendarId: 'calendar-1', eventId: 'event-1' },
    { kind: 'delete_event', account: 'account-1', calendarId: 'calendar-1', eventId: 'event-1' },
    { kind: 'hold_slot', startIso: '2026-09-12T13:00:00Z', endIso: '2026-09-12T14:00:00Z' },
    { kind: 'complete_task', cardId: 'card-1' },
    {
      kind: 'import_file',
      connectionId: 'connection-1',
      fileId: 'file-1',
      mimeType: 'application/vnd.google-apps.document',
    },
    { kind: 'undo_operation', operationId: 'operation-1' },
    { kind: 'remember_sender', email: 'sender@example.test' },
  ];
  for (const action of mutations) {
    test(`${action.kind} uses a valid tool payload and preserves the chat`, async () => {
      const h = harness();
      const result = await executeShapeAction(action, h.deps, {
        note: 'Prefers morning meetings',
        rsvp: 'maybe',
      });
      expect(result.kind).toBe('done');
      expect(h.calls.length).toBeGreaterThan(0);
      expect(h.navigation).toEqual([]);
      if (action.kind === 'snooze_thread') expect(h.calls.at(-1)?.args.messageId).toBe('newest');
      if (action.kind === 'rsvp_event') expect(h.calls[0].args.status).toBe('maybe');
    });
  }
  const navigationActions: ShapeAction[] = [
    { kind: 'open_thread', account: 'account-1', threadId: 'thread-1' },
    { kind: 'reply_thread', account: 'account-1', threadId: 'thread-1' },
    { kind: 'open_task', boardId: 'board-1', cardId: 'card-1' },
    { kind: 'open_board', boardId: 'board-1' },
    { kind: 'open_work', workId: 'work-1' },
    { kind: 'open_area', areaId: 'area-1' },
    { kind: 'open_document', documentId: 'doc-1' },
    { kind: 'open_url', url: 'https://example.test/document' },
    { kind: 'open_event', account: 'account-1', calendarId: 'calendar-1', eventId: 'event-1' },
  ];
  for (const action of navigationActions) {
    test(`${action.kind} follows the client route without a mutation`, async () => {
      const h = harness();
      expect((await executeShapeAction(action, h.deps)).kind).toBe('navigated');
      expect(h.calls).toEqual([]);
      expect(h.navigation.length).toBeGreaterThan(0);
      if (action.kind === 'open_task')
        expect(h.navigation).toContainEqual(['setPendingOpenCardId', 'card-1']);
    });
  }
  test('does not show success after failure or invent a calendar, file type, or sender note', async () => {
    const h = harness();
    h.deps.callTool = async () => {
      throw new Error('Connection expired');
    };
    expect(await executeShapeAction(mutations[0], h.deps)).toEqual({
      kind: 'error',
      message: 'Connection expired',
    });
    expect(h.invalidated).toEqual([]);
    for (const action of [
      { kind: 'delete_event', account: 'a', eventId: 'e' },
      { kind: 'rsvp_event', account: 'a', eventId: 'e' },
      { kind: 'import_file', connectionId: 'c', fileId: 'f' },
      { kind: 'remember_sender', email: 'e' },
      { kind: 'open_url', url: 'javascript:alert(1)' },
    ] as ShapeAction[])
      expect((await executeShapeAction(action, h.deps)).kind).toBe('error');
    expect(h.navigation).toEqual([]);
  });
  test('keeps at most two visible actions and explicitly confirms event deletion', () => {
    const entries = planActionEntries([navigationActions[8], mutations[2], mutations[3]]);
    const split = splitActionEntries(entries);
    expect(split.visible.map((item) => item.label)).toEqual(['Open', 'Accept']);
    expect(split.more.map((item) => item.label)).toEqual(['Decline', 'Maybe', 'Delete']);
    expect(split.more.at(-1)?.confirm).toBe(true);
  });
});
