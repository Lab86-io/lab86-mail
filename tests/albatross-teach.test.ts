import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS_TAB,
  factRowFromToolOutput,
  isTeachChatSession,
  SETTINGS_TABS,
  senderCardsFromToolOutput,
  senderInitials,
  settingsTabFromSearch,
  TEACH_CHAT_TITLE,
  TEACH_PANE_INITIAL,
  teachChatTitle,
  teachPaneReducer,
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
  test('area_create becomes a created row', () => {
    expect(factRowFromToolOutput('area_create', { name: 'CardHunt' }, { ok: true, areaId: 'a1' })).toEqual({
      tone: 'created',
      text: 'CardHunt created',
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
