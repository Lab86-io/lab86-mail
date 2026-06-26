import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  bulkTriage,
  classifyThreads,
  classifyThreadsBatched,
  draftReply,
  extractActionItems,
  nlSearch,
  preSendCritique,
  summarizeThread,
  translateThread,
  triageThread,
} from '../lib/tools/ai';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

describe('AI model tools — local fallbacks', () => {
  test('summarize_thread uses local heuristics without provider keys', async () => {
    const { account, threadId } = await seedThreadMessage({
      subject: 'Project update',
      from: 'Alex <alex@example.test>',
      textBody: 'The launch checklist is ready for review.',
    });
    const summary = await runTool(summarizeThread.handler, { account, threadId });
    expect(summary.model).toBe('local');
    expect(summary.summary).toContain('Project update');
  });

  test('summarize_thread returns none for empty threads', async () => {
    const result = await runTool(summarizeThread.handler, {
      account: 'jakob@example.test',
      threadId: 'missing-thread',
    });
    expect(result).toEqual({ summary: '(empty thread)', model: 'none' });
  });

  test('triage_thread heuristics mark unread mail as normal priority', async () => {
    const { account, threadId } = await seedThreadMessage({ unread: true });
    const triage = await runTool(triageThread.handler, { account, threadId });
    expect(triage.model).toBe('local');
    expect(triage.priority).toBe(2);
    expect(triage.action).toBe('read');
  });

  test('draft_reply includes instructions and local signoff', async () => {
    const { account, threadId } = await seedThreadMessage({
      from: 'Alex <alex@example.test>',
      textBody: 'Can you confirm the timeline?',
    });
    const draft = await runTool(draftReply.handler, {
      account,
      threadId,
      instructions: 'confirm Friday works',
      tone: 'direct',
    });
    expect(draft.model).toBe('local');
    expect(draft.draft).toContain('Friday works');
  });

  test('bulk_triage returns defaults for every item', async () => {
    const batch = await runTool(bulkTriage.handler, {
      items: [
        { id: 't1', from: 'a@example.test', subject: 'One', snippet: 'alpha' },
        { id: 't2', from: 'b@example.test', subject: 'Two', snippet: 'beta' },
      ],
    });
    expect(batch.model).toBe('local');
    expect(batch.verdicts).toHaveLength(2);
    expect(batch.verdicts.every((verdict) => verdict.priority === 2)).toBe(true);
  });

  test('classify_threads deterministically labels noreply mail', async () => {
    const classified = await runTool(classifyThreads.handler, {
      threads: [
        {
          id: 'thread_noreply',
          account: 'jakob@example.test',
          from: 'noreply@example.test',
          subject: 'Automated account notice',
          snippet: 'No response needed.',
          labels: ['CATEGORY_UPDATES'],
          unread: true,
        },
      ],
    });
    expect(classified.model).toMatch(/local|deterministic/);
    expect(classified.verdicts[0]?.id).toBe('thread_noreply');
    expect(classified.verdicts[0]?.isAutomated).toBe(true);
  });

  test('classifyThreadsBatched folds needs_reply into main', async () => {
    const verdicts = await withToolContext(() =>
      classifyThreadsBatched(
        [
          {
            id: 'human',
            from: 'Alex <alex@example.test>',
            subject: 'Can we meet tomorrow?',
            snippet: 'Are you free at 2pm?',
            labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
            unread: true,
          },
        ],
        { rules: [], customLabels: [] },
      ),
    );
    expect(verdicts[0]?.primary).toBe('main');
  });

  test('extract_action_items returns empty without AI', async () => {
    const { account, threadId } = await seedThreadMessage({ textBody: 'Nothing actionable here.' });
    const actions = await runTool(extractActionItems.handler, { account, threadId });
    expect(actions.model).toBe('local');
    expect(actions.items).toEqual([]);
  });

  test('translate_thread returns empty translation without AI', async () => {
    const { account, threadId } = await seedThreadMessage({ textBody: 'Bonjour' });
    const translation = await runTool(translateThread.handler, { account, threadId, language: 'english' });
    expect(translation.model).toBe('none');
    expect(translation.translation).toBe('');
  });

  test('pre_send_critique approves drafts locally', async () => {
    const critique = await runTool(preSendCritique.handler, {
      draftBody: 'Thanks, all set.',
      threadContext: 'closing loop',
    });
    expect(critique.model).toBe('local');
    expect(critique.verdict).toBe('ok');
  });

  test('nl_search converts natural language locally', async () => {
    const search = await runTool(nlSearch.handler, {
      description: 'from noreply@example.test newer than 30 days',
    });
    expect(search.model).toBe('local');
    expect(search.query).toBe('from noreply@example.test newer than 30 days');
  });
});
