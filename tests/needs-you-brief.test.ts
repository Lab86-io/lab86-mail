import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import './tools/harness';
import {
  composeEditorialDocument,
  defaultEditorialPlan,
  EDITORIAL_REGION_LIMIT,
  editorialModules,
} from '../lib/brief/editorial';
import { briefLetterFromReport, briefLetterKind } from '../lib/brief/letter';
import { projectBriefMail } from '../lib/jev/report';
import { generateAgentReport } from '../lib/mail/agent-report';
import {
  BRIEF_NEEDS_YOU_BYTE_LIMIT,
  BRIEF_NEEDS_YOU_CLOSED_LIMIT,
  buildBriefNeedsYouRegion,
  editionNeedsYou,
  NEEDS_YOU_LANE_ID,
  needsYouClosedLine,
  needsYouCountSentence,
  needsYouEditorialStory,
  needsYouLaneItem,
  needsYouLaneParts,
  needsYouLetterRegion,
  needsYouSectionOf,
  parseBriefNeedsYouRegion,
  placeNeedsYouLane,
  setBriefNeedsYouLoaderForTest,
  sinceLetterPhrase,
  slimForBrief,
  withBriefNeedsYou,
} from '../lib/obligations/brief-region';
import {
  BRIEF_NEEDS_YOU_LIMIT,
  type BriefNeedsYouRegion,
  type ObligationClosedNote,
  type ObligationView,
} from '../lib/obligations/contract';
import { isKnownBriefAction } from '../lib/shared/brief-actions';
import {
  type BriefDocumentV2,
  type BriefNode,
  type BriefRegion,
  lintBriefDocument,
  parseBriefDocument,
} from '../lib/shared/brief-document';
import type { DailyReport } from '../lib/shared/types';
import { dailyReportForStorage, getDailyReport, migrateDailyReport } from '../lib/store/daily-reports';
import { editorialFixture } from './fixtures/editorial';
import { NOW as JEV_NOW, assessment as jevAssessment, policy, thread } from './fixtures/jev';
import { withToolContext } from './tools/harness';

// Needs you in the Daily Brief (phase 3, S2). Invented people and companies only.

const ZONE = 'America/New_York';
// 13:00 UTC on Friday 2026-10-30 is 09:00 in New York.
const NOW = Date.parse('2026-10-30T13:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterEach(() => setBriefNeedsYouLoaderForTest());

let counter = 0;
function view(patch: Partial<ObligationView> = {}): ObligationView {
  counter += 1;
  return {
    id: `ob${counter}`,
    kind: 'reply',
    state: 'open',
    source: 'mail',
    sourceKey: `mail:acct:thread-${counter}`,
    accountId: 'acct',
    threadId: `thread-${counter}`,
    messageId: `m${counter}`,
    title: `Confirm the start date ${counter}`,
    asker: 'Dana Whitfield',
    why: 'Dana Whitfield asked you something that is still open.',
    excerpt: 'Could you confirm the start date?',
    due: 'none',
    pushLevel: 'normal',
    probability: 0.95,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...patch,
  };
}

function closedNote(patch: Partial<ObligationClosedNote> = {}): ObligationClosedNote {
  counter += 1;
  return {
    id: `closed${counter}`,
    title: 'Renewal notice',
    asker: 'Northwind Billing',
    source: 'mail',
    closeReason: 'aged_out',
    closedAt: NOW - 2 * HOUR,
    ...patch,
  };
}

function region(patch: Partial<BriefNeedsYouRegion> = {}): BriefNeedsYouRegion {
  return { id: 'needs-you', open: 0, now: 0, dueToday: 0, items: [], closedSince: [], ...patch };
}

describe('buildBriefNeedsYouRegion', () => {
  test('the Now items, then the items due today; codes never; counts of every open group', () => {
    const urgent = view({ kind: 'change', pushLevel: 'time_sensitive', createdAt: NOW - 3 * HOUR });
    const overdue = view({ dueAt: NOW - HOUR, due: 'today' });
    const today = view({ due: 'today', createdAt: NOW - 2 * HOUR });
    const week = view({ due: 'soon' });
    const waiting = view({ kind: 'waiting' });
    const code = view({
      kind: 'code',
      pushLevel: 'time_sensitive',
      code: { value: '482913', expiresAt: NOW + 300_000 },
    });
    const later = view({ state: 'snoozed', snoozedUntil: NOW + DAY });
    const closed = view({ state: 'done', closeReason: 'user_done', closedAt: NOW - HOUR });
    const built = buildBriefNeedsYouRegion({
      items: [week, closed, today, code, waiting, urgent, later, overdue],
      closed: [closedNote()],
      now: NOW,
      timezone: ZONE,
    });
    expect(built.id).toBe(NEEDS_YOU_LANE_ID);
    expect(built.items.map((item) => item.id)).toEqual([overdue.id, urgent.id, today.id]);
    expect(built.now).toBe(2);
    expect(built.dueToday).toBe(1);
    // Now 2, Today 1, This week 1, Waiting 1. The code, the snoozed item, and the closed item do not count.
    expect(built.open).toBe(5);
    expect(built.closedSince).toHaveLength(1);
    expect(JSON.stringify(built)).not.toContain('482913');
  });

  test('at most BRIEF_NEEDS_YOU_LIMIT items and BRIEF_NEEDS_YOU_CLOSED_LIMIT closed notes', () => {
    const items = Array.from({ length: BRIEF_NEEDS_YOU_LIMIT + 3 }, () =>
      view({ pushLevel: 'time_sensitive' }),
    );
    const closed = Array.from({ length: BRIEF_NEEDS_YOU_CLOSED_LIMIT + 2 }, () => closedNote());
    const built = buildBriefNeedsYouRegion({ items, closed, now: NOW, timezone: ZONE });
    expect(built.items).toHaveLength(BRIEF_NEEDS_YOU_LIMIT);
    expect(built.now).toBe(BRIEF_NEEDS_YOU_LIMIT + 3);
    expect(built.closedSince).toHaveLength(BRIEF_NEEDS_YOU_CLOSED_LIMIT);
  });

  test('stores short items: no code value, no draft state, cut text', () => {
    const slim = slimForBrief(
      view({
        title: 'T'.repeat(900),
        asker: 'A'.repeat(400),
        why: 'W'.repeat(900),
        excerpt: 'E'.repeat(900),
        sourceLabel: 'S'.repeat(400),
        workId: 'work-1',
        workTitle: 'K'.repeat(400),
        draftReady: true,
        code: { value: '111222' },
        closedAt: NOW,
        closeReason: 'evidence',
      }),
    );
    expect(slim.title).toHaveLength(300);
    expect(slim.asker).toHaveLength(180);
    expect(slim.why).toHaveLength(300);
    expect(slim.excerpt).toHaveLength(280);
    expect(slim.sourceLabel).toHaveLength(120);
    expect(slim.workTitle).toHaveLength(180);
    expect(slim).not.toHaveProperty('code');
    expect(slim).not.toHaveProperty('draftReady');
    expect(slim).not.toHaveProperty('closedAt');
    expect(slim).not.toHaveProperty('closeReason');
    const { why: _why, excerpt: _excerpt, ...withoutText } = view();
    const bare = slimForBrief(withoutText);
    expect(bare).not.toHaveProperty('why');
    expect(bare).not.toHaveProperty('excerpt');
    const closed = buildBriefNeedsYouRegion({
      items: [],
      closed: [closedNote({ title: 'x'.repeat(900), asker: 'y'.repeat(900) })],
      now: NOW,
      timezone: ZONE,
    }).closedSince[0];
    expect(closed.title).toHaveLength(300);
    expect(closed.asker).toHaveLength(180);
  });

  test('stays inside the byte budget: the excerpts and reasons go first, then items from the end', () => {
    const items = Array.from({ length: BRIEF_NEEDS_YOU_LIMIT }, () =>
      view({ pushLevel: 'time_sensitive', url: `https://northwind.test/${'p'.repeat(2_400)}` }),
    );
    const built = buildBriefNeedsYouRegion({ items, closed: [], now: NOW, timezone: ZONE });
    expect(Buffer.byteLength(JSON.stringify(built))).toBeLessThanOrEqual(BRIEF_NEEDS_YOU_BYTE_LIMIT);
    expect(built.items.length).toBeLessThan(BRIEF_NEEDS_YOU_LIMIT);
    expect(built.items.length).toBeGreaterThan(0);
    expect(built.items[0]).not.toHaveProperty('excerpt');
    expect(built.items[0]).not.toHaveProperty('why');
    expect(built.now).toBe(BRIEF_NEEDS_YOU_LIMIT);
  });
});

describe('the lane items', () => {
  test('a mail reply: the item shape of the answer lane, with Open first, then Reply and the Albatross', () => {
    const item = needsYouLaneItem(
      view({
        id: 'ob-mail',
        accountId: 'acct',
        threadId: 'thread-9',
        title: 'Could you confirm the start date?',
        workId: 'work-1',
        workTitle: 'Northwind SOW',
        createdAt: NOW - 2 * DAY - HOUR,
      }),
      NOW,
      'now',
    );
    expect(item).toEqual({
      ref: { kind: 'thread', id: 'thread-9', account: 'acct', label: 'Could you confirm the start date?' },
      framing: {
        lane: 'now',
        reason: 'Could you confirm the start date?',
        sender: 'Dana Whitfield',
        age: 'Day 3',
      },
      actions: [
        {
          action: 'open_thread',
          label: 'Open',
          payload: { account: 'acct', threadId: 'thread-9', subject: 'Could you confirm the start date?' },
          style: 'quiet',
        },
        {
          action: 'draft_reply',
          label: 'Reply',
          payload: { account: 'acct', threadId: 'thread-9', subject: 'Could you confirm the start date?' },
          style: 'secondary',
        },
        {
          action: 'open_work',
          label: 'Open Albatross',
          payload: { workId: 'work-1', title: 'Northwind SOW' },
          style: 'quiet',
        },
      ],
    });
    // An action on a mail thread offers no Reply; an item from today has no age.
    const action = needsYouLaneItem(view({ kind: 'action', workId: 'work-2' }), NOW);
    expect(action.actions.map((entry) => entry.action)).toEqual(['open_thread', 'open_work']);
    expect(action.actions[1].payload).toEqual({ workId: 'work-2' });
    expect(action.framing).not.toHaveProperty('age');
    expect(needsYouLaneItem(view({ createdAt: NOW + HOUR }), NOW).framing).not.toHaveProperty('age');
  });

  test('a calendar item opens its event; a connected item opens its link and names its place', () => {
    const event = needsYouLaneItem(
      view({
        kind: 'rsvp',
        source: 'calendar',
        sourceKey: 'calendar:acct:evt-1',
        threadId: undefined,
        eventId: 'evt-1',
        title: 'Answer the invitation to Q4 planning',
      }),
      NOW,
    );
    expect(event.ref).toEqual({
      kind: 'event',
      id: 'evt-1',
      account: 'acct',
      label: 'Answer the invitation to Q4 planning',
    });
    expect(event.actions).toEqual([
      { action: 'open_event', label: 'Open', payload: { account: 'acct', eventId: 'evt-1' }, style: 'quiet' },
    ]);
    const bareEvent = needsYouLaneItem(
      view({ source: 'calendar', accountId: undefined, threadId: undefined, eventId: 'evt-2' }),
      NOW,
    );
    expect(bareEvent.ref).not.toHaveProperty('account');
    expect(bareEvent.actions[0].payload).toEqual({ eventId: 'evt-2' });

    const slack = needsYouLaneItem(
      view({
        source: 'slack',
        sourceKey: 'slack:T1:C1:1700000000.1',
        sourceLabel: '#release',
        accountId: undefined,
        threadId: undefined,
        url: 'https://northwind.slack.test/archives/C1/p1',
        title: 'Review the release notes',
        asker: 'Priya Natarajan',
      }),
      NOW,
    );
    expect(slack.ref).toEqual({
      kind: 'mcp',
      id: 'slack:T1:C1:1700000000.1',
      label: 'Review the release notes',
    });
    expect(slack.framing).toEqual({
      lane: 'today',
      reason: 'Slack, #release',
      sender: 'Priya Natarajan',
    });
    expect(slack.actions).toEqual([
      {
        action: 'open_url',
        label: 'Open',
        payload: { url: 'https://northwind.slack.test/archives/C1/p1' },
        style: 'quiet',
      },
    ]);
  });

  test('an item with no place to open opens the Needs you page', () => {
    const jira = needsYouLaneItem(
      view({
        id: 'ob-jira',
        source: 'atlassian',
        sourceKey: 'atlassian:LAB-212',
        accountId: undefined,
        threadId: undefined,
        url: 'http://not-https.test/LAB-212',
        asker: '',
        title: '',
      }),
      NOW,
    );
    expect(jira.ref.kind).toBe('mcp');
    expect(jira.ref.label).toBe('Needs you');
    expect(jira.framing).toEqual({ lane: 'today', reason: 'Jira' });
    expect(jira.actions).toEqual([
      {
        action: 'open_view',
        label: 'Needs you',
        payload: { view: 'notifications', obligationId: 'ob-jira' },
        style: 'quiet',
      },
    ]);
    const orphan = needsYouLaneItem(view({ id: 'ob-x', accountId: undefined, threadId: undefined }), NOW);
    expect(orphan.ref).toEqual({ kind: 'derived', id: 'obligation:ob-x', label: orphan.ref.label });
    for (const item of [jira, orphan])
      for (const action of item.actions) expect(isKnownBriefAction(action.action)).toBe(true);
  });
});

describe('the lines of the lane', () => {
  const base = { generatedAt: NOW, timezone: ZONE };

  test('the count sentence leaves out a zero part', () => {
    expect(needsYouCountSentence(region({ open: 8, now: 2, dueToday: 2 }))).toBe(
      '8 open · 2 now · 2 due today',
    );
    expect(needsYouCountSentence(region({ open: 3, dueToday: 1 }))).toBe('3 open · 1 due today');
    expect(needsYouCountSentence(region({ open: 4 }))).toBe('4 open');
    expect(needsYouCountSentence(region())).toBe('Nothing open');
  });

  test('the closed line names what closed by itself since the last letter', () => {
    expect(needsYouClosedLine(region({ open: 5, items: [view(), view()] }), base)).toBe('');
    expect(needsYouClosedLine(region({ open: 1 }), base)).toBe(
      'None is due today. 1 open item is on the Needs you page.',
    );
    expect(needsYouClosedLine(region({ open: 4 }), base)).toBe(
      'None is due today. 4 open items are on the Needs you page.',
    );
    const closed = region({
      closedSince: [closedNote(), closedNote({ title: 'Delivery   window moved', asker: '' })],
    });
    expect(needsYouClosedLine(closed, { ...base, previousGeneratedAt: NOW - DAY })).toBe(
      'Closed by itself since yesterday’s letter: Renewal notice (Northwind Billing); Delivery window moved.',
    );
    expect(needsYouClosedLine(closed, { ...base, previousGeneratedAt: NOW - 3 * DAY })).toContain(
      'since the last letter:',
    );
    expect(needsYouClosedLine(closed, base)).toContain('Closed by itself since yesterday:');
    // The time that the region stores gives the same words as the composer.
    expect(needsYouClosedLine({ ...closed, previousGeneratedAt: NOW - DAY }, base)).toContain(
      'since yesterday’s letter:',
    );
    expect(needsYouClosedLine(region({ open: 2, closedSince: [closedNote()] }), base)).toBe(
      'None is due today. 2 open items are on the Needs you page. Closed by itself since yesterday: Renewal notice (Northwind Billing).',
    );
  });

  test('"yesterday" follows the user time zone', () => {
    // 03:00 UTC on 2026-10-30 is still 2026-10-29 in New York: yesterday’s letter.
    expect(sinceLetterPhrase(NOW, ZONE, Date.parse('2026-10-30T03:00:00Z'))).toBe('yesterday’s letter');
    expect(sinceLetterPhrase(NOW, ZONE, NOW - HOUR)).toBe('the last letter');
    expect(sinceLetterPhrase(NOW, 'Not/AZone', NOW - DAY)).toBe('yesterday’s letter');
    expect(sinceLetterPhrase(NOW, undefined, NOW - DAY)).toBe('yesterday’s letter');
    expect(sinceLetterPhrase(NOW, ZONE, null)).toBe('yesterday');
  });
});

describe('the letter region (one shape for web, iOS, and macOS)', () => {
  const options = { generatedAt: NOW, timezone: ZONE, previousGeneratedAt: NOW - DAY };

  test('the rows alone: an entity list titled "Needs you", Now items first, the count as the summary', () => {
    const built = needsYouLetterRegion(
      region({ open: 3, now: 1, dueToday: 1, items: [view(), view()] }),
      options,
    )!;
    expect(built.id).toBe('needs-you');
    expect(built.summary).toBe('3 open · 1 now · 1 due today');
    expect(built.tree).toMatchObject({ kind: 'entity_list', title: 'Needs you', emphasis: 'primary' });
    const parts = needsYouLaneParts(built.tree);
    expect(parts.closed).toBeNull();
    expect(parts.list?.items.map((item) => item.framing.lane)).toEqual(['now', 'today']);
  });

  test('with the closed line: a stack of the rows and one caption; without rows: the caption alone', () => {
    const built = needsYouLetterRegion(
      region({ open: 1, dueToday: 1, items: [view()], closedSince: [closedNote()] }),
      options,
    )!;
    expect(built.tree.kind).toBe('stack');
    const parts = needsYouLaneParts(built.tree);
    expect(parts.list?.items).toHaveLength(1);
    expect(parts.list?.items[0].framing.lane).toBe('today');
    expect(parts.closed).toBe(
      'Closed by itself since yesterday’s letter: Renewal notice (Northwind Billing).',
    );
    if (built.tree.kind !== 'stack') return;
    expect(built.tree.children.at(-1)).toMatchObject({ kind: 'text', role: 'caption' });
    const captionOnly = needsYouLetterRegion(region({ open: 2 }), options)!;
    expect(captionOnly.summary).toBe('2 open');
    expect(needsYouLaneParts(captionOnly.tree)).toEqual({
      list: null,
      closed: 'None is due today. 2 open items are on the Needs you page.',
    });
    expect(needsYouLetterRegion(region(), options)).toBeNull();
  });

  test('needsYouLaneParts reads only the list and the text of the lane', () => {
    const textNode: BriefNode = {
      kind: 'text',
      emphasis: 'standard',
      tone: 'neutral',
      role: 'body',
      text: 'x',
    };
    expect(needsYouLaneParts(textNode)).toEqual({ list: null, closed: null });
    const blank: BriefNode = {
      kind: 'stack',
      emphasis: 'standard',
      tone: 'neutral',
      density: 'standard',
      children: [{ ...textNode, text: '  ' }],
    };
    expect(needsYouLaneParts(blank)).toEqual({ list: null, closed: null });
  });
});

describe('the editorial module story', () => {
  const options = { generatedAt: NOW, timezone: ZONE, previousGeneratedAt: NOW - DAY };

  test('a group of generic nodes: the title, the count, the Now rows, "Due today", its rows, the closed line', () => {
    const letterRegion = needsYouLetterRegion(
      region({
        open: 6,
        now: 1,
        dueToday: 2,
        items: [view({ pushLevel: 'time_sensitive' }), view(), view()],
        closedSince: [closedNote()],
      }),
      options,
    )!;
    const story = needsYouEditorialStory(letterRegion)!;
    expect(story).toMatchObject({
      kind: 'group',
      title: 'Needs you',
      kicker: '6 open · 1 now · 2 due today',
      emphasis: 'primary',
      collapsible: false,
    });
    if (story.kind !== 'group') return;
    expect(story.children.map((child) => [child.kind, 'role' in child ? child.role : null])).toEqual([
      ['entity_list', null],
      ['text', 'kicker'],
      ['entity_list', null],
      ['text', 'caption'],
    ]);
    const [now, label, today, caption] = story.children;
    expect(now.kind === 'entity_list' && now.items).toHaveLength(1);
    expect(label.kind === 'text' && label.text).toBe('Due today');
    expect(today.kind === 'entity_list' && today.items).toHaveLength(2);
    expect(caption.kind === 'text' && caption.text).toContain('Closed by itself since yesterday’s letter:');
    // The rows show no lane word: the kicker carries the split.
    for (const list of [now, today])
      if (list.kind === 'entity_list')
        for (const item of list.items) expect(item.framing).not.toHaveProperty('lane');
    // The story is two levels deep, so the writer can place it at its deepest level.
    const document = parseBriefDocument({
      version: 2,
      title: 'x',
      summary: 'x',
      generatedAt: NOW,
      timezone: ZONE,
      regions: [
        {
          id: 'editorial-x',
          summary: 'x',
          tree: {
            kind: 'stack',
            emphasis: 'standard',
            tone: 'neutral',
            density: 'standard',
            children: [
              {
                kind: 'stack',
                emphasis: 'standard',
                tone: 'neutral',
                density: 'standard',
                children: [story],
              },
            ],
          },
        },
      ],
    });
    expect(lintBriefDocument(document)).toEqual([]);
    expect(document.regions[0].tree).toMatchObject({ children: [{ children: [{ kind: 'group' }] }] });
  });

  test('only Today rows, or only the caption, or another region', () => {
    const todayOnly = needsYouEditorialStory(
      needsYouLetterRegion(region({ open: 1, dueToday: 1, items: [view()] }), options)!,
    )!;
    expect(todayOnly.kind === 'group' && todayOnly.children.map((child) => child.kind)).toEqual([
      'entity_list',
    ]);
    const captionOnly = needsYouEditorialStory(needsYouLetterRegion(region({ open: 2 }), options)!)!;
    expect(captionOnly.kind === 'group' && captionOnly.children.map((child) => child.kind)).toEqual(['text']);
    expect(needsYouEditorialStory(text('answer'))).toBeNull();
    expect(
      needsYouEditorialStory({
        id: 'needs-you',
        summary: 'x',
        tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: 'x' },
      }),
    ).toBeNull();
  });
});

function text(id: string, value = `The ${id} text.`): BriefRegion {
  return {
    id,
    summary: value,
    tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: value },
  };
}

function lane(
  id: string,
  items: Array<{ kind: 'thread' | 'event'; id: string; account?: string }>,
): BriefRegion {
  return {
    id,
    summary: `${id}: ${items.length} items.`,
    tree: {
      kind: 'entity_list',
      emphasis: 'standard',
      tone: 'neutral',
      title: id,
      variant: 'rows',
      items: items.map((ref) => ({
        ref: { ...ref, label: ref.id },
        framing: { lane: id },
        actions: [{ action: 'open_thread', label: 'Open', payload: { threadId: ref.id }, style: 'quiet' }],
      })),
    },
  } as BriefRegion;
}

function letter(regions: BriefRegion[]): BriefDocumentV2 {
  return parseBriefDocument({
    version: 2,
    title: 'Friday, October 30',
    summary: 'The day.',
    generatedAt: NOW,
    timezone: ZONE,
    regions,
  });
}

describe('placeNeedsYouLane', () => {
  const options = { generatedAt: NOW, timezone: ZONE, previousGeneratedAt: NOW - DAY };

  test('takes the place of the answer lane and takes its threads out of Today, Know, and Waiting', () => {
    const mail = view({ accountId: 'acct', threadId: 'shared', pushLevel: 'time_sensitive' });
    const built = region({ open: 3, now: 1, items: [mail], closedSince: [closedNote()] });
    const document = letter([
      text('lede'),
      lane('answer', [{ kind: 'thread', id: 'answer-only', account: 'acct' }]),
      lane('today', [
        { kind: 'event', id: 'evt-1', account: 'acct' },
        { kind: 'thread', id: 'shared', account: 'acct' },
      ]),
      lane('know', [{ kind: 'thread', id: 'shared', account: 'acct' }]),
      lane('waiting', [{ kind: 'thread', id: 'other', account: 'acct' }]),
      text('week-ahead'),
    ]);
    const placed = placeNeedsYouLane(document, built, options);
    expect(placed.regions.map((entry) => entry.id)).toEqual([
      'lede',
      'needs-you',
      'today',
      'waiting',
      'week-ahead',
    ]);
    const today = placed.regions[2].tree;
    expect(today.kind === 'entity_list' && today.items.map((item) => item.ref.id)).toEqual(['evt-1']);
    const waiting = placed.regions[3];
    expect(waiting).toEqual(document.regions[4]);
    expect(placed.regions[1].summary).toBe('3 open · 1 now');
    expect(needsYouLaneParts(placed.regions[1].tree).closed).toBe(
      'Closed by itself since yesterday’s letter: Renewal notice (Northwind Billing).',
    );
    // A letter that has the lane already (a live refresh) gets it once.
    expect(placeNeedsYouLane(placed, built, options).regions.map((entry) => entry.id)).toEqual(
      placed.regions.map((entry) => entry.id),
    );
  });

  test('without an answer lane it goes before the first later region, or at the end', () => {
    const built = region({ open: 1, items: [view()] });
    const before = placeNeedsYouLane(
      letter([text('lede'), text('yesterday'), text('week-ahead')]),
      built,
      options,
    );
    expect(before.regions.map((entry) => entry.id)).toEqual(['lede', 'yesterday', 'needs-you', 'week-ahead']);
    const end = placeNeedsYouLane(letter([text('lede')]), built, options);
    expect(end.regions.map((entry) => entry.id)).toEqual(['lede', 'needs-you']);
    // A user with nothing open and nothing closed: the answer lane goes and nothing takes its place.
    const empty = placeNeedsYouLane(
      letter([
        text('lede'),
        lane('answer', [{ kind: 'thread', id: 'a', account: 'acct' }]),
        text('week-ahead'),
      ]),
      region(),
      options,
    );
    expect(empty.regions.map((entry) => entry.id)).toEqual(['lede', 'week-ahead']);
  });

  test('without a region the document does not change', () => {
    const document = letter([text('lede'), lane('answer', [{ kind: 'thread', id: 'a', account: 'acct' }])]);
    expect(placeNeedsYouLane(document, null, options)).toBe(document);
    expect(placeNeedsYouLane(document, undefined, options)).toBe(document);
  });

  test('a full letter keeps the region limit', () => {
    const ids = ['lede', 'yesterday', 'since', 'today', 'know', 'waiting', 'tasks', 'connected'];
    const document = letter([
      ...ids.map((id) => text(id)),
      text('week-ahead'),
      text('areas'),
      text('extra'),
      text('last'),
    ]);
    expect(document.regions).toHaveLength(12);
    const placed = placeNeedsYouLane(document, region({ open: 4, items: [view()] }), options);
    // The lane takes its place early; the last region goes.
    expect(placed.regions).toHaveLength(12);
    expect(placed.regions[3].id).toBe('needs-you');
    expect(placed.regions.at(-1)?.id).toBe('extra');
  });

  test('parseBriefDocument keeps the lane, its framing, and its actions', () => {
    const built = region({
      open: 2,
      now: 1,
      items: [
        view({ kind: 'reply', workId: 'work-1', createdAt: NOW - 2 * DAY }),
        view({
          source: 'github',
          sourceKey: 'github:northwind/web#482',
          sourceLabel: 'northwind/web #482',
          accountId: undefined,
          threadId: undefined,
          url: 'https://github.test/northwind/web/pull/482',
        }),
      ],
      closedSince: [closedNote()],
    });
    const placed = placeNeedsYouLane(letter([text('lede'), text('week-ahead')]), built, options);
    const reread = parseBriefDocument(JSON.parse(JSON.stringify(placed)));
    expect(reread).toEqual(placed);
    const needsYou = reread.regions.find((entry) => entry.id === 'needs-you')!;
    expect(needsYou.tree.kind).toBe('stack');
    const parts = needsYouLaneParts(needsYou.tree);
    expect(parts.list?.title).toBe('Needs you');
    expect(parts.list?.items[0].framing).toMatchObject({
      lane: 'now',
      sender: 'Dana Whitfield',
      age: 'Day 3',
    });
    expect(parts.list?.items[1].framing.lane).toBe('today');
    expect(parts.list?.items[0].actions.map((action) => action.action)).toEqual([
      'open_thread',
      'draft_reply',
      'open_work',
    ]);
    expect(parts.list?.items[1].actions.map((action) => action.action)).toEqual(['open_url']);
    expect(parts.closed).toContain('Closed by itself since');
  });
});

describe('the stored region', () => {
  const stored = region({ open: 1, now: 1, items: [view()], closedSince: [closedNote()] });

  test('parse keeps a region and drops what does not have its shape', () => {
    expect(parseBriefNeedsYouRegion(stored)).toEqual(stored);
    for (const bad of [
      null,
      'needs-you',
      { ...stored, id: 'answer' },
      { ...stored, open: '1' },
      { ...stored, now: Number.NaN },
      { ...stored, dueToday: undefined },
      { ...stored, items: 'x' },
      { ...stored, closedSince: {} },
    ])
      expect(parseBriefNeedsYouRegion(bad)).toBeUndefined();
    const mixed = parseBriefNeedsYouRegion({
      ...stored,
      items: [null, { id: 1 }, stored.items[0]],
      closedSince: [{ id: 'x' }, stored.closedSince[0], null],
    });
    expect(mixed?.items).toEqual(stored.items);
    expect(mixed?.closedSince).toEqual(stored.closedSince);
  });

  test('editionNeedsYou and the read migration keep it', () => {
    expect(editionNeedsYou({ sections: { needsYou: stored } as any })).toEqual(stored);
    expect(editionNeedsYou({ sections: {} as any })).toBeNull();
    expect(editionNeedsYou({ sections: undefined as any })).toBeNull();
    expect(needsYouSectionOf({ needsYou: stored })).toEqual({ needsYou: stored });
    expect(needsYouSectionOf({ needsYou: { id: 'other' } })).toEqual({});
    expect(needsYouSectionOf(undefined)).toEqual({});

    const { edition } = editorialFixture();
    const read = migrateDailyReport({
      ...edition,
      sections: { ...edition.sections, needsYou: stored },
    } as any);
    expect(editionNeedsYou(read)).toEqual(stored);
    expect(editionNeedsYou(migrateDailyReport(edition))).toBeNull();
  });

  test('storage keeps it, also when the edition must shrink', () => {
    const { edition } = editorialFixture();
    const read = migrateDailyReport(edition);
    const report = {
      ...read,
      artifactSource: 'document-v2' as const,
      artifactStatus: 'ready' as const,
      sections: { ...read.sections, needsYou: stored },
    } as DailyReport;
    expect(editionNeedsYou(dailyReportForStorage(report))).toEqual(stored);
    // An edition over the ceiling drops overflow, legacy lanes, and at last its page; the region stays.
    const huge = {
      ...report,
      document: { ...report.document!, summary: 'x' },
      sections: {
        ...report.sections,
        overflow: Array.from({ length: 1 }, () => ({ ...read.sections.answer?.[0] })),
        replyOwed: [{ ...(read.sections.replyOwed[0] ?? {}), whyItMatters: 'y'.repeat(950_000) }],
      },
    } as DailyReport;
    const shrunk = dailyReportForStorage(huge);
    expect(shrunk.artifactErrors?.some((error) => /too large/.test(error.message))).toBe(true);
    expect(editionNeedsYou(shrunk)).toEqual(stored);
  });
});

function report(): DailyReport {
  const { edition } = editorialFixture();
  return { ...migrateDailyReport(edition), generatedAt: NOW };
}

describe('withBriefNeedsYou', () => {
  const snapshot = {
    enabled: true,
    timezone: ZONE,
    items: [view({ pushLevel: 'time_sensitive', title: 'Fix the failed payment' })],
  };

  test('outside the flag, without a user, or with the ledger off: the edition does not change', async () => {
    const base = report();
    setBriefNeedsYouLoaderForTest({ flag: () => false });
    expect(await withBriefNeedsYou(base, 'u1', NOW - DAY)).toBe(base);
    expect(await withBriefNeedsYou(base, null, NOW - DAY)).toBe(base);
    setBriefNeedsYouLoaderForTest({
      flag: () => true,
      snapshot: async () => ({ enabled: false, timezone: 'UTC', items: [] }),
    });
    expect(await withBriefNeedsYou(base, 'u1', NOW - DAY)).toBe(base);
  });

  test('in the flag: the edition gets the region, with the closed items since the previous edition', async () => {
    const calls: any[] = [];
    setBriefNeedsYouLoaderForTest({
      flag: (userId) => userId === 'u1',
      snapshot: async () => snapshot,
      closedSince: async (userId, since) => {
        calls.push({ userId, since });
        return [closedNote()];
      },
    });
    const next = await withBriefNeedsYou(report(), 'u1', NOW - DAY, NOW - DAY + HOUR);
    expect(calls).toEqual([{ userId: 'u1', since: NOW - DAY }]);
    const stored = editionNeedsYou(next)!;
    expect(stored.items.map((item) => item.title)).toEqual(['Fix the failed payment']);
    expect(stored.closedSince).toHaveLength(1);
    // The region keeps the time of the previous edition for the closed line.
    expect(stored.previousGeneratedAt).toBe(NOW - DAY + HOUR);
    expect(parseBriefNeedsYouRegion(stored)?.previousGeneratedAt).toBe(NOW - DAY + HOUR);
    expect(editionNeedsYou(await withBriefNeedsYou(report(), 'u1', NOW - DAY))).not.toHaveProperty(
      'previousGeneratedAt',
    );
    setBriefNeedsYouLoaderForTest({
      flag: () => true,
      snapshot: async () => snapshot,
      closedSince: async () => null as any,
    });
    expect(editionNeedsYou(await withBriefNeedsYou(report(), 'u1', NOW - DAY))?.closedSince).toEqual([]);
  });

  test('a failed ledger read keeps the answer lane; the real reads fail closed without Convex', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = report();
      setBriefNeedsYouLoaderForTest({
        flag: () => true,
        snapshot: async () => {
          throw new Error('Convex down');
        },
      });
      expect(await withBriefNeedsYou(base, 'u1', NOW - DAY)).toBe(base);
      // The real snapshot read: no Convex in tests, so it throws and the edition keeps `answer`.
      setBriefNeedsYouLoaderForTest({ flag: () => true });
      expect(await withBriefNeedsYou(base, 'u1', NOW - DAY)).toBe(base);
      setBriefNeedsYouLoaderForTest({ flag: () => true, snapshot: async () => snapshot });
      expect(await withBriefNeedsYou(base, 'u1', NOW - DAY)).toBe(base);
      expect(warn).toHaveBeenCalledTimes(3);
      // The real flag reads LAB86_NEEDS_YOU.
      const previous = process.env.LAB86_NEEDS_YOU;
      process.env.LAB86_NEEDS_YOU = '';
      setBriefNeedsYouLoaderForTest();
      expect(await withBriefNeedsYou(base, 'u1', NOW - DAY)).toBe(base);
      if (previous === undefined) delete process.env.LAB86_NEEDS_YOU;
      else process.env.LAB86_NEEDS_YOU = previous;
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the daily edition', () => {
  // The pipeline logs that tests have no Convex for the calendar and tasks.
  let quiet: ReturnType<typeof spyOn> | undefined;
  beforeEach(() => {
    quiet = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => quiet?.mockRestore());

  test('a flag user gets the needs-you lane in place of answer; the stored edition keeps the region', async () => {
    setBriefNeedsYouLoaderForTest({
      flag: (userId) => userId === 'needs-you-owner',
      snapshot: async () => ({
        enabled: true,
        timezone: ZONE,
        items: [
          view({
            pushLevel: 'time_sensitive',
            title: 'Fix the failed payment',
            asker: 'Northwind Billing',
            createdAt: Date.now() - HOUR,
          }),
        ],
      }),
      closedSince: async () => [closedNote()],
    });
    const edition = await withToolContext(
      () =>
        generateAgentReport({
          kind: 'manual',
          userId: 'needs-you-owner',
          reportId: 'needs-you-edition',
          deterministic: true,
        }),
      { userId: 'needs-you-owner' },
    );
    expect(editionNeedsYou(edition)?.items.map((item) => item.title)).toEqual(['Fix the failed payment']);
    const ids = edition.document?.regions.map((entry) => entry.id) ?? [];
    expect(edition.document?.layout).toBe('editorial');
    expect(ids).toContain('editorial-needs-you');
    expect(ids).not.toContain('editorial-needs-you-note');
    expect(ids).not.toContain('editorial-answer');
    // The lane is one module: a group titled "Needs you" with its count and closed line.
    const lane = edition.document!.regions.find((entry) => entry.id === 'editorial-needs-you')!;
    const group = lane.tree.kind === 'stack' ? lane.tree.children[0] : lane.tree;
    expect(group).toMatchObject({ kind: 'group', title: 'Needs you', kicker: '1 open · 1 now' });
    expect(JSON.stringify(group)).toContain('Closed by itself since yesterday:');
    const stored = await withToolContext(() => getDailyReport('needs-you-edition'), {
      userId: 'needs-you-owner',
    });
    expect(editionNeedsYou(stored!)?.items).toHaveLength(1);
  });

  test('a user outside the flag keeps answer and has no region', async () => {
    setBriefNeedsYouLoaderForTest({ flag: () => false });
    const edition = await withToolContext(
      () =>
        generateAgentReport({
          kind: 'manual',
          userId: 'answer-owner',
          reportId: 'answer-edition',
          deterministic: true,
        }),
      { userId: 'answer-owner' },
    );
    expect(editionNeedsYou(edition)).toBeNull();
    expect(edition.document?.regions.map((entry) => entry.id) ?? []).not.toContain('editorial-needs-you');
  });
});

describe('the editorial edition (the form real daily editions take)', () => {
  // The fixture letter of tests/fixtures/editorial.ts, with the lane of a flag
  // user in the place of Answer. thread-a is in both the lane and Answer.
  function needsYouEdition() {
    const { edition, letter } = editorialFixture();
    const stored = region({
      open: 3,
      now: 1,
      dueToday: 1,
      items: [
        view({ accountId: 'account-a', threadId: 'thread-a', title: 'Approve the launch budget' }),
        view({ source: 'slack', sourceKey: 'slack:T:C:1', accountId: undefined, threadId: undefined }),
      ],
      closedSince: [closedNote()],
      previousGeneratedAt: JEV_NOW - DAY,
    });
    const options = { generatedAt: edition.generatedAt, timezone: 'America/New_York' };
    const placed = placeNeedsYouLane(letter, stored, options);
    const withLane = { ...edition, sections: { ...edition.sections, needsYou: stored } } as DailyReport;
    const modules = editorialModules(withLane, placed);
    const plan = defaultEditorialPlan(modules);
    return {
      edition: {
        ...withLane,
        document: composeEditorialDocument(placed, modules, plan),
        editorial: { plan, mode: 'fallback' as const },
      } as DailyReport,
      modules,
    };
  }

  test('the lane is one module, and its region holds the group', () => {
    const { edition, modules } = needsYouEdition();
    const lane = modules.find((module) => module.id === 'needs-you')!;
    expect(lane).toMatchObject({
      section: 'needs-you',
      title: 'Needs you',
      summary: '3 open · 1 now · 1 due today',
    });
    expect(modules.filter((module) => module.section === 'needs-you')).toHaveLength(1);
    expect(modules.some((module) => module.section === 'answer')).toBe(false);
    const ids = edition.document!.regions.map((entry) => entry.id);
    expect(ids).toContain('editorial-needs-you');
    expect(ids).not.toContain('editorial-answer');
    expect(lintBriefDocument(edition.document!)).toEqual([]);
    expect(briefLetterKind(edition.document!)).toBeNull();
  });

  test('a live refresh keeps the lane in the place of Answer, with no live-updates region', () => {
    const { edition } = needsYouEdition();
    const read = migrateDailyReport(edition, JEV_NOW);
    expect(editionNeedsYou(read)?.items).toHaveLength(2);
    const live = projectBriefMail(
      read,
      [thread({ jev: jevAssessment({ sourceRevision: 'updated-request' }) })],
      policy,
      JEV_NOW + 2000,
    );
    const ids = live.document!.regions.map((entry) => entry.id);
    expect(ids).toContain('editorial-needs-you');
    expect(ids).not.toContain('live-updates');
    expect(ids).not.toContain('editorial-answer');
    expect(live.editorial?.plan).toEqual(edition.editorial?.plan);
    const lane = live.document!.regions.find((entry) => entry.id === 'editorial-needs-you')!;
    expect(JSON.stringify(lane)).toContain('Closed by itself since yesterday’s letter:');
    // thread-a shows once: in the lane, not again in another lane.
    const threadRefs = JSON.stringify(live.document).match(/"id":"thread-a"/g) ?? [];
    expect(threadRefs).toHaveLength(1);
  });

  test('the fallback plan of a full letter fits the editorial region limit', () => {
    const ids = ['lede', 'yesterday', 'since', 'needs-you', 'today', 'know', 'waiting', 'tasks', 'connected'];
    const full = letter([
      ...ids.map((id) =>
        id === 'needs-you' ? needsYouLetterRegion(region({ open: 1 }), { generatedAt: NOW })! : text(id),
      ),
      text('week-ahead'),
      text('areas'),
      text('pulse'),
    ]);
    expect(full.regions).toHaveLength(12);
    const modules = editorialModules(report(), full);
    // Twelve letter regions and the two live sections.
    expect(new Set(modules.map((module) => module.section)).size).toBe(14);
    const plan = defaultEditorialPlan(modules);
    expect(plan.regions).toHaveLength(EDITORIAL_REGION_LIMIT);
    expect(plan.regions.at(-1)?.id).toBe('pulse');
    const document = composeEditorialDocument(full, modules, plan);
    expect(document.regions).toHaveLength(EDITORIAL_REGION_LIMIT);
    expect(lintBriefDocument(document)).toEqual([]);
    // A short letter keeps one region for each section.
    const short = editorialModules(report(), letter([text('lede'), text('week-ahead')]));
    expect(defaultEditorialPlan(short).regions.map((entry) => entry.id)).toEqual([
      'lede',
      'week-ahead',
      'narrative',
      'prepared-work',
    ]);
  });
});

describe('the fallback letter of a stored edition', () => {
  test('the edition of a flag user shows the lane in the place of Answer; others keep Answer', () => {
    const answer = [{ account: 'acct', threadId: 'thread-a', subject: 'Approve the budget' }];
    const base = { generatedAt: NOW, prose: { lede: 'The day.' }, sections: { answer, today: [], know: [] } };
    expect(briefLetterFromReport(base, { timezone: ZONE }).regions.map((entry) => entry.id)).toEqual([
      'lede',
      'answer',
    ]);
    const stored = region({ open: 1, now: 1, items: [view({ accountId: 'acct', threadId: 'thread-a' })] });
    const withLane = briefLetterFromReport(
      { ...base, sections: { ...base.sections, needsYou: stored } },
      { timezone: ZONE },
    );
    expect(withLane.regions.map((entry) => entry.id)).toEqual(['lede', 'needs-you']);
    expect(briefLetterKind(withLane)).toBe('daily');
    // A stored value without the region shape is left out.
    expect(
      briefLetterFromReport(
        { ...base, sections: { ...base.sections, needsYou: { id: 'x' } } },
        { timezone: ZONE },
      ).regions.map((entry) => entry.id),
    ).toEqual(['lede', 'answer']);
  });
});
