import { describe, expect, test } from 'bun:test';
import { resolveToolShape, SHAPED_TOOL_NAMES, type ToolShapeKind } from '../lib/ai/tool-shapes';

// Every mapped tool, driven by a plausible fixture, must resolve to the shape
// kind the contract promises. This table is the parity reference for native.

const thread = {
  _id: 't1',
  account: 'acct_1',
  subject: 'Hello',
  fromAddress: 'Ada <ada@x.test>',
  lastDate: 1_789_000_000_000,
  snippet: 'hi',
  unread: false,
};
const message = {
  _id: 'm1',
  threadId: 't1',
  account: 'acct_1',
  subject: 'Hello',
  from: 'Ada <ada@x.test>',
  fromEmail: 'ada@x.test',
  date: 1_789_000_000_000,
  snippet: 'hi',
  textBody: 'body text',
  attachments: [],
};
const event = {
  eventId: 'e1',
  accountId: 'acct_1',
  calendarId: 'c1',
  title: 'Call',
  startIso: '2026-09-11T10:00:00.000Z',
  endIso: '2026-09-11T10:30:00.000Z',
};
const card = { cardId: 'card_1', boardId: 'b1', title: 'Task', dueAt: 1_789_000_000_000, priority: 'high' };
const opOk = { ok: true, operationId: 'op_1' };

const TABLE: Array<[string, unknown, unknown, ToolShapeKind]> = [
  ['search_threads', { account: 'acct_1', query: 'q' }, { items: [thread] }, 'threads'],
  ['list_smart_category', { account: 'acct_1', category: 'Codes' }, { items: [thread] }, 'threads'],
  ['recent_threads', {}, { threads: [thread] }, 'threads'],
  ['list_account_threads', { account: 'acct_1' }, { threads: [thread] }, 'threads'],
  ['preview_smart_label', { name: 'Receipts' }, { items: [thread] }, 'threads'],
  ['corpus_search', { query: 'q' }, { items: [{ ...thread, source: 'mail' }] }, 'threads'],
  [
    'read_thread',
    { account: 'acct_1', threadId: 't1' },
    {
      account: 'acct_1',
      threadId: 't1',
      subject: 'Hello',
      messages: [{ from: 'Ada <ada@x.test>', date: 1, body: 'b' }],
    },
    'thread',
  ],
  [
    'get_thread',
    { account: 'acct_1', threadId: 't1' },
    { account: 'acct_1', threadId: 't1', subject: 'Hello', messages: [message], summary: 'Sum' },
    'thread',
  ],
  ['get_message', { account: 'acct_1', id: 'm1' }, message, 'thread'],
  [
    'thread_timeline',
    { account: 'acct_1', threadId: 't1' },
    {
      messages: [
        { from: 'Ada <ada@x.test>', to: 'me', date: 1, subject: 'Hello', snippet: 's', unread: false },
      ],
    },
    'thread',
  ],
  ['sender_profile', { email: 'ada@x.test' }, { email: 'ada@x.test', totalMessages: 2 }, 'contact'],
  ['corpus_count', { query: 'q' }, { total: 1 }, 'count'],
  ['calendar_count_events', {}, { total: 4 }, 'count'],
  ['summarize_thread', {}, { summary: 'Short summary' }, 'text'],
  ['triage_thread', {}, { priority: 1, action: 'Reply', reason: 'Asks a question' }, 'text'],
  ['draft_reply', {}, { draft: 'Thanks, will do.' }, 'text'],
  ['extract_action_items', {}, { items: ['Send invoice', 'Book room'] }, 'text'],
  ['translate_thread', {}, { translation: 'Hola' }, 'text'],
  ['pre_send_critique', {}, { verdict: 'review', notes: ['Too long'] }, 'text'],
  ['list_accounts', {}, { accounts: [{ email: 'me@x.test', accountId: 'acct_1' }] }, 'text'],
  ['archive_thread', { account: 'acct_1', threadId: 't1' }, { ok: true }, 'receipt'],
  ['trash_thread', { account: 'acct_1', threadId: 't1' }, { ok: true }, 'receipt'],
  ['mute_thread', { account: 'acct_1', threadId: 't1' }, { ok: true }, 'receipt'],
  ['mark_read', { account: 'acct_1', messageId: 'm1' }, { ok: true }, 'receipt'],
  ['mark_unread', { account: 'acct_1', messageId: 'm1' }, { ok: true }, 'receipt'],
  ['star', { account: 'acct_1', messageId: 'm1' }, { ok: true }, 'receipt'],
  ['unstar', { account: 'acct_1', messageId: 'm1' }, { ok: true }, 'receipt'],
  ['add_label', { account: 'acct_1', messageId: 'm1', label: 'x' }, { ok: true }, 'receipt'],
  ['remove_label', { account: 'acct_1', messageId: 'm1', label: 'x' }, { ok: true }, 'receipt'],
  [
    'snooze_thread',
    { account: 'acct_1', threadId: 't1', messageId: 'm1', untilTs: 1 },
    { ok: true, untilIso: '2026-09-12T08:00:00.000Z' },
    'receipt',
  ],
  ['unsnooze_thread', { account: 'acct_1', messageId: 'm1' }, { ok: true }, 'receipt'],
  ['create_label', { account: 'acct_1', name: 'Later' }, { ok: true, id: 'l1' }, 'receipt'],
  [
    'save_draft',
    { account: 'acct_1', threadId: 't1' },
    {
      ok: true,
      draft: { _id: 'd1', account: 'acct_1', threadId: 't1', subject: 'Re: Hello' },
      operationId: 'op_1',
    },
    'receipt',
  ],
  [
    'schedule_send',
    { account: 'acct_1', scheduledFor: 1_789_000_000_000 },
    { ok: true, scheduleId: 's1' },
    'receipt',
  ],
  ['cancel_scheduled', { account: 'acct_1', scheduleId: 's1' }, { ok: true }, 'receipt'],
  ['undo_send', { pendingId: 'p1' }, { ok: true, undone: true }, 'receipt'],
  ['create_smart_label', { name: 'Receipts' }, { label: { name: 'Receipts' } }, 'receipt'],
  ['update_smart_label', { id: 'l1' }, { label: {} }, 'receipt'],
  ['delete_smart_label', { id: 'l1' }, { ok: true }, 'receipt'],
  ['create_smart_rule', { name: 'Rule' }, { rule: { name: 'Rule' } }, 'receipt'],
  ['set_smart_rule_enabled', { id: 'r1', enabled: false }, { ok: true }, 'receipt'],
  ['apply_smart_correction', { account: 'acct_1', threadId: 't1', action: 'move' }, { ok: true }, 'receipt'],
  ['calendar_list_events', { accountIds: ['acct_1'] }, { events: [event] }, 'events'],
  ['calendar_search_events', { query: 'call' }, { events: [event] }, 'events'],
  ['calendar_event_detail', { account: 'acct_1', eventId: 'e1' }, { event }, 'event'],
  [
    'calendar_suggest_times',
    { accountIds: ['acct_1'] },
    { suggestions: [{ startIso: event.startIso, endIso: event.endIso }] },
    'slots',
  ],
  [
    'calendar_create_event',
    { account: 'acct_1', title: 'Call', startIso: event.startIso },
    { ok: true, eventId: 'e1', calendarId: 'c1', operationId: 'op_1' },
    'receipt',
  ],
  [
    'calendar_update_event',
    { account: 'acct_1', eventId: 'e1' },
    { ok: true, operationId: 'op_1' },
    'receipt',
  ],
  [
    'calendar_delete_event',
    { account: 'acct_1', matchTitle: 'Call' },
    { ok: true, operationId: 'op_1', deletedTitle: 'Call' },
    'receipt',
  ],
  [
    'calendar_rsvp_event',
    { account: 'acct_1', calendarId: 'c1', eventId: 'e1', status: 'yes' },
    { ok: true, operationId: 'op_1' },
    'receipt',
  ],
  ['calendar_delete_recurring_series', { account: 'acct_1' }, { ok: true, deleted: 3 }, 'receipt'],
  [
    'calendar_unsubscribe_calendar',
    { account: 'acct_1', calendarId: 'c1' },
    { ok: true, accountId: 'acct_1', calendarId: 'c1', name: 'Holidays' },
    'receipt',
  ],
  ['salvage_context', {}, { events: [event], tasks: [{ ...card, dueIso: event.startIso }] }, 'events'],
  [
    'tasks_get_board',
    { boardId: 'b1' },
    {
      board: {
        boardId: 'b1',
        title: 'Ops',
        columns: [{ columnId: 'c1', name: 'Todo' }],
        cards: [{ cardId: '1', columnId: 'c1' }],
      },
    },
    'board',
  ],
  ['tasks_list_boards', {}, { boards: [{ boardId: 'b1', title: 'Ops' }] }, 'text'],
  ['tasks_due_cards', {}, { cards: [card] }, 'tasks'],
  ['tasks_for_thread', { threadId: 't1' }, { cards: [card] }, 'tasks'],
  [
    'tasks_create_card',
    { boardId: 'b1', title: 'Task', column: 'Todo' },
    { ok: true, cardId: 'card_1', operationId: 'op_1' },
    'task',
  ],
  [
    'tasks_update_card',
    { cardId: 'card_1' },
    {
      ...opOk,
      card: { cardId: 'card_1', boardId: 'b1', title: 'Task', completed: false, columnName: 'Todo' },
    },
    'task',
  ],
  [
    'tasks_move_card',
    { cardId: 'card_1', column: 'Done' },
    {
      ...opOk,
      card: { cardId: 'card_1', boardId: 'b1', title: 'Task', completed: true, columnName: 'Done' },
    },
    'task',
  ],
  ['tasks_delete_card', { cardId: 'card_1' }, opOk, 'receipt'],
  ['tasks_add_comment', { cardId: 'card_1', body: 'note' }, { ok: true }, 'receipt'],
  [
    'tasks_attach_link',
    { cardId: 'card_1', url: 'https://x.test' },
    { ...opOk, url: 'https://x.test' },
    'receipt',
  ],
  ['tasks_attach_file', { cardId: 'card_1', name: 'f.pdf' }, { ...opOk, name: 'f.pdf' }, 'receipt'],
  [
    'tasks_attach_calendar_event_link',
    { cardId: 'card_1', account: 'acct_1', eventId: 'e1' },
    { ...opOk, url: 'https://cal.test', name: 'Call' },
    'receipt',
  ],
  ['tasks_create_board', { title: 'New board' }, { ok: true, boardId: 'b2', operationId: 'op_1' }, 'receipt'],
  ['tasks_rename_board', { boardId: 'b1', title: 'Renamed' }, opOk, 'receipt'],
  ['tasks_delete_board', { boardId: 'b1' }, opOk, 'receipt'],
  ['tasks_create_column', { boardId: 'b1', name: 'Later' }, { ...opOk, columnId: 'c9' }, 'receipt'],
  ['tasks_rename_column', { boardId: 'b1', column: 'Later', name: 'Someday' }, opOk, 'receipt'],
  ['tasks_delete_column', { boardId: 'b1', column: 'Someday' }, opOk, 'receipt'],
  [
    'mcp_create_task',
    { connectionId: 'conn', externalId: 'x', server: 'github', title: 'Fix' },
    { ok: true, cardId: 'card_7', operationId: 'op_1' },
    'receipt',
  ],
  [
    'albatross_get_work_context',
    { workId: 'w1' },
    { ok: true, context: { work: { id: 'w1', title: 'Launch' }, plan: null } },
    'work',
  ],
  [
    'albatross_capture_work',
    { text: 'x' },
    { ok: true, work: [{ id: 'w1', title: 'One', horizon: { kind: 'week' } }] },
    'work',
  ],
  [
    'albatross_replan_work',
    { workId: 'w1', reason: 'late' },
    { ok: true, workId: 'w1', title: 'Launch', currentStep: 'Draft', summary: 'Replanned' },
    'work',
  ],
  [
    'albatross_record_progress',
    { workId: 'w1', claim: 'Done step 1' },
    { ok: true, workId: 'w1', claim: 'Done step 1', summary: 'Recorded' },
    'receipt',
  ],
  [
    'albatross_split_work',
    { workId: 'w1' },
    {
      ok: true,
      workId: 'w1',
      committed: false,
      proposed: [{ title: 'A' }, { title: 'B' }],
      summary: 'Two parts',
    },
    'text',
  ],
  [
    'albatross_list_add',
    { workTitle: 'Groceries', text: 'Milk' },
    { ok: true, workId: 'w1', workTitle: 'Groceries', item: { text: 'Milk' }, summary: 'Added Milk' },
    'receipt',
  ],
  [
    'albatross_metric_log',
    { workTitle: 'Run', value: 5 },
    { ok: true, workId: 'w1', workTitle: 'Run', entry: { value: 5 }, summary: 'Logged 5' },
    'receipt',
  ],
  ['albatross_list_projects', {}, { projects: [{ _id: 'p1', title: 'Proj', status: 'active' }] }, 'works'],
  [
    'albatross_create_project',
    { title: 'Proj' },
    { ok: true, projectId: 'p1', operationId: 'op_1' },
    'receipt',
  ],
  [
    'albatross_create_sprint',
    { projectId: 'p1', title: 'Sprint 1' },
    { ok: true, sprintId: 's1', operationId: 'op_1' },
    'receipt',
  ],
  [
    'albatross_create_routine',
    { title: 'Weekly review' },
    { ok: true, routineId: 'r1', status: 'proposed' },
    'receipt',
  ],
  ['albatross_set_routine_consent', { routineId: 'r1', consent: true }, { ok: true }, 'receipt'],
  ['albatross_run_routine_now', { routineId: 'r1' }, { ok: true }, 'receipt'],
  [
    'area_create',
    { name: 'Acme', kind: 'client', primaryDomain: 'acme.test' },
    { ok: true, areaId: 'a1', name: 'Acme', status: 'active' },
    'area',
  ],
  ['area_list', {}, { areas: [{ _id: 'a1', name: 'Acme' }] }, 'text'],
  [
    'area_add_fact',
    { areaId: 'a1', value: 'Renews in June' },
    { ok: true, factId: 'f1', status: 'candidate' },
    'receipt',
  ],
  ['area_update_identity', { areaId: 'a1' }, { ok: true }, 'receipt'],
  ['area_archive', { areaId: 'a1' }, { ok: true }, 'receipt'],
  [
    'document_create',
    { kind: 'doc', title: 'Memo' },
    {
      ok: true,
      documentId: 'd1',
      title: 'Memo',
      kind: 'doc',
      revision: 1,
      openPath: '/?view=files&document=d1',
    },
    'document',
  ],
  [
    'document_edit',
    { documentId: 'd1' },
    {
      ok: true,
      status: 'applied',
      documentId: 'd1',
      title: 'Memo',
      kind: 'doc',
      revision: 2,
      summary: 'Edited',
      openPath: '/x',
    },
    'document',
  ],
  [
    'document_suggest_changes',
    { documentId: 'd1' },
    { ok: true, suggestionId: 's1', title: 'Memo', description: 'Tighten', openPath: '/x' },
    'document',
  ],
  [
    'document_apply_instruction',
    { documentId: 'd1' },
    { ok: true, documentId: 'd1', title: 'Memo', revision: 3, summary: 'Applied', openPath: '/x' },
    'document',
  ],
  [
    'document_get',
    { documentId: 'd1' },
    {
      document: {
        documentId: 'd1',
        title: 'Memo',
        kind: 'doc',
        currentRevision: 3,
        google: { webUrl: 'https://docs.google.com/d' },
      },
      text: '...',
    },
    'document',
  ],
  [
    'document_export',
    { documentId: 'd1' },
    {
      ok: true,
      downloadPath: '/api/documents/d1/export',
      fidelity: 'projection',
      warning: 'Values only',
      openPath: '/x',
    },
    'document',
  ],
  [
    'document_publish_google',
    { documentId: 'd1' },
    { ok: true, fileId: 'g1', webUrl: 'https://docs.google.com/d', syncedRevision: 3 },
    'receipt',
  ],
  [
    'google_file_import',
    { connectionId: 'conn', fileId: 'g1' },
    {
      ok: true,
      documentId: 'd2',
      title: 'Sheet',
      kind: 'sheet',
      revision: 1,
      openPath: '/x',
      existing: false,
    },
    'document',
  ],
  ['document_list', {}, { documents: [{ documentId: 'd1', title: 'Memo' }] }, 'text'],
  [
    'cloud_file_search',
    { query: 'q' },
    { files: [{ id: 'f1', name: 'Doc', provider: 'google_drive', connectionId: 'conn', isFolder: false }] },
    'files',
  ],
  ['remember', { email: 'ada@x.test', notes: 'Likes tea' }, { ok: true, memory: {} }, 'receipt'],
  ['forget', { email: 'ada@x.test' }, { ok: true }, 'receipt'],
  ['recall', { email: 'ada@x.test' }, { memory: { email: 'ada@x.test', notes: 'Likes tea' } }, 'text'],
  [
    'mcp_search',
    { query: 'q' },
    { items: [{ server: 'github', title: 'PR 1', url: 'https://gh.test/1' }] },
    'sources',
  ],
  [
    'github_search',
    { query: 'q' },
    { items: [{ server: 'github', title: 'Issue', url: 'https://gh.test/2' }] },
    'sources',
  ],
  [
    'mcp_list_items',
    { server: 'granola' },
    { items: [{ server: 'granola', title: 'Standup notes', summary: 'Decided x' }] },
    'sources',
  ],
  [
    'browserbase_search',
    { query: 'q' },
    { results: [{ title: 'Site', url: 'https://s.test', snippet: 'About' }] },
    'sources',
  ],
  ['undo_operation', { operationId: 'op_1' }, { ok: true, undone: 'Created event' }, 'receipt'],
  [
    'list_recent_operations',
    {},
    { operations: [{ operationId: 'op_1', summary: 'Archived a thread' }] },
    'text',
  ],
];

describe('tool shape table', () => {
  test('every mapped tool has a fixture in the table', () => {
    const covered = new Set(TABLE.map(([name]) => name));
    const missing = [...SHAPED_TOOL_NAMES].filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  for (const [name, input, output, kind] of TABLE) {
    test(`${name} → ${kind}`, () => {
      const shape = resolveToolShape(name, input, output);
      expect(shape?.kind).toBe(kind);
      expect(shape?.title).toBeTruthy();
      expect(shape?.activity.running).toBeTruthy();
      expect(shape?.activity.done).toBeTruthy();
      expect(shape?.activity.failed).toBeTruthy();
      expect(Array.isArray(shape?.actions)).toBe(true);
      // Shapes travel to native as JSON: no undefined-only surprises, no cycles.
      expect(() => JSON.stringify(shape)).not.toThrow();
    });
  }

  test('empty list outputs resolve to nothing instead of an empty card', () => {
    expect(resolveToolShape('search_threads', { query: 'q' }, { items: [] })).toBeNull();
    expect(resolveToolShape('calendar_list_events', {}, { events: [] })).toBeNull();
    expect(resolveToolShape('tasks_due_cards', {}, { cards: [] })).toBeNull();
    expect(resolveToolShape('cloud_file_search', {}, { files: [] })).toBeNull();
    expect(resolveToolShape('mcp_search', {}, { items: [] })).toBeNull();
    expect(resolveToolShape('area_list', {}, { areas: [] })).toBeNull();
    expect(resolveToolShape('recall', {}, { memory: null })).toBeNull();
  });

  test('a committed split becomes a receipt that opens the work', () => {
    const shape = resolveToolShape(
      'albatross_split_work',
      { workId: 'w1' },
      { ok: true, workId: 'w1', committed: true, workIds: ['a', 'b'], summary: 'Split' },
    );
    expect(shape?.kind).toBe('receipt');
    expect(shape?.actions[0]).toEqual({ kind: 'open_work', workId: 'w1' });
  });

  test('salvage falls back to tasks when no events remain', () => {
    const shape = resolveToolShape('salvage_context', {}, { events: [], tasks: [card] });
    expect(shape?.kind).toBe('tasks');
    expect(shape?.summary).toContain('0 events');
  });
});
