import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'lab86-mail-test-'));
process.env.LAB86_MAIL_DATA_DIR = dataDir;
process.env.MAIL_OS_DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

describe('agent mail lookup and prompt contract', () => {
  test('Nylas structured search does not send raw Gmail native syntax', async () => {
    const { buildNylasStructuredSearchQueryParams } = await import('../lib/nylas/provider');
    const params = buildNylasStructuredSearchQueryParams({
      query: 'in:inbox is:unread has:attachment newer_than:30d',
      max: 50,
      pageToken: 'next-page',
    });

    expect(params).toEqual({
      limit: 50,
      in: 'INBOX',
      unread: true,
      has_attachment: true,
      latest_message_after: expect.any(String),
      page_token: 'next-page',
    });
    expect(params).not.toHaveProperty('search_query_native');
  });

  test('structured compiler reports unsupported clauses explicitly', async () => {
    const { compileQueryToNylasStructuredParams } = await import('../lib/mail/search/compiler');
    const plan = compileQueryToNylasStructuredParams({
      provider: 'microsoft',
      query: 'from:alerts@example.test -in:trash urgent',
      max: 10,
    });

    expect(plan.queryParams).toMatchObject({
      limit: 10,
      from: 'alerts@example.test',
    });
    expect(plan.dropped.map((item: any) => item.reason)).toContain(
      'structured search does not support negation yet',
    );
    expect(plan.dropped.map((item: any) => item.reason)).toContain(
      'structured search does not support free-text body search yet',
    );
  });

  test('search_threads fails clearly when no hosted account is available', async () => {
    const { searchThreads } = await import('../lib/tools/mail');
    await expect(
      searchThreads.handler(
        {
          account: 'jakob@example.test',
          query: 'from:noreply@example.test newer_than:30d',
          max: 5,
        },
        { agent: 'codex' },
      ),
    ).rejects.toThrow('Sign in required for hosted mail access.');
  });

  test('system prompt directs named reply requests through search, not the focused thread', async () => {
    const { SYSTEM_PROMPT } = await import('../lib/ai/system-prompt');

    expect(SYSTEM_PROMPT).toContain('reply to this/open/current thread');
    expect(SYSTEM_PROMPT).toContain('search mail even if another thread is currently focused');
    expect(SYSTEM_PROMPT).toContain('Do not require the user to open the thread first');
  });
});

describe('provider capabilities', () => {
  test('iCloud is hidden by default and connectable only when explicitly ready', async () => {
    const previousMode = process.env.LAB86_MAIL_ICLOUD_MODE;
    const previousReady = process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
    const { mailProviderCapability } = await import('../lib/mail/provider-capabilities');

    delete process.env.LAB86_MAIL_ICLOUD_MODE;
    delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
    expect(mailProviderCapability('icloud')).toMatchObject({
      visible: false,
      connectable: false,
    });

    process.env.LAB86_MAIL_ICLOUD_MODE = 'beta';
    process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = '1';
    expect(mailProviderCapability('icloud')).toMatchObject({
      visible: true,
      connectable: true,
      searchable: true,
    });

    if (previousMode === undefined) delete process.env.LAB86_MAIL_ICLOUD_MODE;
    else process.env.LAB86_MAIL_ICLOUD_MODE = previousMode;
    if (previousReady === undefined) delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
    else process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = previousReady;
  });
});

describe('hosted OpenRouter model options', () => {
  test('normalizes arbitrary OpenRouter model slugs to approved choices', async () => {
    const {
      OPENROUTER_DEFAULT_FAST_MODEL,
      OPENROUTER_DEFAULT_PRIMARY_MODEL,
      isOpenRouterFastModel,
      isOpenRouterPrimaryModel,
      normalizeOpenRouterFastModel,
      normalizeOpenRouterPrimaryModel,
      resolveLab86Family,
    } = await import('../lib/ai/model-options');

    expect(isOpenRouterPrimaryModel('openai/gpt-5.5')).toBe(true);
    expect(isOpenRouterFastModel('openai/gpt-5.4-mini')).toBe(true);
    expect(normalizeOpenRouterPrimaryModel('some-provider/unreviewed-model')).toBe(
      OPENROUTER_DEFAULT_PRIMARY_MODEL,
    );
    expect(normalizeOpenRouterFastModel('some-provider/unreviewed-fast-model')).toBe(
      OPENROUTER_DEFAULT_FAST_MODEL,
    );
    expect(resolveLab86Family('openai/gpt-5.5', 'anthropic/claude-haiku-4.5')).toBe('openai');
    expect(resolveLab86Family(undefined, 'anthropic/claude-haiku-4.5')).toBe('claude');
  });
});

describe('AI tools on fake noreply mail with no provider configured', () => {
  test('local fallback paths stay available for all agent-facing AI helpers', async () => {
    const { upsertMessage } = await import('../lib/store/messages');
    const {
      bulkTriage,
      classifyThreads,
      draftReply,
      extractActionItems,
      nlSearch,
      preSendCritique,
      summarizeThread,
      translateThread,
      triageThread,
    } = await import('../lib/tools/ai');

    const account = 'jakob@example.test';
    const threadId = 'thread-noreply-ai';
    await upsertMessage({
      _id: 'msg-noreply-ai',
      threadId,
      account,
      subject: 'Automated account notice',
      from: 'No Reply <noreply@example.test>',
      to: 'Jakob <jakob@example.test>',
      cc: '',
      bcc: '',
      date: Date.parse('2026-06-03T12:00:00.000Z'),
      snippet: 'Your fake account notice is ready.',
      textBody: 'Your fake account notice is ready. No response is needed.',
      htmlBody: '',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      attachments: [],
      headers: {},
      cachedAt: Date.now(),
    });

    const summary = await summarizeThread.handler({ account, threadId }, { agent: 'codex' });
    expect(summary.model).toBe('local');
    expect(summary.summary).toContain('Automated account notice');

    const triage = await triageThread.handler({ account, threadId }, { agent: 'codex' });
    expect(triage.model).toBe('local');
    expect(triage.action).toBe('read');

    const draft = await draftReply.handler(
      {
        account,
        threadId,
        instructions: 'politely confirm no action is needed',
        tone: 'direct',
      },
      { agent: 'codex' },
    );
    expect(draft.model).toBe('local');
    expect(draft.draft).toContain('no action is needed');

    const batch = await bulkTriage.handler(
      {
        items: [
          {
            id: threadId,
            from: 'noreply@example.test',
            subject: 'Automated account notice',
            snippet: 'No response is needed.',
          },
        ],
      },
      { agent: 'codex' },
    );
    expect(batch.model).toBe('local');
    expect(batch.verdicts[0].id).toBe(threadId);

    const classified = await classifyThreads.handler(
      {
        threads: [
          {
            id: threadId,
            account,
            from: 'noreply@example.test',
            subject: 'Automated account notice',
            snippet: 'No response is needed.',
            labels: ['CATEGORY_UPDATES'],
            unread: true,
          },
        ],
      },
      { agent: 'codex' },
    );
    expect(classified.model).toBe('local');
    expect(classified.verdicts[0].id).toBe(threadId);

    const actions = await extractActionItems.handler({ account, threadId }, { agent: 'codex' });
    expect(actions.model).toBe('local');
    expect(actions.items).toEqual([]);

    const translation = await translateThread.handler(
      { account, threadId, language: 'english' },
      { agent: 'codex' },
    );
    expect(translation.model).toBe('none');
    expect(translation.translation).toBe('');

    const critique = await preSendCritique.handler(
      { draftBody: 'thanks, no action needed.', threadContext: 'fake noreply notice' },
      { agent: 'codex' },
    );
    expect(critique.model).toBe('local');
    expect(critique.verdict).toBe('ok');

    const search = await nlSearch.handler(
      { description: 'from noreply@example.test newer than 30 days' },
      { agent: 'codex' },
    );
    expect(search.model).toBe('local');
    expect(search.query).toBe('from noreply@example.test newer than 30 days');
  });
});
