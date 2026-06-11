import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
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
      latest_message_after: expect.any(Number),
      page_token: 'next-page',
    });
    expect(params).not.toHaveProperty('search_query_native');
    // Nylas takes Unix SECONDS; a millisecond value or date string here is the
    // bug that blanked the entire inbox once already.
    const after = params.latest_message_after as number;
    expect(Number.isInteger(after)).toBe(true);
    expect(after).toBeGreaterThan(Date.parse('2020-01-01') / 1000);
    expect(after).toBeLessThan(Date.now() / 1000 + 86_400);
  });

  test('Gmail native fallback passes the user query verbatim with legal companions only', async () => {
    const { buildNativeSearchPlan } = await import('../lib/mail/search/compiler');
    const plan = buildNativeSearchPlan({
      provider: 'google',
      query: 'in:inbox newer_than:30d "magic link" -in:spam',
      max: 30,
      pageToken: 'cursor-1',
    });

    expect(plan.tier).toBe('native');
    expect(plan.queryParams).toEqual({
      limit: 30,
      search_query_native: 'in:inbox newer_than:30d "magic link" -in:spam',
      page_token: 'cursor-1',
    });
  });

  test('structured compiler maps Gmail system folders and defers opaque provider folders', async () => {
    const { compileQueryToNylasStructuredParams, UNRESOLVED_FOLDER_PARAM } = await import(
      '../lib/mail/search/compiler'
    );
    const google = compileQueryToNylasStructuredParams({
      provider: 'google',
      query: 'in:drafts',
      max: 10,
    });
    expect(google.queryParams.in).toBe('DRAFT');

    const microsoft = compileQueryToNylasStructuredParams({
      provider: 'microsoft',
      query: 'in:inbox',
      max: 10,
    });
    expect(microsoft.queryParams).not.toHaveProperty('in');
    expect(microsoft.queryParams[UNRESOLVED_FOLDER_PARAM]).toBe('INBOX');
  });

  test('Microsoft structured queries drop date filters that silently empty results', async () => {
    const { compileQueryToNylasStructuredParams } = await import('../lib/mail/search/compiler');
    // Verified against a live grant: latest_message_after/_before return ZERO
    // threads on Microsoft (fine on Google/iCloud). The clause must be dropped
    // and surfaced, never sent.
    const plan = compileQueryToNylasStructuredParams({
      provider: 'microsoft',
      query: 'in:inbox newer_than:30d older_than:1d',
      max: 10,
    });
    expect(plan.queryParams).not.toHaveProperty('latest_message_after');
    expect(plan.queryParams).not.toHaveProperty('latest_message_before');
    expect(plan.dropped.filter((item: any) => item.reason.includes('date filters')).length).toBe(2);

    const google = compileQueryToNylasStructuredParams({
      provider: 'google',
      query: 'newer_than:30d',
      max: 10,
    });
    expect(google.queryParams.latest_message_after).toEqual(expect.any(Number));
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

    try {
      delete process.env.LAB86_MAIL_ICLOUD_MODE;
      delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
      expect(mailProviderCapability('icloud')).toMatchObject({
        visible: false,
        connectable: false,
      });

      // Mode flipped on but the Nylas connector not provisioned: visible so the
      // rollout state shows in the UI, but not connectable.
      process.env.LAB86_MAIL_ICLOUD_MODE = 'beta';
      delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
      expect(mailProviderCapability('icloud')).toMatchObject({
        visible: true,
        connectable: false,
      });

      process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = '1';
      expect(mailProviderCapability('icloud')).toMatchObject({
        visible: true,
        connectable: true,
        searchable: true,
      });
    } finally {
      if (previousMode === undefined) delete process.env.LAB86_MAIL_ICLOUD_MODE;
      else process.env.LAB86_MAIL_ICLOUD_MODE = previousMode;
      if (previousReady === undefined) delete process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY;
      else process.env.LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY = previousReady;
    }
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

  test('fallback webhook event ids never collide for distinct payloads', async () => {
    const { extractNylasWebhookMetadata } = await import('../lib/mail/corpus');
    // No id, no timestamp, no object ids — the worst-case payloads that used
    // to collapse onto one dedup key and silently skip deliveries.
    const first = extractNylasWebhookMetadata({ type: 'message.created', data: { object: { body: 'a' } } });
    const second = extractNylasWebhookMetadata({ type: 'message.created', data: { object: { body: 'b' } } });

    expect(first.eventId).not.toBe(second.eventId);
    expect(first.eventId.length).toBeGreaterThan('message.created::'.length);
  });

  test('yearMonthFromTimestamp survives invalid inputs and fallbacks', async () => {
    const { yearMonthFromTimestamp } = await import('../lib/mail/corpus');
    expect(yearMonthFromTimestamp(Number.NaN, Number.NaN)).toMatch(/^\d{4}-\d{2}$/);
    expect(yearMonthFromTimestamp('garbage', Date.parse('2026-02-01T00:00:00Z'))).toBe('2026-02');
  });
});

describe('local-first mail search routing', () => {
  test('local corpus is tier 1 for every provider with per-provider fallbacks', async () => {
    const previousProviders = process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
    const previousDisabled = process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS;
    try {
      delete process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
      delete process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS;

      const { LOCAL_PAGE_TOKEN_PREFIX, resolveSearchRoute } = await import('../lib/mail/search/capabilities');

      // Corpus ready: every provider searches locally.
      for (const provider of ['google', 'microsoft', 'icloud', 'imap'] as const) {
        expect(resolveSearchRoute({ provider, corpusReady: true })).toMatchObject({
          tier: 'local',
          localEnabled: true,
        });
      }

      // Corpus not ready: Gmail falls back to verbatim native search, the
      // rest to structured params.
      expect(resolveSearchRoute({ provider: 'google', corpusReady: false })).toMatchObject({
        tier: 'native',
        corpusReady: false,
      });
      expect(resolveSearchRoute({ provider: 'microsoft', corpusReady: false })).toMatchObject({
        tier: 'structured',
        corpusReady: false,
      });
      expect(resolveSearchRoute({ provider: 'icloud', corpusReady: false })).toMatchObject({
        tier: 'structured',
      });

      // Horizon-aware: a partially-backfilled corpus (newest-first) serves a
      // query locally when its lower date bound sits inside the indexed
      // window. Browse-style views (no free text) serve locally from ANY
      // non-empty corpus — partial indexing must never slow down browsing —
      // while text searches past the horizon still fall back for completeness.
      const horizon = Date.parse('2026-01-01');
      expect(
        resolveSearchRoute({
          provider: 'google',
          corpusReady: false,
          oldestIndexedAt: horizon,
          queryAfter: Date.parse('2026-05-01'),
          hasTextQuery: true,
        }),
      ).toMatchObject({ tier: 'local', reason: 'partial corpus covers the queried window' });
      expect(
        resolveSearchRoute({
          provider: 'google',
          corpusReady: false,
          oldestIndexedAt: horizon,
          queryAfter: Date.parse('2025-06-01'),
          hasTextQuery: true,
        }),
      ).toMatchObject({ tier: 'native' });
      expect(
        resolveSearchRoute({
          provider: 'google',
          corpusReady: false,
          oldestIndexedAt: horizon,
          queryAfter: Date.parse('2025-06-01'),
        }),
      ).toMatchObject({ tier: 'local', reason: 'partial corpus serves browse views while backfill runs' });
      expect(
        resolveSearchRoute({ provider: 'microsoft', corpusReady: false, oldestIndexedAt: horizon }),
      ).toMatchObject({ tier: 'local' });
      expect(
        resolveSearchRoute({
          provider: 'microsoft',
          corpusReady: false,
          oldestIndexedAt: horizon,
          hasTextQuery: true,
        }),
      ).toMatchObject({ tier: 'structured' });

      // Local cursors keep paging locally; provider cursors stay on the
      // fallback transport.
      expect(
        resolveSearchRoute({
          provider: 'google',
          corpusReady: true,
          pageToken: `${LOCAL_PAGE_TOKEN_PREFIX}1765000000000`,
        }),
      ).toMatchObject({ tier: 'local' });
      expect(
        resolveSearchRoute({ provider: 'google', corpusReady: true, pageToken: 'nylas-cursor' }),
      ).toMatchObject({ tier: 'native' });

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
    } finally {
      if (previousProviders === undefined) delete process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
      else process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS = previousProviders;
      if (previousDisabled === undefined) delete process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS;
      else process.env.LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS = previousDisabled;
    }
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

  test('parses OR groups and matches provider-neutral mailbox labels locally', async () => {
    const { parseMailSearchQuery } = await import('../lib/mail/search/parser');
    const { filterCorpusMessagesByAst } = await import('../lib/mail/search/local');
    const now = Date.parse('2026-06-10T12:00:00.000Z');
    const messages = [
      {
        accountId: 'grant_microsoft',
        provider: 'microsoft' as const,
        providerMessageId: 'msg_sent',
        providerThreadId: 'thread_sent',
        subject: 'Sent proposal',
        from: 'Jakob <jakob@example.test>',
        to: 'Tori <tori@example.test>',
        receivedAt: now,
        snippet: 'Sent proposal',
        searchText: 'Sent proposal',
        labels: ['Sent Items'],
      },
      {
        accountId: 'grant_microsoft',
        provider: 'microsoft' as const,
        providerMessageId: 'msg_deleted',
        providerThreadId: 'thread_deleted',
        subject: 'Deleted notice',
        from: 'Alerts <alerts@example.test>',
        to: 'Jakob <jakob@example.test>',
        receivedAt: now,
        snippet: 'Deleted notice',
        searchText: 'Deleted notice',
        labels: ['Deleted Items'],
      },
      {
        accountId: 'grant_icloud',
        provider: 'icloud' as const,
        providerMessageId: 'msg_icloud',
        providerThreadId: 'thread_icloud',
        subject: 'Apple storage',
        from: 'iCloud <storage@icloud.com>',
        to: 'Jakob <jakob@example.test>',
        receivedAt: now,
        snippet: 'Storage update',
        searchText: 'Storage update',
        labels: ['Inbox'],
      },
    ];

    expect(
      filterCorpusMessagesByAst(messages, parseMailSearchQuery('in:sent')).map((m) => m.providerMessageId),
    ).toEqual(['msg_sent']);
    expect(
      filterCorpusMessagesByAst(messages, parseMailSearchQuery('in:trash')).map((m) => m.providerMessageId),
    ).toEqual(['msg_deleted']);
    expect(
      filterCorpusMessagesByAst(messages, parseMailSearchQuery('from:(icloud.com OR me.com)')).map(
        (m) => m.providerMessageId,
      ),
    ).toEqual(['msg_icloud']);
  });

  test('scopes natural-language account wording to a mailbox instead of sender search', async () => {
    const { applyNaturalLanguageAccountHint, resolveAccountScopedQuery } = await import(
      '../lib/mail/search/account-scope'
    );
    const hinted = applyNaturalLanguageAccountHint(
      'stuff from my pat.demo@outlook.com account older than 40 days',
      'from:pat.demo@outlook.com older_than:40d',
    );
    const scoped = resolveAccountScopedQuery(hinted, [
      {
        accountId: 'grant_outlook',
        email: 'pat.demo@outlook.com',
        displayName: 'Outlook',
      },
      {
        accountId: 'grant_gmail',
        email: 'pat.demo@gmail.com',
        displayName: 'Gmail',
      },
    ]);

    expect(hinted).toBe('account:pat.demo@outlook.com older_than:40d');
    expect(scoped).toEqual({
      query: 'older_than:40d',
      accountIds: ['grant_outlook'],
      accountLabels: ['Outlook'],
    });
  });

  test('local corpus plans carry date-only older-than filters to Convex', async () => {
    const { parseMailSearchQuery } = await import('../lib/mail/search/parser');
    const { compileAstToLocalCorpusQuery } = await import('../lib/mail/search/local');
    const plan = compileAstToLocalCorpusQuery(parseMailSearchQuery('older_than:40d'));

    expect(plan.query).toBe('');
    expect(plan.before).toEqual(expect.any(Number));
    expect(plan.after).toBeUndefined();
  });
});

describe('compliance readiness', () => {
  test('public legal pages include Limited Use and deletion guarantees', () => {
    const privacy = readFileSync(path.join(process.cwd(), 'app/privacy/page.tsx'), 'utf8');
    const support = readFileSync(path.join(process.cwd(), 'app/support/page.tsx'), 'utf8');
    const privacyText = privacy.replace(/\s+/g, ' ');

    expect(privacy).toContain('Google API Services User Data Policy');
    expect(privacy).toContain('Limited Use requirements');
    expect(privacyText).toContain('Disconnecting a provider');
    expect(privacyText).toContain('Account deletion removes');
    expect(support).toContain('security@lab86.io');
  });

  test('account deletion cascade covers every schema table', () => {
    // Derived from the schema so a newly added table fails this test until it
    // is either added to the cascade or explicitly exempted here.
    const schema = readFileSync(path.join(process.cwd(), 'convex/schema.ts'), 'utf8');
    const accounts = readFileSync(path.join(process.cwd(), 'convex/accounts.ts'), 'utf8');
    const cascadeSource = accounts.slice(accounts.indexOf('deleteUserCascade'));
    const tables = [...schema.matchAll(/^\s{2}([a-zA-Z0-9]+): defineTable/gm)].map((match) => match[1]);
    const exempt = new Set<string>([]);

    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      if (exempt.has(table)) continue;
      expect(cascadeSource).toContain(`'${table}'`);
    }
  });
});

describe('B2C AI budget accounting', () => {
  test('derives internal credits from OpenAI list-price token costs', async () => {
    const { estimateAiUsageCost } = await import('../lib/ai/budget');
    const cost = estimateAiUsageCost({
      provider: 'openai',
      model: 'gpt-5.5',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    expect(cost.estimatedCostUsd).toBe(35);
    expect(cost.estimatedCredits).toBe(3500);
  });

  test('accounts for Anthropic cached reads and batch discounts', async () => {
    const { estimateAiUsageCost } = await import('../lib/ai/budget');
    const cached = estimateAiUsageCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const batched = estimateAiUsageCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      batch: true,
    });

    expect(cached.estimatedCostUsd).toBeCloseTo(15.3, 5);
    expect(cached.estimatedCredits).toBe(1530);
    expect(batched.estimatedCostUsd).toBe(9);
    expect(batched.estimatedCredits).toBe(900);
  });

  test('soft-degrades at 80 percent and hard-stops chat at 100 percent only', async () => {
    const { resolveAiBudgetPolicy, shouldDepleteLab86Budget } = await import('../lib/ai/budget');

    expect(
      resolveAiBudgetPolicy({ feature: 'daily_report_narrative', monthlyCredits: 500, creditsUsed: 400 }),
    ).toMatchObject({
      softLimited: true,
      forceFastModel: true,
      hardStopped: false,
    });
    expect(resolveAiBudgetPolicy({ feature: 'agent', monthlyCredits: 500, creditsUsed: 500 })).toMatchObject({
      exhausted: true,
      hardStopped: true,
    });
    expect(
      resolveAiBudgetPolicy({ feature: 'classify_threads', monthlyCredits: 500, creditsUsed: 500 }),
    ).toMatchObject({
      exhausted: true,
      hardStopped: false,
      forceFastModel: true,
    });
    expect(shouldDepleteLab86Budget('byok')).toBe(false);
    expect(shouldDepleteLab86Budget('lab86')).toBe(true);
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
    // Stores are tenancy-scoped via the ambient request context; tool handlers
    // called directly (outside invokeTool) need it established explicitly.
    const { runWithAiRequestContext } = await import('../lib/ai/context');
    await runWithAiRequestContext(
      { userId: 'test_user', userEmail: 'jakob@example.test', agent: 'codex' },
      async () => {
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
      },
    );
  });
});
