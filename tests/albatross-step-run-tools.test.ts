import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { AgentBrowser, type AgentPage } from '../lib/albatross/browser-agent';
import {
  artifactFromToolResult,
  buildRunnerTools,
  describeToolCall,
  handoffInputSchema,
  RUNNER_REGISTRY_TOOLS,
  type RunArtifact,
  type RunnerToolHost,
} from '../lib/albatross/step-run-tools';

const SNAPSHOT = [
  '- textbox "Email" [ref=e1]',
  '- textbox "Password" [ref=e2]',
  '- combobox "Reason" [ref=e3]',
  '- button "Continue" [ref=e4] [cursor=pointer]',
  '- button "Submit dispute" [ref=e5]',
].join('\n');

function fakePage(snapshot = SNAPSHOT): AgentPage {
  return {
    goto: async () => undefined,
    url: () => 'https://www.bank.example/dispute',
    title: async () => 'Dispute',
    snapshot: async () => snapshot,
    click: async () => undefined,
    fill: async () => undefined,
    select: async () => undefined,
    press: async () => undefined,
    back: async () => undefined,
    wait: async () => undefined,
    inputKind: async () => null,
    text: async () => '',
  };
}

function makeHost(overrides: Partial<RunnerToolHost> = {}, page: AgentPage = fakePage()) {
  const logs: string[] = [];
  const artifacts: RunArtifact[] = [];
  const statuses: string[] = [];
  const approvals: any[] = [];
  const finish = mock((_handoff: unknown) => undefined);
  const agentBrowser = new AgentBrowser(page);
  const host: RunnerToolHost = {
    log: async (line) => {
      logs.push(line);
    },
    artifact: async (artifact) => {
      artifacts.push(artifact);
    },
    browser: async () => agentBrowser,
    browserStatus: async (detail) => {
      statuses.push(detail);
    },
    enqueueApproval: async (input) => {
      approvals.push(input);
      return 'approval-1';
    },
    finish,
    browserAvailable: false,
    ...overrides,
  };
  return { host, logs, artifacts, statuses, approvals, finish };
}

function baseTool(result: unknown) {
  return {
    description: 'base description',
    inputSchema: z.object({}).passthrough(),
    execute: mock(async (_args: unknown, _options?: unknown) => result),
  };
}

describe('describeToolCall', () => {
  test('mail searches show the query when there is one', () => {
    for (const name of ['search_threads', 'corpus_search', 'nl_search']) {
      expect(describeToolCall(name, { query: '  refund   from bank ' }, null)).toBe(
        'Searched your mail for “refund from bank”.',
      );
      expect(describeToolCall(name, {}, null)).toBe('Searched your mail.');
    }
    expect(describeToolCall('search_threads', { query: 42 }, null)).toBe('Searched your mail.');
    expect(describeToolCall('search_threads', { query: 'q'.repeat(200) }, null)).toBe(
      `Searched your mail for “${'q'.repeat(80)}”.`,
    );
  });

  test('reads, drafts, and calendar calls', () => {
    expect(describeToolCall('get_thread', {}, {})).toBe('Read a mail thread.');
    expect(describeToolCall('read_thread', {}, {})).toBe('Read a mail thread.');
    expect(describeToolCall('save_draft', {}, { draft: { subject: 'Dispute' } })).toBe(
      'Saved a draft: “Dispute”.',
    );
    expect(describeToolCall('save_draft', { subject: 'From args' }, {})).toBe('Saved a draft: “From args”.');
    expect(describeToolCall('save_draft', {}, {})).toBe('Saved a draft.');
    expect(describeToolCall('update_draft', {}, {})).toBe('Changed the draft.');
    expect(describeToolCall('calendar_create_event', { title: 'Focus' }, {})).toBe(
      'Added a hold to your calendar: “Focus”.',
    );
    expect(describeToolCall('calendar_create_event', {}, {})).toBe('Added a hold to your calendar.');
    for (const name of [
      'calendar_list_events',
      'calendar_search_events',
      'calendar_free_busy',
      'calendar_suggest_times',
    ])
      expect(describeToolCall(name, {}, {})).toBe('Checked your calendar.');
  });

  test('tasks, documents, the web, files, and memory', () => {
    expect(describeToolCall('tasks_create_card', { title: 'Call the bank' }, {})).toBe(
      'Added a task: “Call the bank”.',
    );
    expect(describeToolCall('tasks_create_card', {}, {})).toBe('Added a task.');
    expect(describeToolCall('document_create', {}, { title: 'Comparison' })).toBe('Wrote “Comparison”.');
    expect(describeToolCall('word_document_create', { title: 'Letter' }, {})).toBe('Wrote “Letter”.');
    expect(describeToolCall('document_create', {}, null)).toBe('Wrote “a document”.');
    for (const name of ['document_edit', 'document_apply_instruction', 'word_document_edit'])
      expect(describeToolCall(name, {}, {})).toBe('Changed the document.');
    expect(describeToolCall('document_publish_google', {}, {})).toBe('Saved the document to Google Drive.');
    expect(describeToolCall('browserbase_search', { query: 'dispute form' }, {})).toBe(
      'Searched the web for “dispute form”.',
    );
    expect(describeToolCall('browserbase_search', {}, {})).toBe('Searched the web.');
    expect(describeToolCall('browserbase_fetch', { url: 'https://www.bank.example/help' }, {})).toBe(
      'Read bank.example.',
    );
    expect(describeToolCall('browserbase_fetch', { url: 'not a url' }, {})).toBe('Read not a url.');
    expect(describeToolCall('browserbase_fetch', {}, {})).toBe('Read a web page.');
    expect(describeToolCall('cloud_file_search', {}, {})).toBe('Searched your files.');
    expect(describeToolCall('remember', {}, {})).toBe('Saved a note for later.');
  });

  test('a quiet read has no line', () => {
    expect(describeToolCall('list_accounts', {}, {})).toBeNull();
    expect(describeToolCall('recall', { query: 'x' }, {})).toBeNull();
  });
});

describe('artifactFromToolResult', () => {
  test('no result and a failed result make nothing', () => {
    expect(artifactFromToolResult('save_draft', {}, null)).toBeNull();
    expect(artifactFromToolResult('save_draft', {}, { ok: false, draft: { id: 'd' } })).toBeNull();
  });

  test('a saved draft', () => {
    expect(
      artifactFromToolResult(
        'save_draft',
        {},
        { ok: true, draft: { id: 'draft-1', subject: 'Dispute', account: 'acct-1' } },
      ),
    ).toEqual({ kind: 'draft', id: 'draft-1', title: 'Dispute', accountId: 'acct-1' });
    expect(
      artifactFromToolResult('save_draft', {}, { draft: { _id: 'draft-2', accountId: 'acct-2' } }),
    ).toEqual({
      kind: 'draft',
      id: 'draft-2',
      title: 'Draft',
      accountId: 'acct-2',
    });
    expect(
      artifactFromToolResult('save_draft', { subject: 'Args', account: 'acct-3' }, { ok: true }),
    ).toEqual({
      kind: 'draft',
      title: 'Args',
      accountId: 'acct-3',
    });
    expect(artifactFromToolResult('save_draft', {}, { ok: true })).toEqual({ kind: 'draft', title: 'Draft' });
  });

  test('a document', () => {
    for (const name of ['document_create', 'word_document_create']) {
      expect(
        artifactFromToolResult(
          name,
          {},
          { documentId: 'doc-1', title: 'Plan', openPath: '/documents/doc-1' },
        ),
      ).toEqual({ kind: 'document', id: 'doc-1', title: 'Plan', url: '/documents/doc-1' });
      expect(artifactFromToolResult(name, { title: 'From args' }, { documentId: 7 })).toEqual({
        kind: 'document',
        id: '7',
        title: 'From args',
      });
      expect(artifactFromToolResult(name, {}, { documentId: 'doc-2' })?.title).toBe('Document');
      expect(artifactFromToolResult(name, {}, { ok: true })).toBeNull();
    }
  });

  test('a calendar hold', () => {
    expect(
      artifactFromToolResult(
        'calendar_create_event',
        { title: 'Focus', account: 'acct-1' },
        { eventId: 'evt-1', htmlLink: 'https://calendar.example/evt-1' },
      ),
    ).toEqual({
      kind: 'event',
      id: 'evt-1',
      title: 'Focus',
      url: 'https://calendar.example/evt-1',
      accountId: 'acct-1',
    });
    expect(artifactFromToolResult('calendar_create_event', {}, { eventId: 'evt-2' })).toEqual({
      kind: 'event',
      id: 'evt-2',
      title: 'Calendar hold',
    });
    expect(artifactFromToolResult('calendar_create_event', {}, { ok: true })).toBeNull();
  });

  test('a task card', () => {
    expect(artifactFromToolResult('tasks_create_card', { title: 'Call' }, { cardId: 'card-1' })).toEqual({
      kind: 'card',
      id: 'card-1',
      title: 'Call',
    });
    expect(artifactFromToolResult('tasks_create_card', {}, { cardId: 'card-2' })?.title).toBe('Task');
    expect(artifactFromToolResult('tasks_create_card', {}, { ok: true })).toBeNull();
  });

  test('other tools make nothing', () => {
    expect(artifactFromToolResult('recall', {}, { ok: true, documentId: 'x' })).toBeNull();
  });
});

describe('handoffInputSchema', () => {
  test('accepts a full handoff and refuses a long label', () => {
    const valid = {
      outcome: 'ready_for_you',
      summary: 'I wrote the letter.',
      next: { kind: 'review_draft', label: 'Read and send', detail: 'Read the draft and send it.' },
    };
    expect(handoffInputSchema.safeParse(valid).success).toBe(true);
    expect(
      handoffInputSchema.safeParse({ ...valid, next: { ...valid.next, label: 'L'.repeat(49) } }).success,
    ).toBe(false);
    expect(handoffInputSchema.safeParse({ ...valid, outcome: 'stopped' }).success).toBe(false);
  });
});

describe('buildRunnerTools', () => {
  test('keeps only runner registry tools that can execute, plus the run tools', () => {
    const lifted: Record<string, any> = {
      save_draft: baseTool({ ok: true }),
      list_drafts: baseTool({ ok: true }),
      send_message: baseTool({ ok: true }),
      delete_draft: baseTool({ ok: true }),
      list_accounts: { description: 'no execute' },
    };
    const { host } = makeHost();
    const tools = buildRunnerTools(lifted, host);
    expect(Object.keys(tools).sort()).toEqual(['list_drafts', 'save_draft', 'step_handoff', 'step_note']);
    expect(tools.save_draft.description).toBe('base description');
    expect(tools.save_draft.inputSchema).toBe(lifted.save_draft.inputSchema);
    expect(RUNNER_REGISTRY_TOOLS).not.toContain('send_message' as any);
  });

  test('a normal call runs the base tool, logs a line, and records the artifact', async () => {
    const result = { ok: true, draft: { id: 'draft-1', subject: 'Dispute', account: 'acct-1' } };
    const lifted = { save_draft: baseTool(result), list_drafts: baseTool({ ok: true, drafts: [] }) };
    const { host, logs, artifacts } = makeHost();
    const tools = buildRunnerTools(lifted, host);
    const options = { toolCallId: 'call-1' };
    expect(await tools.save_draft.execute({ subject: 'Dispute' }, options)).toBe(result);
    expect(lifted.save_draft.execute).toHaveBeenCalledWith({ subject: 'Dispute' }, options);
    expect(logs).toEqual(['Saved a draft: “Dispute”.']);
    expect(artifacts).toEqual([{ kind: 'draft', id: 'draft-1', title: 'Dispute', accountId: 'acct-1' }]);

    await tools.list_drafts.execute({});
    expect(logs).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
  });

  test('a calendar invite with attendees is queued for approval and never runs', async () => {
    const lifted = { calendar_create_event: baseTool({ ok: true, eventId: 'evt-1' }) };
    const { host, logs, artifacts, approvals } = makeHost();
    const tools = buildRunnerTools(lifted, host);
    const args = { title: 'Team lunch', attendees: [{ email: 'sam@example.com' }] };
    const result = await tools.calendar_create_event.execute(args);
    expect(lifted.calendar_create_event.execute).not.toHaveBeenCalled();
    expect(approvals).toEqual([
      {
        kind: 'calendar_invite',
        title: 'Send the invite: Team lunch',
        toolName: 'calendar_create_event',
        toolArgs: args,
      },
    ]);
    expect(artifacts).toEqual([{ kind: 'approval', id: 'approval-1', title: 'Send the invite: Team lunch' }]);
    expect(logs).toEqual(['Prepared the invite for your approval.']);
    expect(result).toMatchObject({ ok: true, status: 'queued_for_approval', approvalId: 'approval-1' });
    expect(result.message).toContain('next.kind approve');
  });

  test('the invite title falls back to the summary, then to "event"', async () => {
    const { host, approvals } = makeHost();
    const tools = buildRunnerTools({ calendar_create_event: baseTool({ ok: true }) }, host);
    await tools.calendar_create_event.execute({ summary: 'Sync', attendees: [{ name: 'Sam' }] });
    await tools.calendar_create_event.execute({ attendees: [{ email: 'a@example.com' }] });
    expect(approvals.map((entry) => entry.title)).toEqual([
      'Send the invite: Sync',
      'Send the invite: event',
    ]);
  });

  test('a calendar hold without attendees runs the base tool', async () => {
    const lifted = { calendar_create_event: baseTool({ ok: true, eventId: 'evt-1' }) };
    const { host, logs, artifacts, approvals } = makeHost();
    const tools = buildRunnerTools(lifted, host);
    await tools.calendar_create_event.execute({ title: 'Focus' });
    await tools.calendar_create_event.execute({ title: 'Focus 2', attendees: [{}] });
    expect(lifted.calendar_create_event.execute).toHaveBeenCalledTimes(2);
    expect(approvals).toEqual([]);
    expect(logs[0]).toBe('Added a hold to your calendar: “Focus”.');
    expect(artifacts[0]).toEqual({ kind: 'event', id: 'evt-1', title: 'Focus' });
  });

  test('an RSVP is always queued', async () => {
    const lifted = { calendar_rsvp_event: baseTool({ ok: true }) };
    const { host, logs, approvals } = makeHost();
    const tools = buildRunnerTools(lifted, host);
    await tools.calendar_rsvp_event.execute({ status: 'yes' });
    await tools.calendar_rsvp_event.execute({ response: 'maybe' });
    await tools.calendar_rsvp_event.execute({});
    expect(lifted.calendar_rsvp_event.execute).not.toHaveBeenCalled();
    expect(approvals.map((entry) => [entry.kind, entry.title])).toEqual([
      ['calendar_rsvp', 'Answer the invite: yes'],
      ['calendar_rsvp', 'Answer the invite: maybe'],
      ['calendar_rsvp', 'Answer the invite: reply'],
    ]);
    expect(logs).toEqual([
      'Prepared your answer to the invite.',
      'Prepared your answer to the invite.',
      'Prepared your answer to the invite.',
    ]);
  });

  test('step_note adds a log line', async () => {
    const { host, logs } = makeHost();
    const tools = buildRunnerTools({}, host);
    expect(await tools.step_note.execute({ line: 'Found the dispute form.' })).toEqual({ ok: true });
    expect(logs).toEqual(['Found the dispute form.']);
  });

  test('step_handoff checks its input, finishes once, and refuses a second call', async () => {
    const { host, finish } = makeHost();
    const tools = buildRunnerTools({}, host);
    const missingNext = await tools.step_handoff.execute({ outcome: 'ready_for_you', summary: 'Wrote it.' });
    expect(missingNext).toEqual({
      ok: false,
      message: 'next is required unless the outcome is done. Call step_handoff again.',
    });
    const missingQuestion = await tools.step_handoff.execute({
      outcome: 'needs_answer',
      summary: 'I need a fact.',
      next: { kind: 'answer', label: 'Answer', detail: 'Pick one.' },
    });
    expect(missingQuestion).toEqual({
      ok: false,
      message: 'question is required for needs_answer. Call step_handoff again.',
    });
    expect(finish).not.toHaveBeenCalled();

    const done = { outcome: 'done', summary: 'Filed it.', evidence: 'Case 42.' };
    expect(await tools.step_handoff.execute(done)).toEqual({ ok: true });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(done);
    expect(await tools.step_handoff.execute(done)).toEqual({ ok: false, message: 'The run already ended.' });
    expect(finish).toHaveBeenCalledTimes(1);
  });

  test('step_handoff accepts needs_answer with a question', async () => {
    const { host, finish } = makeHost();
    const tools = buildRunnerTools({}, host);
    const input = {
      outcome: 'needs_answer',
      summary: 'I need the date.',
      next: { kind: 'answer', label: 'Pick a date', detail: 'Pick one.' },
      question: { prompt: 'Which date?', options: [{ id: 'a', label: 'Monday' }] },
    };
    expect(await tools.step_handoff.execute(input)).toEqual({ ok: true });
    expect(finish).toHaveBeenCalledWith(input);
  });

  test('browser tools are absent when the browser is not available', () => {
    const { host } = makeHost({ browserAvailable: false });
    const tools = buildRunnerTools({}, host);
    expect(Object.keys(tools).some((name) => name.startsWith('browser_'))).toBe(false);
  });

  test('browser tools are present when the browser is available', () => {
    const { host } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    expect(
      Object.keys(tools)
        .filter((name) => name.startsWith('browser_'))
        .sort(),
    ).toEqual([
      'browser_back',
      'browser_click',
      'browser_open',
      'browser_press',
      'browser_select',
      'browser_snapshot',
      'browser_type',
      'browser_wait',
    ]);
  });

  test('browser_open returns the page view, sets the status, and logs the host', async () => {
    const { host, statuses, logs } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    const result = await tools.browser_open.execute({ url: 'https://www.bank.example/dispute' });
    expect(result).toEqual({
      ok: true,
      url: 'https://www.bank.example/dispute',
      title: 'Dispute',
      snapshot: SNAPSHOT.replace(' [cursor=pointer]', ''),
    });
    expect(statuses).toEqual(['Opening bank.example']);
    expect(logs).toEqual(['Opened bank.example.']);
  });

  test('browser_open with a refused URL fails and logs nothing', async () => {
    const { host, logs } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    expect(await tools.browser_open.execute({ url: 'file:///etc/passwd' })).toEqual({
      ok: false,
      message: 'Only public http and https pages can be opened.',
    });
    expect(logs).toEqual([]);
  });

  test('browser_open logs the requested URL when the page has none', async () => {
    const page = { ...fakePage(), url: () => '' };
    const { host, logs } = makeHost({ browserAvailable: true }, page);
    const tools = buildRunnerTools({}, host);
    await tools.browser_open.execute({ url: 'https://county.example/form' });
    expect(logs).toEqual(['Opened county.example.']);
  });

  test('browser_click returns the page and uses why as the status', async () => {
    const { host, statuses } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    await tools.browser_snapshot.execute({});
    expect((await tools.browser_click.execute({ ref: 'e4', why: 'Opening the dispute form' })).ok).toBe(true);
    expect((await tools.browser_click.execute({ ref: 'e4' })).ok).toBe(true);
    expect(statuses).toEqual(['Reading the page', 'Opening the dispute form', 'Working on the page']);
  });

  test('a page rule becomes a needs_user result', async () => {
    const { host } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    await tools.browser_snapshot.execute({});
    const click = await tools.browser_click.execute({ ref: 'e5' });
    expect(click).toMatchObject({ ok: false, status: 'needs_user', reason: 'final_action' });
    expect(click.message).toContain('"Submit dispute" commits the user.');
    const type = await tools.browser_type.execute({ ref: 'e2', text: 'hunter2' });
    expect(type).toMatchObject({ ok: false, status: 'needs_user', reason: 'secret' });
    const submit = await tools.browser_type.execute({ ref: 'e1', text: 'me@example.com', submit: true });
    expect(submit).toMatchObject({ ok: false, status: 'needs_user', reason: 'submit' });
  });

  test('other page errors become a short failure message', async () => {
    const { host } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    const unknownRef = await tools.browser_click.execute({ ref: 'e4' });
    expect(unknownRef).toEqual({
      ok: false,
      message: 'Ref e4 is not in the latest snapshot. Call browser_snapshot first.',
    });
    expect(await tools.browser_press.execute({ key: 'Enter' })).toMatchObject({ ok: false });
  });

  test('a failed browser start never sets a status', async () => {
    const statuses: string[] = [];
    const { host } = makeHost({
      browserAvailable: true,
      browser: async () => {
        throw new Error(`Browserbase is down ${'x'.repeat(400)}`);
      },
      browserStatus: async (detail) => {
        statuses.push(detail);
      },
    });
    const tools = buildRunnerTools({}, host);
    const result = await tools.browser_back.execute({});
    expect(result.ok).toBe(false);
    expect(result.message).toHaveLength(300);
    expect(statuses).toEqual([]);
  });

  test('a thrown value that is not an Error gets the fixed message', async () => {
    const { host } = makeHost({
      browserAvailable: true,
      browser: async () => {
        throw 'boom';
      },
    });
    const tools = buildRunnerTools({}, host);
    expect(await tools.browser_wait.execute({ seconds: 2 })).toEqual({
      ok: false,
      message: 'The page action failed.',
    });
  });

  test('type, select, press, back, and wait run on the page with their statuses', async () => {
    const { host, statuses } = makeHost({ browserAvailable: true });
    const tools = buildRunnerTools({}, host);
    await tools.browser_snapshot.execute({ find: 'email' });
    expect((await tools.browser_type.execute({ ref: 'e1', text: 'me@example.com' })).ok).toBe(true);
    expect((await tools.browser_select.execute({ ref: 'e3', values: ['Double charge'] })).ok).toBe(true);
    expect((await tools.browser_press.execute({ key: 'Tab' })).ok).toBe(true);
    expect((await tools.browser_back.execute({})).ok).toBe(true);
    expect((await tools.browser_wait.execute({ seconds: 2 })).ok).toBe(true);
    expect(statuses).toEqual([
      'Reading the page',
      'Filling in the form',
      'Choosing an option',
      'Working on the page',
      'Going back',
      'Waiting for the page',
    ]);
  });

  test('browser_snapshot passes find and marks a cut snapshot', async () => {
    const long = Array.from({ length: 1_000 }, (_, index) => `- link "Item ${index}" [ref=e${index}]`).join(
      '\n',
    );
    const { host } = makeHost({ browserAvailable: true }, fakePage(long));
    const tools = buildRunnerTools({}, host);
    const full = await tools.browser_snapshot.execute({});
    expect(full.truncated).toBe(true);
    const found = await tools.browser_snapshot.execute({ find: '999' });
    expect(found.truncated).toBeUndefined();
    expect(found.snapshot).toContain('[ref=e999]');
  });
});
