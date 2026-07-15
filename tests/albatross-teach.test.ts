import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS_TAB,
  factRowFromToolOutput,
  humanToolName,
  isTeachChatSession,
  SETTINGS_TABS,
  senderCardsFromToolOutput,
  senderInitials,
  settingsTabFromSearch,
  TEACH_CHAT_TITLE,
  TEACH_PANE_INITIAL,
  TOOL_SENTENCES,
  teachChatTitle,
  teachPaneReducer,
  toolActivityLine,
  toolActivityState,
  toolPartName,
} from '../lib/albatross/teach-ui';

describe('settings tabs', () => {
  test('every declared tab id resolves to itself', () => {
    for (const tab of SETTINGS_TABS) {
      expect(settingsTabFromSearch(tab.id)).toBe(tab.id);
    }
  });

  test('is case- and whitespace-tolerant', () => {
    expect(settingsTabFromSearch(' Areas ')).toBe('areas');
    expect(settingsTabFromSearch('AI')).toBe('ai');
    expect(settingsTabFromSearch('Notifications')).toBe('notifications');
  });

  test('unknown, empty, and missing values land on the default tab', () => {
    expect(settingsTabFromSearch('albatross')).toBe(DEFAULT_SETTINGS_TAB);
    expect(settingsTabFromSearch('')).toBe(DEFAULT_SETTINGS_TAB);
    expect(settingsTabFromSearch(null)).toBe(DEFAULT_SETTINGS_TAB);
    expect(settingsTabFromSearch(undefined)).toBe(DEFAULT_SETTINGS_TAB);
    expect(DEFAULT_SETTINGS_TAB).toBe('mailboxes');
  });

  test('tab labels are sentence case, never all-caps', () => {
    for (const tab of SETTINGS_TABS) {
      // Initialisms like "AI" are fine; multi-word shouting is not.
      if (tab.label.length > 3) expect(tab.label).not.toBe(tab.label.toUpperCase());
    }
  });
});

describe('teach chat session identity', () => {
  test('title is the reserved constant', () => {
    expect(teachChatTitle()).toBe(TEACH_CHAT_TITLE);
    expect(TEACH_CHAT_TITLE).toBe('Teach: areas');
  });

  test('finds the teach session among summaries by title prefix', () => {
    expect(isTeachChatSession({ title: 'Teach: areas' })).toBe(true);
    expect(isTeachChatSession({ title: '  Teach: areas (resumed)' })).toBe(true);
    expect(isTeachChatSession({ title: 'Triage my inbox' })).toBe(false);
    expect(isTeachChatSession({ title: undefined })).toBe(false);
    expect(isTeachChatSession(null)).toBe(false);
  });
});

describe('toolPartName', () => {
  test('resolves static tool- parts and dynamic-tool parts', () => {
    expect(toolPartName({ type: 'tool-area_create' })).toBe('area_create');
    expect(toolPartName({ type: 'dynamic-tool', toolName: 'ask_user' })).toBe('ask_user');
  });

  test('returns empty string for non-tool parts', () => {
    expect(toolPartName({ type: 'text' })).toBe('');
    expect(toolPartName({ type: 'dynamic-tool' })).toBe('');
    expect(toolPartName(null)).toBe('');
    expect(toolPartName(undefined)).toBe('');
  });
});

describe('senderInitials', () => {
  test('prefers two-word names', () => {
    expect(senderInitials('Andrew Kim', 'andrew@cardhunt.com')).toBe('AK');
  });

  test('single-word name uses its first two letters', () => {
    expect(senderInitials('Priya', 'p@cardhunt.com')).toBe('PR');
  });

  test('falls back to the email local part', () => {
    expect(senderInitials(undefined, 'jane.doe@cardhunt.com')).toBe('JD');
    expect(senderInitials('', 'bob@cardhunt.com')).toBe('BO');
  });

  test('never returns an empty string', () => {
    expect(senderInitials(undefined, '').length).toBeGreaterThan(0);
  });
});

describe('senderCardsFromToolOutput', () => {
  const output = {
    domain: 'cardhunt.com',
    senderEmail: null,
    threadsScanned: 500,
    threadsMatched: 14,
    senders: [
      {
        email: 'Bob@cardhunt.com',
        name: 'Bob Lee',
        threads: 3,
        lastDate: 1700000000000,
        recentSubjects: ['Sprint review', 'Standup notes'],
      },
      { email: 'alice@cardhunt.com', threads: 9, lastDate: 1710000000000, recentSubjects: [] },
    ],
  };

  test('maps senders to render-ready cards, sorted by thread count', () => {
    const cards = senderCardsFromToolOutput(output);
    expect(cards).toHaveLength(2);
    expect(cards[0].email).toBe('alice@cardhunt.com');
    expect(cards[0].threads).toBe(9);
    expect(cards[0].name).toBeUndefined();
    expect(cards[0].lastSubject).toBeUndefined();
    expect(cards[1]).toEqual({
      email: 'bob@cardhunt.com',
      name: 'Bob Lee',
      initials: 'BL',
      threads: 3,
      lastDate: 1700000000000,
      lastSubject: 'Sprint review',
    });
  });

  test('drops rows without a usable email and survives garbage output', () => {
    expect(senderCardsFromToolOutput({ senders: [{ name: 'No Email' }, { email: 'not-an-email' }] })).toEqual(
      [],
    );
    expect(senderCardsFromToolOutput(null)).toEqual([]);
    expect(senderCardsFromToolOutput(undefined)).toEqual([]);
    expect(senderCardsFromToolOutput({})).toEqual([]);
    expect(senderCardsFromToolOutput('nope')).toEqual([]);
  });

  test('defaults a missing thread count to zero', () => {
    const cards = senderCardsFromToolOutput({ senders: [{ email: 'x@y.com' }] });
    expect(cards[0].threads).toBe(0);
  });
});

describe('factRowFromToolOutput', () => {
  test('area_create becomes a created row that confirms the sidebar', () => {
    expect(factRowFromToolOutput('area_create', { name: 'CardHunt' }, { ok: true, areaId: 'a1' })).toEqual({
      tone: 'created',
      text: 'CardHunt created — in your sidebar',
    });
    // Output-echoed name backstops a missing input echo in restored history.
    expect(factRowFromToolOutput('area_create', {}, { ok: true, areaId: 'a1', name: 'StatPearls' })).toEqual({
      tone: 'created',
      text: 'StatPearls created — in your sidebar',
    });
  });

  test('area_add_fact separates verified from candidate', () => {
    expect(
      factRowFromToolOutput(
        'area_add_fact',
        { value: 'andrew@cardhunt.com — boss' },
        { ok: true, factId: 'f1', status: 'verified' },
      ),
    ).toEqual({ tone: 'verified', text: 'Verified: andrew@cardhunt.com — boss' });
    expect(
      factRowFromToolOutput(
        'area_add_fact',
        { value: 'cardhunt.com' },
        { ok: true, factId: 'f2', status: 'candidate' },
      ),
    ).toEqual({ tone: 'candidate', text: 'To confirm: cardhunt.com' });
  });

  test('area_archive and area_fact_set_status become retired rows', () => {
    expect(factRowFromToolOutput('area_archive', { reason: 'quit the job' }, { ok: true })).toEqual({
      tone: 'retired',
      text: 'Area archived — quit the job',
    });
    expect(factRowFromToolOutput('area_archive', {}, { ok: true })?.text).toBe(
      'Area archived — history kept',
    );
    expect(factRowFromToolOutput('area_fact_set_status', { status: 'superseded' }, { ok: true })).toEqual({
      tone: 'retired',
      text: 'Fact superseded',
    });
    expect(factRowFromToolOutput('area_fact_set_status', { status: 'verified' }, { ok: true })?.tone).toBe(
      'verified',
    );
    expect(factRowFromToolOutput('area_artifact_set_status', { status: 'verified' }, { ok: true })).toEqual({
      tone: 'verified',
      text: 'Area relationship verified',
    });
    expect(factRowFromToolOutput('area_artifact_set_status', { status: 'rejected' }, { ok: true })).toEqual({
      tone: 'retired',
      text: 'Area relationship rejected',
    });
  });

  test('returns null for failed output, unknown tools, and empty facts', () => {
    expect(factRowFromToolOutput('area_create', { name: 'X' }, { ok: false })).toBeNull();
    expect(factRowFromToolOutput('area_create', { name: 'X' }, undefined)).toBeNull();
    expect(factRowFromToolOutput('corpus_search', {}, { ok: true })).toBeNull();
    expect(
      factRowFromToolOutput('area_add_fact', { value: '  ' }, { ok: true, status: 'candidate' }),
    ).toBeNull();
    expect(factRowFromToolOutput('area_fact_set_status', { status: 'bogus' }, { ok: true })).toBeNull();
  });
});

describe('teachPaneReducer', () => {
  test('starts expanded and not loaded', () => {
    expect(TEACH_PANE_INITIAL).toEqual({ loaded: false, collapsed: false });
  });

  test('an empty thread loads expanded (first-time user)', () => {
    expect(teachPaneReducer(TEACH_PANE_INITIAL, { type: 'loaded', messageCount: 0 })).toEqual({
      loaded: true,
      collapsed: false,
    });
  });

  test('a prior thread loads as the collapsed strip (adding more later)', () => {
    expect(teachPaneReducer(TEACH_PANE_INITIAL, { type: 'loaded', messageCount: 12 })).toEqual({
      loaded: true,
      collapsed: true,
    });
  });

  test('expand and collapse toggle without losing loaded', () => {
    const collapsed = teachPaneReducer(TEACH_PANE_INITIAL, { type: 'loaded', messageCount: 5 });
    const expanded = teachPaneReducer(collapsed, { type: 'expand' });
    expect(expanded).toEqual({ loaded: true, collapsed: false });
    expect(teachPaneReducer(expanded, { type: 'collapse' })).toEqual({ loaded: true, collapsed: true });
  });

  test('sending a message always expands the pane', () => {
    const collapsed = teachPaneReducer(TEACH_PANE_INITIAL, { type: 'loaded', messageCount: 5 });
    expect(teachPaneReducer(collapsed, { type: 'send' }).collapsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool activity grammar (toolActivityLine + friends)
// ---------------------------------------------------------------------------

describe('toolActivityState', () => {
  test('maps the AI SDK part states', () => {
    expect(toolActivityState('input-streaming')).toBe('running');
    expect(toolActivityState('input-available')).toBe('running');
    expect(toolActivityState('output-available', { ok: true })).toBe('done');
    expect(toolActivityState('output-available')).toBe('done');
    expect(toolActivityState('output-error')).toBe('failed');
    expect(toolActivityState(undefined)).toBe('running');
  });

  test('output-available with ok:false is a FAILURE, never a quiet success', () => {
    // This is how the hallucinated-writes bug hid: a failed write rendered
    // as a bland "Done." line.
    expect(toolActivityState('output-available', { ok: false })).toBe('failed');
    expect(toolActivityState('output-available', { ok: false, error: 'nope' })).toBe('failed');
  });
});

describe('humanToolName', () => {
  test('strips underscores, dashes, and dots into readable words', () => {
    expect(humanToolName('area_domain_activity')).toBe('area domain activity');
    expect(humanToolName('some-odd.tool_name')).toBe('some odd tool name');
  });

  test('never returns an empty label', () => {
    expect(humanToolName('')).toBe('a step');
    expect(humanToolName('___')).toBe('a step');
  });
});

describe('toolActivityLine — teach tools', () => {
  test('running lines carry the ellipsis and running state', () => {
    expect(toolActivityLine('corpus_search', { query: 'cardhunt.com' }, 'input-available')).toEqual({
      state: 'running',
      text: 'Searching your mail for “cardhunt.com”…',
    });
    expect(toolActivityLine('area_create', { name: 'StatPearls' }, 'input-streaming').text).toBe(
      'Creating area StatPearls…',
    );
  });

  test('done lines are short human sentences with real arguments', () => {
    expect(
      toolActivityLine('corpus_search', { query: 'cardhunt.com' }, 'output-available', {
        items: [1, 2, 3],
      }).text,
    ).toBe('Searched your mail for “cardhunt.com” — 3 results');
    expect(toolActivityLine('corpus_search', {}, 'output-available', { items: [1] }).text).toBe(
      'Searched your mail — 1 result',
    );
    expect(toolActivityLine('area_create', { name: 'StatPearls' }, 'output-available', { ok: true })).toEqual(
      { state: 'done', text: 'Created area StatPearls' },
    );
    expect(toolActivityLine('sender_profile', { email: 'a@b.com' }, 'output-available', {}).text).toBe(
      'Looked up a@b.com',
    );
    expect(
      toolActivityLine('area_domain_activity', { domain: 'cardhunt.com' }, 'output-available', {}).text,
    ).toBe('Checked recent senders for cardhunt.com');
    expect(toolActivityLine('area_list', {}, 'output-available', { areas: [] }).text).toBe(
      'Checked saved areas',
    );
  });

  test('area_add_fact reports the trust status', () => {
    expect(
      toolActivityLine('area_add_fact', { value: 'x' }, 'output-available', { ok: true, status: 'verified' })
        .text,
    ).toBe('Recorded fact — verified');
    expect(
      toolActivityLine('area_add_fact', { value: 'x' }, 'output-available', { ok: true, status: 'candidate' })
        .text,
    ).toBe('Recorded fact — to confirm');
    expect(toolActivityLine('area_add_fact', { value: 'boss email' }, 'input-available').text).toBe(
      'Recording boss email…',
    );
  });

  test('area_fact_set_status covers every status plus the fallback', () => {
    const done = (args: unknown) =>
      toolActivityLine('area_fact_set_status', args, 'output-available', { ok: true });
    expect(done({ status: 'verified' }).text).toBe('Fact verified');
    expect(done({ status: 'rejected' }).text).toBe('Fact rejected');
    expect(done({ status: 'superseded' }).text).toBe('Fact superseded');
    expect(done({ status: 'bogus' }).text).toBe('Fact updated');
    expect(toolActivityLine('area_fact_set_status', { status: 'verified' }, 'input-available').text).toBe(
      'Verifying the fact…',
    );
  });

  test('area_archive keeps the history promise', () => {
    expect(toolActivityLine('area_archive', {}, 'output-available', { ok: true }).text).toBe(
      'Area archived — history kept',
    );
    expect(
      toolActivityLine('area_archive', { reason: 'sold the house' }, 'output-available', { ok: true }).text,
    ).toBe('Area archived — sold the house');
  });
});

describe('toolActivityLine — failures are always visible', () => {
  test('output-error renders danger text with the error detail', () => {
    expect(
      toolActivityLine('area_create', { name: 'X' }, 'output-error', undefined, 'network exploded'),
    ).toEqual({ state: 'failed', text: 'Creating area X failed — network exploded' });
  });

  test('ok:false output is a failure and surfaces the output error', () => {
    expect(
      toolActivityLine('area_add_fact', { value: 'v' }, 'output-available', {
        ok: false,
        error: 'area not found',
      }),
    ).toEqual({ state: 'failed', text: 'Recording the fact failed — area not found' });
    expect(toolActivityLine('area_archive', {}, 'output-available', { ok: false }).text).toBe(
      'Archiving the area failed',
    );
  });

  test('multi-line and giant error details are clipped to one short line', () => {
    const line = toolActivityLine(
      'corpus_search',
      {},
      'output-error',
      undefined,
      `${'x'.repeat(400)}\nsecond line`,
    );
    expect(line.state).toBe('failed');
    expect(line.text.length).toBeLessThan(160);
    expect(line.text).not.toContain('second line');
  });
});

describe('toolActivityLine — general assistant tools', () => {
  test('ports the assistant sentences', () => {
    expect(toolActivityLine('search_threads', { query: 'from:amy' }, 'input-available').text).toBe(
      'Searching your mail for “from:amy”…',
    );
    expect(toolActivityLine('add_label', { label: 'Receipts' }, 'output-available', {}).text).toBe(
      'Added the “Receipts” label',
    );
    expect(
      toolActivityLine('tasks_update_card', { completed: true }, 'output-available', {
        card: { title: 'Ship it', columnName: 'Done' },
      }).text,
    ).toBe('Marked “Ship it” complete in Done');
    expect(
      toolActivityLine('tasks_move_card', {}, 'output-available', {
        noOp: true,
        card: { columnName: 'Doing' },
      }).text,
    ).toBe('Task already in Doing');
    expect(toolActivityLine('browserbase_fetch', { url: 'https://x.dev' }, 'output-available', {}).text).toBe(
      'Read https://x.dev',
    );
    expect(toolActivityLine('ui_set_query', { query: 'is:unread' }, 'output-available', {}).text).toBe(
      'Filtered your inbox to “is:unread”',
    );
    expect(toolActivityLine('calendar_list_events', {}, 'output-available', { events: [1, 2] }).text).toBe(
      'Found 2 calendar events',
    );
    expect(
      toolActivityLine('snooze_thread', { untilTs: Date.UTC(2026, 0, 1) }, 'output-available', {}).text,
    ).toContain('Snoozed until ');
    expect(toolActivityLine('send_message', { to: 'amy@x.com' }, 'output-available', {}).text).toBe(
      'Prepared a message to amy@x.com for your review',
    );
  });
});

describe('toolActivityLine — unknown tools and garbage input', () => {
  test('unknown tools get a readable generic line, never raw underscores', () => {
    const running = toolActivityLine('weather_lookup_v2', {}, 'input-available');
    expect(running.text).toBe('Running weather lookup v2…');
    expect(running.text).not.toContain('_');
    expect(toolActivityLine('weather_lookup_v2', {}, 'output-available', {}).text).toBe(
      'Finished weather lookup v2',
    );
    expect(toolActivityLine('weather_lookup_v2', {}, 'output-available', { results: [1, 2] }).text).toBe(
      'Finished weather lookup v2 — 2 results',
    );
    expect(toolActivityLine('weather_lookup_v2', {}, 'output-error').text).toBe('Weather lookup v2 failed');
  });

  test('a throwing sentence builder falls back to the generic line', () => {
    (TOOL_SENTENCES as Record<string, unknown>).boom_tool = () => {
      throw new Error('boom');
    };
    try {
      expect(toolActivityLine('boom_tool', {}, 'output-available', {}).text).toBe('Finished boom tool');
    } finally {
      delete (TOOL_SENTENCES as Record<string, unknown>).boom_tool;
    }
  });

  test('never throws on garbage args, outputs, or names', () => {
    expect(toolActivityLine('', null, 'output-available', 'garbage').state).toBe('done');
    expect(toolActivityLine('corpus_search', 42, 'input-available').state).toBe('running');
    expect(toolActivityLine('tasks_update_card', null, 'output-available', { card: 'nope' }).state).toBe(
      'done',
    );
    expect(toolActivityLine('ask_user', {}, 'output-available', { answers: [] }).text).toBe('You answered');
  });
});

describe('TOOL_SENTENCES style rules', () => {
  // Rich fixtures exercise the dynamic branches of every sentence builder.
  const richArgs = {
    query: 'q',
    description: 'd',
    email: 'a@b.co',
    domain: 'x.com',
    senderEmail: 's@x.com',
    name: 'N',
    reason: 'r',
    value: 'v',
    status: 'verified',
    label: 'L',
    title: 'T',
    to: 't@x.com',
    url: 'https://x.dev',
    untilTs: 1700000000000,
    account: 'acct',
    completed: true,
    confirmedByUser: true,
    column: 'Doing',
  };
  const richOutput = {
    items: [1],
    events: [1],
    name: 'F',
    reason: 'because',
    status: 'verified',
    card: { title: 'CT', columnName: 'Doing' },
    noOp: false,
  };

  test('every sentence is sentence case, concrete, and free of tool identifiers', () => {
    for (const [name, builder] of Object.entries(TOOL_SENTENCES)) {
      for (const [args, output] of [
        [{}, {}],
        [richArgs, richOutput],
      ] as const) {
        const sentences = builder(args as Record<string, unknown>, output as Record<string, unknown>);
        for (const key of ['running', 'done', 'failed'] as const) {
          const text = sentences[key];
          expect(text.length).toBeGreaterThan(0);
          // Sentence case: starts with a capital, is not SHOUTED.
          expect(text[0]).toBe(text[0].toUpperCase());
          expect(text).not.toBe(text.toUpperCase());
          // Never leak a raw underscored tool identifier ("area_create").
          if (name.includes('_')) expect(text).not.toContain(name);
          expect(text).not.toMatch(/\w_\w/);
        }
        // Failure lines must read as failures.
        expect(sentences.failed.toLowerCase()).toContain('fail');
      }
    }
  });
});
