import { describe, expect, test } from 'bun:test';
import {
  checklistFromSteps,
  cleanGoalUpdate,
  earlierRunArtifacts,
  GOAL_PROOFS_MAX,
  goalAutoVerdict,
  goalContractFor,
  goalContractKind,
  goalOutcomeText,
  goalRequirement,
  goalUpdateInputSchema,
  handoffItemsFromArtifacts,
  isAppPath,
  isGoalRun,
  isUserDidPartNote,
  mergeGoalContract,
  redactRunText,
  resolveHandoffItems,
  runOpenPath,
  seedChecklist,
  sourcesFromToolResult,
  userDidPartNote,
  withOpenPath,
} from '../lib/albatross/goal-runs';
import {
  DEFAULT_GOAL_RUN_COST_BUDGET_USD,
  DEFAULT_GOAL_RUN_TIME_BUDGET_MS,
  GOAL_RUN_MAX_MODEL_STEPS,
  goalRunLimits,
  stepRunLimits,
} from '../lib/albatross/step-run-policy';
import type { RunArtifact } from '../lib/albatross/step-run-tools';
import { savedFileOpenPath } from '../lib/files/saved-files';

// The pure rules of goal runs (docs/albatross-goal-runs.md). Invented data only.

describe('goal run identity and limits', () => {
  test('a run is a goal run by its flag or its step key', () => {
    expect(isGoalRun({ goal: true, stepKey: 'step-1' })).toBe(true);
    expect(isGoalRun({ stepKey: 'goal' })).toBe(true);
    expect(isGoalRun({ goal: false, stepKey: 'step-1' })).toBe(false);
    expect(isGoalRun(null)).toBe(false);
  });

  test('goal runs get 30 minutes, $8, and 120 model steps, each with its own override', () => {
    expect(goalRunLimits({})).toEqual({
      timeBudgetMs: DEFAULT_GOAL_RUN_TIME_BUDGET_MS,
      costBudgetUsd: DEFAULT_GOAL_RUN_COST_BUDGET_USD,
      maxModelSteps: GOAL_RUN_MAX_MODEL_STEPS,
    });
    expect(DEFAULT_GOAL_RUN_TIME_BUDGET_MS).toBe(30 * 60_000);
    expect(DEFAULT_GOAL_RUN_COST_BUDGET_USD).toBe(8);
    expect(GOAL_RUN_MAX_MODEL_STEPS).toBe(120);
    expect(
      goalRunLimits({
        LAB86_GOAL_RUN_TIME_BUDGET_MS: '60000',
        LAB86_GOAL_RUN_COST_BUDGET_USD: '2.5',
        LAB86_GOAL_RUN_MAX_MODEL_STEPS: '40.7',
      }),
    ).toEqual({ timeBudgetMs: 60_000, costBudgetUsd: 2.5, maxModelSteps: 40 });
    // The step-run overrides never change a goal run, and the reverse.
    expect(goalRunLimits({ LAB86_STEP_RUN_TIME_BUDGET_MS: '1000' }).timeBudgetMs).toBe(
      DEFAULT_GOAL_RUN_TIME_BUDGET_MS,
    );
    expect(stepRunLimits({ LAB86_GOAL_RUN_TIME_BUDGET_MS: '1000' }).timeBudgetMs).toBe(15 * 60_000);
    expect(goalRunLimits({ LAB86_GOAL_RUN_MAX_MODEL_STEPS: 'many' }).maxModelSteps).toBe(120);
  });
});

describe('the first contract', () => {
  test('the kind comes from the words of the goal', () => {
    expect(goalContractKind('Send the July invoice to the client')).toBe('send');
    expect(goalContractKind('Buy a new desk chair')).toBe('buy');
    expect(goalContractKind('Book the dentist appointment')).toBe('book');
    expect(goalContractKind('Learn the basics of tax forms')).toBe('general');
  });

  test('the outcome is the title, else the request, and never empty', () => {
    expect(goalOutcomeText({ title: '  July   invoice ', rawText: 'x' })).toBe('July invoice');
    expect(goalOutcomeText({ title: '', rawText: 'Send the invoice' })).toBe('Send the invoice');
    expect(goalOutcomeText({})).toBe('The goal is done.');
    const contract = goalContractFor({ title: 'July invoice', rawText: 'Email the July invoice to billing' });
    expect(contract.outcome).toBe('July invoice');
    expect(contract.proofs.map((proof) => proof.what)).toEqual([
      'The message left your account',
      'The person acknowledged it',
    ]);
    expect(contract.closeWhen).toBe('outcome_likely');
  });
});

describe('the checklist', () => {
  const steps = [
    { title: 'Find the July hours', done: true },
    { title: 'Write the invoice', done: false, stepMode: 'agent_does' },
    { title: 'Sign the W-9', done: false, stepMode: 'you_do_offline' },
    { title: '   ', done: false },
  ];

  test('old open steps become the first checklist; done steps stay out', () => {
    expect(checklistFromSteps(steps)).toEqual([
      { id: 'c1', text: 'Write the invoice', state: 'todo' },
      { id: 'c2', text: 'Sign the W-9', state: 'yours' },
    ]);
    expect(checklistFromSteps(undefined)).toEqual([]);
  });

  test('a new run starts from the newest earlier list, else from the steps', () => {
    const runs = [
      { checklist: [{ text: 'Old list', state: 'done' }] },
      { checklist: [{ text: 'Newest list', state: 'doing' }] },
      { checklist: [] },
      {},
    ];
    expect(seedChecklist({ runs, steps })).toEqual([{ id: 'c1', text: 'Newest list', state: 'doing' }]);
    expect(seedChecklist({ runs: [{}], steps })).toHaveLength(2);
    expect(seedChecklist({ runs: null, steps: [] })).toEqual([]);
  });
});

describe('automatic starts', () => {
  test('only a Work with no run, or a run that stopped at its limit', () => {
    expect(goalAutoVerdict({ runs: [], pendingQuestions: 0 })).toEqual({ start: true, continueFrom: null });
    expect(
      goalAutoVerdict({ runs: [{ id: 'r1', state: 'handed_off', stoppedBy: 'time' }], pendingQuestions: 0 }),
    ).toEqual({ start: true, continueFrom: 'r1' });
  });

  test('never while a run works, a handoff waits, or a question is open', () => {
    expect(goalAutoVerdict({ runs: [{ id: 'r1', state: 'running' }], pendingQuestions: 0 })).toEqual({
      start: false,
      reason: 'active',
    });
    expect(goalAutoVerdict({ runs: [{ id: 'r1', state: 'handed_off' }], pendingQuestions: 0 })).toEqual({
      start: false,
      reason: 'waiting',
    });
    expect(goalAutoVerdict({ runs: [], pendingQuestions: 1 })).toEqual({ start: false, reason: 'waiting' });
    expect(
      goalAutoVerdict({ runs: [{ id: 'r1', state: 'handed_off', stoppedBy: 'cost' }], pendingQuestions: 2 }),
    ).toEqual({ start: false, reason: 'waiting' });
    for (const state of ['done', 'failed', 'cancelled', 'closed'])
      expect(goalAutoVerdict({ runs: [{ id: 'r1', state }], pendingQuestions: 0 })).toEqual({
        start: false,
        reason: 'ran',
      });
  });
});

describe('goal_update', () => {
  test('the model schema has no pattern and bounds each field', () => {
    expect(JSON.stringify(goalUpdateInputSchema.toJSONSchema?.() ?? {})).not.toContain('pattern');
    expect(goalUpdateInputSchema.safeParse({ outcome: 'The client has the invoice' }).success).toBe(true);
    expect(goalUpdateInputSchema.safeParse({ proofs: [] }).success).toBe(false);
    expect(
      goalUpdateInputSchema.safeParse({ proofs: Array.from({ length: GOAL_PROOFS_MAX + 1 }, () => 'p') })
        .success,
    ).toBe(false);
    expect(goalUpdateInputSchema.safeParse({ outcome: 'x'.repeat(601) }).success).toBe(false);
  });

  test('a clean update trims, removes repeats, and is null when it changes nothing', () => {
    expect(cleanGoalUpdate({ outcome: '  The   client has it ', proofs: ['A', ' a ', 'B', ''] })).toEqual({
      outcome: 'The client has it',
      proofs: ['A', 'B'],
    });
    expect(cleanGoalUpdate({ outcome: ' ', proofs: [] })).toBeNull();
    expect(cleanGoalUpdate(null)).toBeNull();
    expect(cleanGoalUpdate({ proofs: ['Proof'] })).toEqual({ proofs: ['Proof'] });
  });

  test('a merged contract keeps settled proofs by their words, the close rule, and contradictions', () => {
    const previous = {
      outcome: 'Old outcome',
      proofs: [
        { id: 'send-0', what: 'The message left your account', satisfiedAt: 5, satisfiedBy: 'Sent mail' },
        { id: 'send-1', what: 'The person acknowledged it', satisfiedBy: null },
      ],
      closeWhen: 'outcome_likely' as const,
      contradictions: ['The message bounced'],
    };
    const merged = mergeGoalContract(
      previous,
      { outcome: 'The client has the invoice', proofs: ['the message left your account', 'A reply came'] },
      { title: 'x' },
      100,
    );
    expect(merged).toEqual({
      outcome: 'The client has the invoice',
      proofs: [
        { id: 'send-0', what: 'the message left your account', satisfiedAt: 5, satisfiedBy: 'Sent mail' },
        { id: 'goal-2', what: 'A reply came' },
      ],
      closeWhen: 'outcome_likely',
      contradictions: ['The message bounced'],
      updatedAt: 100,
    });
    // Only the outcome: the proofs stay, without null fields.
    const outcomeOnly = mergeGoalContract(previous, { outcome: 'New' }, { title: 'x' }, 7);
    expect(outcomeOnly.proofs[1]).toEqual({ id: 'send-1', what: 'The person acknowledged it' });
    // No contract yet: the first contract of the Work is the base.
    const fresh = mergeGoalContract(null, { proofs: ['One', 'Two', 'Three'] }, { title: 'Learn tax' }, 9);
    expect(fresh.outcome).toBe('Learn tax');
    expect(fresh.closeWhen).toBe('outcome_confirmed');
    expect(fresh.proofs.map((proof) => proof.id)).toEqual(['goal-1', 'goal-2', 'goal-3']);
    expect(fresh).not.toHaveProperty('contradictions');
  });

  test('two proofs that match one id keep unique ids', () => {
    const merged = mergeGoalContract(
      {
        outcome: 'x',
        proofs: [{ id: 'goal-2', what: 'Second' }],
        closeWhen: 'outcome_confirmed',
      },
      { proofs: ['New first', 'New second', 'Second'] },
      {},
      1,
    );
    expect(merged.proofs.map((proof) => proof.id)).toEqual(['goal-1', 'goal-2', 'goal-3-2']);
  });

  test('the done requirement is the outcome and the proofs still open', () => {
    expect(
      goalRequirement(
        {
          outcome: 'The client has the invoice',
          proofs: [
            { id: 'a', what: 'Sent', satisfiedAt: 1 },
            { id: 'b', what: 'Replied' },
          ],
          closeWhen: 'outcome_likely',
        },
        'Invoice',
      ),
    ).toBe('The client has the invoice\nWhat proves it:\n- Replied');
    expect(goalRequirement(null, 'Invoice')).toBe('"Invoice" is done.');
  });
});

describe('sources from tool results', () => {
  test('web reads, research, and saved files are web sources', () => {
    expect(
      sourcesFromToolResult('browserbase_fetch', { url: 'https://www.irs.gov/forms' }, { content: 'x' }),
    ).toEqual([{ kind: 'web', title: 'irs.gov', url: 'https://www.irs.gov/forms' }]);
    expect(
      sourcesFromToolResult(
        'web_research',
        { question: 'q' },
        {
          ok: true,
          sources: [
            { n: 1, title: 'Form W-9', url: 'https://www.irs.gov/w9', passage: 'Request for taxpayer id' },
            { n: 2, title: 'No passage', url: 'https://example.com/a', passage: '' },
            { n: 3, title: '', url: 'https://docs.example.com/b', passage: 'text' },
          ],
          failed: [],
        },
      ),
    ).toEqual([
      { kind: 'web', title: 'Form W-9', url: 'https://www.irs.gov/w9' },
      { kind: 'web', title: 'docs.example.com', url: 'https://docs.example.com/b' },
    ]);
    for (const name of ['web_file_save', 'pdf_form_fill'])
      expect(
        sourcesFromToolResult(
          name,
          {},
          { ok: true, fileId: 'f1', title: 'fw9.pdf', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' },
        ),
      ).toEqual([{ kind: 'web', title: 'fw9.pdf', url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf' }]);
    expect(sourcesFromToolResult('pdf_form_fill', {}, { ok: true, fileId: 'f2', title: 'x' })).toEqual([]);
  });

  test('mail threads and messages are mail sources with the sender and the account', () => {
    expect(
      sourcesFromToolResult(
        'read_thread',
        { account: 'acct-1', threadId: 't1' },
        {
          account: 'acct-1',
          threadId: 't1',
          subject: 'July hours',
          messages: [{ from: 'lead@example.com', body: '78 hours' }],
        },
      ),
    ).toEqual([{ kind: 'mail', title: 'July hours (lead@example.com)', id: 't1', accountId: 'acct-1' }]);
    expect(
      sourcesFromToolResult(
        'get_thread',
        { account: 'acct-1', threadId: 't2' },
        { subject: '', messages: [{ from: [{ email: 'a@example.com' }] }] },
      ),
    ).toEqual([{ kind: 'mail', title: '(no subject) (a@example.com)', id: 't2', accountId: 'acct-1' }]);
    expect(
      sourcesFromToolResult(
        'get_message',
        { account: 'acct-2', id: 'm1' },
        { threadId: 't3', subject: 'Rate', from: [{ email: 'b@example.com' }] },
      ),
    ).toEqual([{ kind: 'mail', title: 'Rate (b@example.com)', id: 't3', accountId: 'acct-2' }]);
    expect(sourcesFromToolResult('get_message', {}, { subject: 'x' })).toEqual([]);
    expect(sourcesFromToolResult('read_thread', {}, { subject: 'x' })).toEqual([]);
  });

  test('Jira issues, search hits, files, and events', () => {
    expect(
      sourcesFromToolResult(
        'jira_read_issue',
        { key: 'ABC-1' },
        {
          ok: true,
          issue: { key: 'ABC-1', title: 'Build the report', url: 'https://x.example/browse/ABC-1' },
        },
      ),
    ).toEqual([
      { kind: 'jira', title: 'ABC-1 Build the report', url: 'https://x.example/browse/ABC-1', id: 'ABC-1' },
    ]);
    expect(sourcesFromToolResult('jira_read_issue', {}, { ok: true, issue: {} })).toEqual([]);
    const hits = sourcesFromToolResult(
      'atlassian_search',
      { query: 'report' },
      {
        items: [
          { kind: 'issue', key: 'ABC-2', title: 'One', url: 'https://x.example/browse/ABC-2' },
          { kind: 'page', key: null, title: 'Runbook', url: 'https://x.example/wiki/1' },
          { kind: 'issue', key: null, title: 'No link', url: null },
          { kind: 'issue', key: 'ABC-4', title: 'Four', url: 'https://x.example/browse/ABC-4' },
        ],
      },
    );
    expect(hits).toEqual([
      { kind: 'jira', title: 'ABC-2 One', url: 'https://x.example/browse/ABC-2', id: 'ABC-2' },
      { kind: 'document', title: 'Runbook', url: 'https://x.example/wiki/1' },
    ]);
    expect(
      sourcesFromToolResult(
        'document_get',
        { documentId: 'd1' },
        { document: { documentId: 'd1', title: 'Rates' } },
      ),
    ).toEqual([{ kind: 'file', title: 'Rates', id: 'd1', url: '/?view=files&document=d1' }]);
    expect(
      sourcesFromToolResult(
        'word_document_get',
        { documentId: 'w1' },
        { ok: true, documentId: 'w1', title: 'Invoice 7', openPath: '/?view=files&office=w1' },
      ),
    ).toEqual([{ kind: 'file', title: 'Invoice 7', id: 'w1', url: '/?view=files&office=w1' }]);
    expect(sourcesFromToolResult('google_document_get', { fileId: 'g1' }, { title: 'Budget' })).toEqual([
      { kind: 'file', title: 'Budget', id: 'g1' },
    ]);
    expect(
      sourcesFromToolResult(
        'calendar_event_detail',
        { account: 'acct-1', eventId: 'e1' },
        { event: { title: 'Review' } },
      ),
    ).toEqual([{ kind: 'calendar', title: 'Review', id: 'e1', accountId: 'acct-1' }]);
  });

  test('failed calls, searches without content, and other tools read nothing', () => {
    expect(sourcesFromToolResult('read_thread', {}, { ok: false })).toEqual([]);
    expect(sourcesFromToolResult('read_thread', {}, null)).toEqual([]);
    expect(sourcesFromToolResult('cloud_file_search', {}, { files: [{ id: 'x', name: 'y' }] })).toEqual([]);
    expect(sourcesFromToolResult('browserbase_search', {}, { results: [{ url: 'https://a' }] })).toEqual([]);
    expect(sourcesFromToolResult('document_get', {}, { document: {} })).toEqual([]);
    expect(sourcesFromToolResult('word_document_get', {}, { ok: true })).toEqual([]);
    expect(sourcesFromToolResult('google_document_get', {}, { title: 'x' })).toEqual([]);
    expect(sourcesFromToolResult('calendar_event_detail', {}, { event: {} })).toEqual([]);
    expect(sourcesFromToolResult('web_research', {}, { ok: true })).toEqual([]);
    expect(sourcesFromToolResult('browserbase_fetch', {}, { content: '' })).toEqual([]);
  });
});

describe('the package', () => {
  const artifacts: RunArtifact[] = [
    { kind: 'card', id: 'card-1', title: 'A task' },
    { kind: 'document', id: 'doc-1', title: 'Invoice 7', url: '/?view=files&office=doc-1' },
    { kind: 'draft', id: 'draft-1', title: 'July invoice', accountId: 'acct-1' },
    { kind: 'file', id: 'file-1', title: 'fw9.pdf', url: '/?view=files&file=file-1' },
    { kind: 'event', id: 'evt-1', title: 'Focus block' },
    { kind: 'page', title: 'A page', url: 'https://example.com' },
  ];

  test('with no items from the model, each made thing is an item and the target comes first', () => {
    expect(
      handoffItemsFromArtifacts(artifacts, {
        target: { kind: 'draft', id: 'draft-1' },
        blanks: ['hourly rate'],
      }),
    ).toEqual([
      {
        kind: 'draft',
        title: 'July invoice',
        state: 'blanks',
        id: 'draft-1',
        url: '/?view=mail&account=acct-1&draft=draft-1',
        accountId: 'acct-1',
        blanks: ['hourly rate'],
      },
      { kind: 'document', title: 'Invoice 7', state: 'check', id: 'doc-1', url: '/?view=files&office=doc-1' },
      { kind: 'file', title: 'fw9.pdf', state: 'check', id: 'file-1', url: '/?view=files&file=file-1' },
      {
        kind: 'event',
        title: 'Focus block',
        state: 'ready',
        id: 'evt-1',
        url: '/?view=calendar&event=evt-1',
      },
    ]);
    expect(handoffItemsFromArtifacts([], {})).toEqual([]);
    // A target by link only.
    expect(
      handoffItemsFromArtifacts(artifacts, {
        target: { kind: 'document', url: '/?view=files&file=file-1' },
      })[0].id,
    ).toBe('file-1');
  });

  test("the model's items get the link and account of the thing with the same id", () => {
    const items = resolveHandoffItems(
      [
        { kind: 'document', id: 'doc-1', title: 'Invoice 7', state: 'blanks', blanks: ['hours'], url: '' },
        { kind: 'draft', id: 'draft-9', title: 'Earlier draft', state: 'check' },
        { kind: 'deck', id: 'deck-1', title: 'Plan', state: 'check', url: 'https://evil.example/x' },
        { kind: 'file', title: 'No id', state: 'check' },
        { kind: 'approval', id: 'ap-1', title: 'Send the invite', state: 'check' },
        { kind: 'page', title: 'Portal', state: 'check', url: 'https://portal.example.com/form' },
      ],
      {
        artifacts,
        known: [
          { kind: 'draft', id: 'draft-9', title: 'Earlier draft', accountId: 'acct-2' },
          { kind: 'document', id: 'deck-1', title: 'Plan', url: '/?view=files&document=deck-1' },
        ],
      },
    );
    expect(items).toEqual([
      {
        kind: 'document',
        title: 'Invoice 7',
        state: 'blanks',
        id: 'doc-1',
        url: '/?view=files&office=doc-1',
        blanks: ['hours'],
      },
      {
        kind: 'draft',
        title: 'Earlier draft',
        state: 'check',
        id: 'draft-9',
        url: '/?view=mail&account=acct-2&draft=draft-9',
        accountId: 'acct-2',
      },
      // A link the model made up never stands: the server gives the path.
      { kind: 'deck', title: 'Plan', state: 'check', id: 'deck-1', url: '/?view=files&document=deck-1' },
      { kind: 'file', title: 'No id', state: 'check' },
      {
        kind: 'approval',
        title: 'Send the invite',
        state: 'check',
        id: 'ap-1',
        url: '/?view=notifications&approval=ap-1',
      },
      { kind: 'page', title: 'Portal', state: 'check', url: 'https://portal.example.com/form' },
    ]);
    // No items: built from the artifacts with the next target first.
    expect(
      resolveHandoffItems(undefined, { artifacts, next: { target: { kind: 'document', id: 'doc-1' } } })[0]
        .id,
    ).toBe('doc-1');
    expect(resolveHandoffItems([], { artifacts: [] })).toEqual([]);
  });

  test('earlier artifacts: one entry each, the newest version, this run left out', () => {
    expect(
      earlierRunArtifacts(
        [
          { id: 'r1', artifacts: [{ kind: 'draft', id: 'd1', title: 'Old title' }] },
          { id: 'r2', artifacts: [{ kind: 'draft', id: 'd1', title: 'New title' }] },
          { id: 'r3', artifacts: [{ kind: 'document', id: 'x', title: 'This run' }] },
          { id: 'r4', artifacts: null },
        ],
        'r3',
      ),
    ).toEqual([{ kind: 'draft', id: 'd1', title: 'New title' }]);
    const many = Array.from({ length: 25 }, (_, index) => ({
      kind: 'document' as const,
      id: `d${index}`,
      title: `D${index}`,
    }));
    expect(earlierRunArtifacts([{ id: 'r', artifacts: many }])).toHaveLength(20);
  });
});

describe('open paths', () => {
  test('each kind opens by an app path the server gives', () => {
    expect(runOpenPath('draft', { id: 'd 1', accountId: 'a@example.com' })).toBe(
      '/?view=mail&account=a%40example.com&draft=d%201',
    );
    expect(runOpenPath('draft', { id: 'd1' })).toBe('/?view=mail&draft=d1');
    expect(runOpenPath('draft', {})).toBeUndefined();
    expect(runOpenPath('document', { id: 'w1', url: '/?view=files&office=w1' })).toBe(
      '/?view=files&office=w1',
    );
    expect(runOpenPath('sheet', { id: 's1', url: 'https://docs.example.com/x' })).toBe(
      '/?view=files&document=s1',
    );
    expect(runOpenPath('deck', { id: 'k1' })).toBe('/?view=files&document=k1');
    expect(runOpenPath('document', {})).toBeUndefined();
    expect(runOpenPath('file', { id: 'f1' })).toBe(savedFileOpenPath('f1'));
    expect(runOpenPath('file', { url: '//evil.example/x' })).toBeUndefined();
    expect(runOpenPath('approval', { id: 'ap1' })).toBe('/?view=notifications&approval=ap1');
    expect(runOpenPath('approval', {})).toBe('/?view=notifications');
    expect(runOpenPath('event', { id: 'e1', accountId: 'acct-1' })).toBe(
      '/?view=calendar&account=acct-1&event=e1',
    );
    expect(runOpenPath('event', {})).toBeUndefined();
    expect(runOpenPath('card', { id: 'c1' })).toBe('/?view=tasks&card=c1');
    expect(runOpenPath('card', {})).toBeUndefined();
    expect(runOpenPath('page', { url: 'https://example.com/a' })).toBe('https://example.com/a');
    expect(runOpenPath('page', { url: 'javascript:alert(1)' })).toBeUndefined();
    expect(runOpenPath('other' as any, { id: 'x' })).toBeUndefined();
    expect(isAppPath('/?view=files')).toBe(true);
    expect(isAppPath('//evil.example')).toBe(false);
    expect(isAppPath(null)).toBe(false);
  });

  test('an artifact gets its path; one that has it stays the same object', () => {
    const draft: RunArtifact = { kind: 'draft', id: 'd1', title: 'x', accountId: 'acct-1' };
    expect(withOpenPath(draft).url).toBe('/?view=mail&account=acct-1&draft=d1');
    const doc: RunArtifact = { kind: 'document', id: 'w1', title: 'x', url: '/?view=files&office=w1' };
    expect(withOpenPath(doc)).toBe(doc);
    const page: RunArtifact = { kind: 'page', title: 'x' };
    expect(withOpenPath(page)).toBe(page);
  });
});

describe('the "Done, continue" note', () => {
  test('names the part the user did and marks the note', () => {
    expect(userDidPartNote('Read and send')).toBe('The user did their part: Read and send.');
    expect(userDidPartNote('Sign the W-9.', ' I signed it ')).toBe(
      'The user did their part: Sign the W-9. I signed it',
    );
    expect(userDidPartNote(null)).toBe('The user did their part.');
    expect(isUserDidPartNote(userDidPartNote('x'))).toBe(true);
    expect(isUserDidPartNote('Something else')).toBe(false);
    expect(isUserDidPartNote(undefined)).toBe(false);
  });
});

describe('redaction', () => {
  test('saved values, references, and secret shapes never reach a message', () => {
    const secure = { cleanText: (text: string) => text.replace('Rivera-42', '[secure: ID]') };
    expect(redactRunText('I used Rivera-42 and {{secure:abc.number}} for the form.', secure)).toBe(
      'I used [secure: ID] and [saved value] for the form.',
    );
    expect(redactRunText('The number is 123-45-6789.')).toContain('[removed:');
    expect(redactRunText('Plain text stays.')).toBe('Plain text stays.');
  });
});
