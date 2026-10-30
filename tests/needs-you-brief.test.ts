import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import './tools/harness';
import { generateAgentReport } from '../lib/mail/agent-report';
import {
  BRIEF_NEEDS_YOU_BYTE_LIMIT,
  BRIEF_NEEDS_YOU_CLOSED_LIMIT,
  buildBriefNeedsYouRegion,
  editionNeedsYou,
  NEEDS_YOU_LANE_ID,
  NEEDS_YOU_NOTE_ID,
  needsYouLaneItem,
  needsYouNoteText,
  needsYouRegions,
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
import { type BriefDocumentV2, type BriefRegion, parseBriefDocument } from '../lib/shared/brief-document';
import type { DailyReport } from '../lib/shared/types';
import { dailyReportForStorage, getDailyReport, migrateDailyReport } from '../lib/store/daily-reports';
import { editorialFixture } from './fixtures/editorial';
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
    );
    expect(item).toEqual({
      ref: { kind: 'thread', id: 'thread-9', account: 'acct', label: 'Could you confirm the start date?' },
      framing: {
        lane: 'needs-you',
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
      lane: 'needs-you',
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
    expect(jira.framing).toEqual({ lane: 'needs-you', reason: 'Jira' });
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

describe('the note line', () => {
  test('names the other open items, and what closed by itself since the last letter', () => {
    const base = { generatedAt: NOW, timezone: ZONE };
    const withItems = region({ open: 5, items: [view(), view()] });
    expect(needsYouNoteText(withItems, base)).toBe('3 other open items are on the Needs you page.');
    expect(needsYouNoteText(region({ open: 2, items: [view()] }), base)).toBe(
      '1 other open item is on the Needs you page.',
    );
    expect(needsYouNoteText(region({ open: 1 }), base)).toBe(
      '1 open item is on the Needs you page. None is due today.',
    );
    expect(needsYouNoteText(region({ open: 4 }), base)).toBe(
      '4 open items are on the Needs you page. None is due today.',
    );
    expect(needsYouNoteText(region({ open: 1, items: [view()] }), base)).toBe('');
    const closed = region({
      closedSince: [closedNote(), closedNote({ title: 'Delivery   window moved', asker: '' })],
    });
    expect(needsYouNoteText(closed, { ...base, previousGeneratedAt: NOW - DAY })).toBe(
      "Closed by itself since yesterday's letter: Renewal notice (Northwind Billing); Delivery window moved.",
    );
    expect(needsYouNoteText(closed, { ...base, previousGeneratedAt: NOW - 3 * DAY })).toContain(
      'since the last letter:',
    );
    expect(needsYouNoteText(closed, base)).toContain('Closed by itself since yesterday:');
  });

  test('"yesterday" follows the user time zone', () => {
    // 03:00 UTC on 2026-10-30 is still 2026-10-29 in New York: yesterday's letter.
    expect(sinceLetterPhrase(NOW, ZONE, Date.parse('2026-10-30T03:00:00Z'))).toBe("yesterday's letter");
    expect(sinceLetterPhrase(NOW, ZONE, NOW - HOUR)).toBe('the last letter');
    expect(sinceLetterPhrase(NOW, 'Not/AZone', NOW - DAY)).toBe("yesterday's letter");
    expect(sinceLetterPhrase(NOW, ZONE, null)).toBe('yesterday');
  });

  test('the regions: the lane when it has items, then the note when it has text', () => {
    const options = { generatedAt: NOW, timezone: ZONE };
    expect(needsYouRegions(region(), options)).toEqual([]);
    const regions = needsYouRegions(
      region({ open: 3, now: 1, dueToday: 1, items: [view(), view()] }),
      options,
    );
    expect(regions.map((entry) => entry.id)).toEqual([NEEDS_YOU_LANE_ID, NEEDS_YOU_NOTE_ID]);
    expect(regions[0].summary).toBe('Needs you: 1 now, 1 due today, 3 open.');
    expect(regions[0].tree).toMatchObject({ kind: 'entity_list', title: 'Needs you', emphasis: 'primary' });
    expect(regions[1].tree).toEqual({
      kind: 'text',
      emphasis: 'muted',
      tone: 'neutral',
      role: 'aside',
      text: '1 other open item is on the Needs you page.',
    });
    expect(needsYouRegions(region({ open: 2 }), options).map((entry) => entry.id)).toEqual([
      NEEDS_YOU_NOTE_ID,
    ]);
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
      'needs-you-note',
      'today',
      'waiting',
      'week-ahead',
    ]);
    const today = placed.regions[3].tree;
    expect(today.kind === 'entity_list' && today.items.map((item) => item.ref.id)).toEqual(['evt-1']);
    const waiting = placed.regions[4];
    expect(waiting).toEqual(document.regions[4]);
    expect(placed.regions[2].tree).toMatchObject({
      text: "2 other open items are on the Needs you page. Closed by itself since yesterday's letter: Renewal notice (Northwind Billing).",
    });
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

  test('a full letter keeps the region limit: the note goes first', () => {
    const ids = ['lede', 'yesterday', 'since', 'answer', 'today', 'know', 'waiting', 'tasks', 'connected'];
    const document = letter([...ids.map((id) => text(id)), text('week-ahead'), text('areas'), text('extra')]);
    const placed = placeNeedsYouLane(document, region({ open: 4, items: [view()] }), options);
    expect(placed.regions).toHaveLength(12);
    expect(placed.regions.map((entry) => entry.id)).not.toContain('needs-you-note');
    expect(placed.regions[3].id).toBe('needs-you');
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
    expect(needsYou.tree.kind).toBe('entity_list');
    if (needsYou.tree.kind !== 'entity_list') return;
    expect(needsYou.tree.title).toBe('Needs you');
    expect(needsYou.tree.items[0].framing).toMatchObject({
      lane: 'needs-you',
      sender: 'Dana Whitfield',
      age: 'Day 3',
    });
    expect(needsYou.tree.items[0].actions.map((action) => action.action)).toEqual([
      'open_thread',
      'draft_reply',
      'open_work',
    ]);
    expect(needsYou.tree.items[1].actions.map((action) => action.action)).toEqual(['open_url']);
    expect(reread.regions.find((entry) => entry.id === 'needs-you-note')?.tree.kind).toBe('text');
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
    const next = await withBriefNeedsYou(report(), 'u1', NOW - DAY);
    expect(calls).toEqual([{ userId: 'u1', since: NOW - DAY }]);
    const stored = editionNeedsYou(next)!;
    expect(stored.items.map((item) => item.title)).toEqual(['Fix the failed payment']);
    expect(stored.closedSince).toHaveLength(1);
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
    expect(ids).toContain('editorial-needs-you');
    expect(ids).toContain('editorial-needs-you-note');
    expect(ids).not.toContain('editorial-answer');
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
