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

describe('Convex mail corpus helpers', () => {
  test('builds capped provider-neutral search text', async () => {
    const { CORPUS_SEARCH_TEXT_MAX_CHARS, buildCorpusSearchText, yearMonthFromTimestamp } = await import(
      '../lib/mail/corpus'
    );
    const text = buildCorpusSearchText({
      subject: 'Invoice',
      from: 'Billing <billing@example.test>',
      to: 'Jakob <jakob@example.test>',
      snippet: 'Payment due',
      labels: ['INBOX', 'FINANCE'],
      textBody: 'x'.repeat(CORPUS_SEARCH_TEXT_MAX_CHARS + 500),
    });

    expect(text).toContain('Invoice');
    expect(text).toContain('billing@example.test');
    expect(text.length).toBe(CORPUS_SEARCH_TEXT_MAX_CHARS);
    expect(yearMonthFromTimestamp(Date.parse('2026-06-10T13:00:00.000Z'))).toBe('2026-06');
  });

  test('extracts Nylas grant and truncated message ids from webhook payloads', async () => {
    const { extractNylasWebhookMetadata } = await import('../lib/mail/corpus');
    const metadata = extractNylasWebhookMetadata({
      id: 'evt_123',
      type: 'message.updated.truncated',
      data: {
        object: {
          id: 'msg_123',
          grant_id: 'grant_123',
          thread_id: 'thread_123',
        },
      },
    });

    expect(metadata).toEqual({
      eventId: 'evt_123',
      type: 'message.updated.truncated',
      grantId: 'grant_123',
      providerMessageId: 'msg_123',
      providerThreadId: 'thread_123',
      truncated: true,
    });
  });
});

describe('local-first mail search routing', () => {
  test('routes iCloud and Microsoft to local only when corpus-ready', async () => {
    const previousProviders = process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
    const previousDisabled = process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS;
    delete process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
    delete process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS;

    const { resolveSearchRoute } = await import('../lib/mail/search/capabilities');

    expect(resolveSearchRoute({ provider: 'icloud', corpusReady: true })).toMatchObject({
      tier: 'local',
      localEnabled: true,
    });
    expect(resolveSearchRoute({ provider: 'microsoft', corpusReady: false })).toMatchObject({
      tier: 'structured',
      localEnabled: true,
      corpusReady: false,
    });
    expect(resolveSearchRoute({ provider: 'google', corpusReady: true })).toMatchObject({
      tier: 'structured',
      localEnabled: false,
    });

    process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS = 'all';
    process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS = 'microsoft';
    expect(resolveSearchRoute({ provider: 'google', corpusReady: true })).toMatchObject({
      tier: 'local',
      localEnabled: true,
    });
    expect(resolveSearchRoute({ provider: 'microsoft', corpusReady: true })).toMatchObject({
      tier: 'structured',
      localEnabled: false,
    });

    if (previousProviders === undefined) delete process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
    else process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS = previousProviders;
    if (previousDisabled === undefined) delete process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS;
    else process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS = previousDisabled;
  });

  test('filters local corpus messages with the search AST and groups threads newest-first', async () => {
    const { parseMailSearchQuery } = await import('../lib/mail/search/parser');
    const { compileAstToLocalCorpusQuery, corpusMessagesToThreads, filterCorpusMessagesByAst } = await import(
      '../lib/mail/search/local'
    );
    const ast = parseMailSearchQuery('in:inbox is:unread from:alerts@example.test newer_than:30d invoice');
    const plan = compileAstToLocalCorpusQuery(ast);
    const now = Date.parse('2026-06-10T12:00:00.000Z');
    const messages = [
      {
        accountId: 'grant_microsoft',
        provider: 'microsoft' as const,
        providerMessageId: 'msg_match',
        providerThreadId: 'thread_match',
        subject: 'Invoice due',
        from: 'Alerts <alerts@example.test>',
        to: 'Jakob <jakob@example.test>',
        receivedAt: now,
        snippet: 'Invoice needs review',
        searchText: 'Invoice due Alerts invoice review',
        labels: ['INBOX', 'UNREAD'],
        unread: true,
      },
      {
        accountId: 'grant_microsoft',
        provider: 'microsoft' as const,
        providerMessageId: 'msg_read',
        providerThreadId: 'thread_read',
        subject: 'Invoice read',
        from: 'Alerts <alerts@example.test>',
        to: 'Jakob <jakob@example.test>',
        receivedAt: now,
        snippet: 'Invoice already read',
        searchText: 'Invoice already read',
        labels: ['INBOX'],
        unread: false,
      },
    ];

    expect(plan.query).toBe('alerts@example.test invoice');
    const filtered = filterCorpusMessagesByAst(messages, ast);
    expect(filtered.map((message) => message.providerMessageId)).toEqual(['msg_match']);
    expect(corpusMessagesToThreads(filtered, 'grant_microsoft')[0]).toMatchObject({
      _id: 'thread_match',
      account: 'grant_microsoft',
      unread: true,
    });
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
