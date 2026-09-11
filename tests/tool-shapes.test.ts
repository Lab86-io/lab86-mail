import { describe, expect, test } from 'bun:test';
import { AGENT_TOOL_NAMES, forwardAgentStream } from '../lib/ai/loop';
import {
  parseSender,
  resolveToolShape,
  SHAPE_LIST_LIMIT,
  SHAPED_TOOL_NAMES,
  type ToolShape,
} from '../lib/ai/tool-shapes';

function shape(toolName: string, input: unknown, output: unknown): ToolShape {
  const resolved = resolveToolShape(toolName, input, output);
  if (!resolved) throw new Error(`expected a shape for ${toolName}`);
  return resolved;
}

const threadRow = (n: number) => ({
  _id: `t${n}`,
  account: 'acct_1',
  subject: `Subject ${n}`,
  fromAddress: `Person ${n} <p${n}@example.test>`,
  senderEmail: `p${n}@example.test`,
  lastDate: 1_789_000_000_000 + n,
  snippet: `Snippet ${n}`,
  labels: [],
  unread: n % 2 === 0,
  starred: false,
  cachedAt: 1,
});

describe('resolveToolShape', () => {
  test('every mapped tool is a real agent tool', () => {
    for (const name of SHAPED_TOOL_NAMES) {
      expect(
        AGENT_TOOL_NAMES.has(name) ||
          name === 'recent_threads' ||
          name === 'list_account_threads' ||
          name === 'tasks_due_cards' ||
          name === 'tasks_for_thread',
      ).toBe(true);
    }
  });

  test('display, ask, and ui tools never get a shape', () => {
    expect(resolveToolShape('show_plan', {}, { ok: true, steps: [] })).toBeNull();
    expect(resolveToolShape('ask_user', {}, { answers: [] })).toBeNull();
    expect(resolveToolShape('ui_set_query', {}, { ok: true })).toBeNull();
  });

  test('failures stay on the activity row', () => {
    expect(resolveToolShape('search_threads', { query: 'x' }, { ok: false, error: 'boom' })).toBeNull();
  });

  test('search_threads → threads with open, archive, snooze and a list cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => threadRow(i));
    const result = shape('search_threads', { account: 'acct_1', query: 'invoice' }, { items: rows });
    expect(result.kind).toBe('threads');
    if (result.kind !== 'threads') return;
    expect(result.items).toHaveLength(SHAPE_LIST_LIMIT);
    expect(result.total).toBe(12);
    expect(result.title).toContain('invoice');
    expect(result.items[0]).toMatchObject({
      account: 'acct_1',
      threadId: 't0',
      subject: 'Subject 0',
      from: 'Person 0',
      fromEmail: 'p0@example.test',
      unread: true,
    });
    expect(result.items[0].dateIso).toMatch(/^\d{4}-/);
    expect(result.items[0].actions.map((action) => action.kind)).toEqual([
      'open_thread',
      'archive_thread',
      'snooze_thread',
    ]);
    expect(result.activity.done).toBeTruthy();
  });

  test('corpus_search falls back to connected sources when no mail matched', () => {
    const result = shape(
      'corpus_search',
      { query: 'release' },
      {
        items: [
          {
            source: 'mcp',
            server: 'github',
            title: 'Release 1.2',
            url: 'https://x.test/1',
            summary: 'Ship it',
          },
        ],
        accountsSearched: [],
      },
    );
    expect(result.kind).toBe('sources');
    if (result.kind !== 'sources') return;
    expect(result.items[0]).toMatchObject({
      title: 'Release 1.2',
      source: 'github',
      url: 'https://x.test/1',
    });
    expect(result.items[0].actions[0]).toEqual({ kind: 'open_url', url: 'https://x.test/1' });
  });

  test('read_thread → one thread card with excerpt, reply, and counts', () => {
    const result = shape(
      'read_thread',
      { account: 'acct_1', threadId: 't9' },
      {
        account: 'acct_1',
        threadId: 't9',
        subject: 'Contract',
        messageCount: 2,
        messages: [
          { from: 'A <a@x.test>', date: 1_789_000_000_000, body: 'first', attachments: [{ id: '1' }] },
          {
            from: 'B <b@x.test>',
            date: 1_789_000_100_000,
            body: 'Please review by Friday.',
            attachments: [],
          },
        ],
      },
    );
    expect(result.kind).toBe('thread');
    if (result.kind !== 'thread') return;
    expect(result.item.from).toBe('B');
    expect(result.item.messageCount).toBe(2);
    expect(result.item.attachmentCount).toBe(1);
    expect(result.excerpt).toBe('Please review by Friday.');
    expect(result.item.actions.map((action) => action.kind)).toContain('reply_thread');
  });

  test('sender_profile → contact with a remember action', () => {
    const result = shape(
      'sender_profile',
      { email: 'ada@x.test' },
      {
        email: 'ada@x.test',
        name: 'Ada',
        totalMessages: 14,
        lastSeen: 1_789_000_000_000,
        memory: { notes: 'Likes brevity' },
      },
    );
    expect(result).toMatchObject({
      kind: 'contact',
      email: 'ada@x.test',
      name: 'Ada',
      totalMessages: 14,
      memory: 'Likes brevity',
    });
    expect(result.actions).toEqual([{ kind: 'remember_sender', email: 'ada@x.test' }]);
  });

  test('corpus_count → count', () => {
    const result = shape(
      'corpus_count',
      { query: 'from:ada' },
      { total: 42, approximate: false, accounts: [] },
    );
    expect(result).toMatchObject({ kind: 'count', value: 42 });
    if (result.kind === 'count') expect(result.label).toContain('from:ada');
  });

  test('mail mutations → receipt with an open action and no undo', () => {
    const result = shape('archive_thread', { account: 'acct_1', threadId: 't1' }, { ok: true });
    expect(result.kind).toBe('receipt');
    if (result.kind !== 'receipt') return;
    expect(result.surface).toBe('mail');
    expect(result.operationId).toBeUndefined();
    expect(result.actions).toEqual([{ kind: 'open_thread', account: 'acct_1', threadId: 't1' }]);
  });

  test('snooze carries the wake time in the target', () => {
    const result = shape(
      'snooze_thread',
      { account: 'acct_1', threadId: 't1', messageId: 'm1', untilTs: 1_789_100_000_000 },
      { ok: true, untilIso: '2026-09-12T08:00:00.000Z' },
    );
    if (result.kind !== 'receipt') throw new Error('receipt expected');
    expect(result.target?.untilIso).toBe('2026-09-12T08:00:00.000Z');
  });

  test('calendar_list_events → events with open and rsvp', () => {
    const result = shape(
      'calendar_list_events',
      { fromIso: '2026-09-11', toIso: '2026-09-12', accountIds: ['acct_1'] },
      {
        events: [
          {
            eventId: 'e1',
            accountId: 'acct_1',
            calendarId: 'c1',
            title: 'Standup',
            startIso: '2026-09-11T09:00:00.000Z',
            endIso: '2026-09-11T09:15:00.000Z',
            participants: [{ email: 'a@x.test', name: 'A' }, { email: 'b@x.test' }],
            location: 'Room 4',
          },
        ],
      },
    );
    expect(result.kind).toBe('events');
    if (result.kind !== 'events') return;
    expect(result.items[0]).toMatchObject({
      eventId: 'e1',
      title: 'Standup',
      location: 'Room 4',
      attendees: ['A', 'b@x.test'],
    });
    expect(result.items[0].actions.map((action) => action.kind)).toEqual(['open_event', 'rsvp_event']);
  });

  test('calendar_event_detail → one event with delete', () => {
    const result = shape(
      'calendar_event_detail',
      { account: 'acct_1', eventId: 'e1', calendarId: 'c1' },
      {
        event: {
          eventId: 'e1',
          accountId: 'acct_1',
          calendarId: 'c1',
          title: 'Dinner',
          startIso: '2026-09-11T18:00:00.000Z',
        },
      },
    );
    expect(result.kind).toBe('event');
    if (result.kind !== 'event') return;
    expect(result.item.actions.map((action) => action.kind)).toEqual([
      'open_event',
      'rsvp_event',
      'delete_event',
    ]);
  });

  test('calendar_suggest_times → slots with hold actions', () => {
    const result = shape(
      'calendar_suggest_times',
      { fromIso: 'x', toIso: 'y', durationMinutes: 30, count: 2, accountIds: ['acct_1'] },
      { suggestions: [{ startIso: '2026-09-11T10:00:00.000Z', endIso: '2026-09-11T10:30:00.000Z' }] },
    );
    expect(result.kind).toBe('slots');
    if (result.kind !== 'slots') return;
    expect(result.items[0].actions[0]).toMatchObject({ kind: 'hold_slot', account: 'acct_1' });
  });

  test('calendar_create_event → receipt with undo and open', () => {
    const result = shape(
      'calendar_create_event',
      {
        account: 'acct_1',
        title: 'Focus block',
        startIso: '2026-09-11T13:00:00.000Z',
        endIso: '2026-09-11T14:00:00.000Z',
      },
      { ok: true, eventId: 'e5', calendarId: 'c1', operationId: 'op_1' },
    );
    if (result.kind !== 'receipt') throw new Error('receipt expected');
    expect(result.surface).toBe('calendar');
    expect(result.operationId).toBe('op_1');
    expect(result.summary).toBe('Focus block');
    expect(result.actions.map((action) => action.kind)).toEqual(['open_event', 'undo_operation']);
  });

  test('calendar_update_event with needsDisambiguation renders nothing', () => {
    expect(
      resolveToolShape(
        'calendar_update_event',
        { matchTitle: 'x' },
        { ok: true, needsDisambiguation: true, candidates: [] },
      ),
    ).toBeNull();
  });

  test('tasks_create_card → task with complete and undo', () => {
    const result = shape(
      'tasks_create_card',
      { boardId: 'b1', column: 'Todo', title: 'Send invoice', dueIso: '2026-09-12T00:00:00.000Z' },
      { ok: true, cardId: 'card_1', operationId: 'op_9' },
    );
    expect(result.kind).toBe('task');
    if (result.kind !== 'task') return;
    expect(result.item).toMatchObject({
      cardId: 'card_1',
      boardId: 'b1',
      title: 'Send invoice',
      column: 'Todo',
    });
    expect(result.item.actions.map((action) => action.kind)).toEqual(['open_task', 'complete_task']);
    expect(result.actions).toEqual([{ kind: 'undo_operation', operationId: 'op_9' }]);
  });

  test('tasks_update_card → task state without complete when already done', () => {
    const result = shape(
      'tasks_update_card',
      { cardId: 'card_1', completed: true },
      {
        ok: true,
        operationId: 'op_2',
        card: { cardId: 'card_1', boardId: 'b1', title: 'Send invoice', completed: true, columnName: 'Done' },
      },
    );
    if (result.kind !== 'task') throw new Error('task expected');
    expect(result.item.completed).toBe(true);
    expect(result.item.column).toBe('Done');
    expect(result.item.actions.map((action) => action.kind)).toEqual(['open_task']);
  });

  test('tasks_get_board → board with per-column open counts', () => {
    const result = shape(
      'tasks_get_board',
      { boardId: 'b1' },
      {
        board: {
          boardId: 'b1',
          title: 'Ops',
          columns: [
            { columnId: 'c1', name: 'Todo' },
            { columnId: 'c2', name: 'Done' },
          ],
          cards: [
            { cardId: '1', columnId: 'c1' },
            { cardId: '2', columnId: 'c1', completedAt: 1 },
            { cardId: '3', columnId: 'c2', completedAt: 1 },
          ],
        },
      },
    );
    expect(result).toMatchObject({ kind: 'board', boardId: 'b1', title: 'Ops' });
    if (result.kind === 'board')
      expect(result.columns).toEqual([
        { name: 'Todo', count: 1 },
        { name: 'Done', count: 0 },
      ]);
  });

  test('albatross_get_work_context → work card', () => {
    const result = shape(
      'albatross_get_work_context',
      { workId: 'w1' },
      {
        ok: true,
        context: {
          work: { id: 'w1', title: 'Launch', state: 'active' },
          plan: { outcome: 'Ship v1', summary: 'Write the brief' },
        },
      },
    );
    expect(result.kind).toBe('work');
    if (result.kind !== 'work') return;
    expect(result.item).toMatchObject({
      workId: 'w1',
      title: 'Launch',
      status: 'active',
      currentStep: 'Write the brief',
    });
    expect(result.item.actions).toEqual([{ kind: 'open_work', workId: 'w1' }]);
  });

  test('albatross_capture_work with several items → works list', () => {
    const result = shape(
      'albatross_capture_work',
      { text: 'x' },
      {
        ok: true,
        work: [
          { id: 'a', title: 'A', shape: 'list' },
          { id: 'b', title: 'B' },
        ],
      },
    );
    expect(result.kind).toBe('works');
    if (result.kind === 'works') expect(result.items.map((item) => item.workId)).toEqual(['a', 'b']);
  });

  test('document_create → document with open and google link', () => {
    const result = shape(
      'document_create',
      { kind: 'doc', title: 'Memo' },
      {
        ok: true,
        documentId: 'd1',
        title: 'Memo',
        kind: 'doc',
        revision: 1,
        openPath: '/?view=files&document=d1',
        googleUrl: 'https://docs.google.com/x',
      },
    );
    expect(result).toMatchObject({
      kind: 'document',
      documentId: 'd1',
      docKind: 'doc',
      status: 'created',
      path: '/?view=files&document=d1',
    });
    expect(result.actions.map((action) => action.kind)).toEqual(['open_document', 'open_url']);
  });

  test('cloud_file_search → files with import and open actions; folders cannot import', () => {
    const result = shape(
      'cloud_file_search',
      { query: 'budget' },
      {
        files: [
          {
            id: 'f1',
            name: 'Budget.xlsx',
            provider: 'google_drive',
            connectionId: 'conn',
            mimeType: 'x/y',
            webUrl: 'https://drive.test/f1',
            isFolder: false,
            modifiedAt: 1_789_000_000_000,
          },
          { id: 'f2', name: 'Folder', provider: 'google_drive', connectionId: 'conn', isFolder: true },
        ],
      },
    );
    if (result.kind !== 'files') throw new Error('files expected');
    expect(result.items[0].actions.map((action) => action.kind)).toEqual(['import_file', 'open_url']);
    expect(result.items[1].actions).toEqual([]);
    expect(result.items[1].kind).toBe('folder');
  });

  test('browserbase_search → sources', () => {
    const result = shape(
      'browserbase_search',
      { query: 'nylas' },
      { results: [{ title: 'Nylas', url: 'https://nylas.com', snippet: 'API' }] },
    );
    expect(result.kind).toBe('sources');
  });

  test('remember → memory receipt with the note as summary', () => {
    const result = shape(
      'remember',
      { email: 'ada@x.test', notes: 'Prefers mornings' },
      { ok: true, memory: {} },
    );
    expect(result).toMatchObject({ kind: 'receipt', surface: 'memory', summary: 'Prefers mornings' });
  });

  test('unknown tools with a summary get a text shape; otherwise nothing', () => {
    expect(resolveToolShape('some_future_tool', {}, { summary: 'Did a thing' })).toMatchObject({
      kind: 'text',
      text: 'Did a thing',
    });
    expect(resolveToolShape('some_future_tool', {}, { ok: true })).toBeNull();
  });

  test('never throws on garbage output', () => {
    expect(() => resolveToolShape('search_threads', null, 'nope')).not.toThrow();
    expect(() => resolveToolShape('calendar_list_events', undefined, { events: 'x' })).not.toThrow();
    expect(resolveToolShape('search_threads', { query: 'x' }, { items: [{}] })).toBeNull();
  });
});

describe('parseSender', () => {
  test('splits display names and bare addresses', () => {
    expect(parseSender('Ada Lovelace <ada@x.test>')).toEqual({ name: 'Ada Lovelace', email: 'ada@x.test' });
    expect(parseSender('"Ada" <ada@x.test>')).toEqual({ name: 'Ada', email: 'ada@x.test' });
    expect(parseSender('ada@x.test')).toEqual({ name: 'ada@x.test', email: 'ada@x.test' });
    expect(parseSender('')).toEqual({ name: '' });
  });
});

describe('forwardAgentStream shape emission', () => {
  async function* chunks(list: any[]) {
    for (const chunk of list) yield chunk;
  }

  test('a data-tool-shape part follows each tool result with the same id', async () => {
    const written: any[] = [];
    await forwardAgentStream(
      { write: (chunk: any) => written.push(chunk) } as any,
      chunks([
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'corpus_count' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'corpus_count', input: { query: 'x' } },
        {
          type: 'tool-output-available',
          toolCallId: 'c1',
          output: { total: 3, approximate: false, accounts: [] },
        },
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'show_plan', input: {} },
        { type: 'tool-output-available', toolCallId: 'c2', output: { ok: true } },
      ]),
    );
    const shapes = written.filter((chunk) => chunk.type === 'data-tool-shape');
    expect(shapes).toHaveLength(1);
    expect(shapes[0].id).toBe('c1');
    expect(shapes[0].data).toMatchObject({ kind: 'count', value: 3 });
    const index = written.findIndex(
      (chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'c1',
    );
    expect(written[index + 1].type).toBe('data-tool-shape');
  });

  test('a throwing resolver never breaks the stream', async () => {
    const written: any[] = [];
    await forwardAgentStream(
      { write: (chunk: any) => written.push(chunk) } as any,
      chunks([
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'corpus_count', input: {} },
        { type: 'tool-output-available', toolCallId: 'c1', output: {} },
      ]),
      () => undefined,
      () => {
        throw new Error('bad');
      },
    );
    expect(written.map((chunk) => chunk.type)).toEqual(['tool-input-available', 'tool-output-available']);
  });
});
