import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

// Needs you phases 3 and 5 (S2): the ledger readers in convex/obligationViews.ts.
// Invented people and companies only.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/obligationViews.ts': () => import('../convex/obligationViews'),
  '../convex/obligations.ts': () => import('../convex/obligations'),
};
const SECRET = 'synthetic-needs-you-views';
const USER = 'owner';
const OTHER = 'someone-else';
// 15:00 UTC on 2026-10-30; the user's day starts at 04:00 UTC (New York).
const CLOCK = Date.parse('2026-10-30T15:00:00Z');
const DAY_START = Date.parse('2026-10-30T04:00:00Z');
const views = (api as any).obligationViews;

let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
beforeEach(() => setSystemTime(new Date(CLOCK)));
afterAll(() => {
  setSystemTime();
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

const harness = () => convexTest(schema, modules);
type T = TestConvex<typeof schema>;

async function flag(t: T, userId = USER, enabled = true) {
  await t.run(async (ctx) => {
    await ctx.db.insert('userDocs', {
      userId,
      kind: 'needsYouFlag',
      key: 'default',
      doc: { enabled },
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
  });
}

async function timezone(t: T, userId = USER, zone = 'America/New_York') {
  await t.run(async (ctx) => {
    await ctx.db.insert('albatrossNotificationPreferences', {
      userId,
      timezone: zone,
      eveningCheckinEnabled: false,
      eveningCheckinLocalTime: '20:00',
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: false,
      emailFallbackDelayMinutes: 90,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
  });
}

let counter = 0;
async function row(t: T, patch: Record<string, unknown> = {}): Promise<Id<'obligations'>> {
  counter += 1;
  return t.run((ctx) =>
    ctx.db.insert('obligations', {
      userId: USER,
      kind: 'reply',
      state: 'open',
      source: 'mail',
      sourceKey: `mail:acct:thread-${counter}`,
      accountId: 'acct',
      threadId: `thread-${counter}`,
      messageId: `m-${counter}`,
      title: `Confirm the start date ${counter}`,
      asker: 'Dana Whitfield',
      due: 'soon',
      probability: 0.95,
      pushLevel: 'normal',
      openedAt: CLOCK - 3_600_000,
      createdAt: CLOCK - 3_600_000,
      updatedAt: CLOCK - 3_600_000,
      ...patch,
    } as any),
  );
}

async function work(t: T, patch: Record<string, unknown> = {}): Promise<Id<'albatrossIntents'>> {
  return t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId: USER,
      rawText: 'Renew the Northwind contract before December',
      source: 'text',
      status: 'applied',
      title: 'Renew the Northwind contract',
      createdAt: CLOCK - 86_400_000,
      updatedAt: CLOCK - 86_400_000,
      ...patch,
    } as any),
  );
}

describe('obligationViews.forWork', () => {
  test('needs a signed-in user in the flag', async () => {
    const t = harness();
    const workId = await work(t);
    await row(t, { workId: String(workId) });
    expect(await t.query(views.forWork, { workId: String(workId) })).toEqual([]);
    expect(await t.withIdentity({ subject: USER }).query(views.forWork, { workId: String(workId) })).toEqual(
      [],
    );
    await flag(t, USER, false);
    expect(await t.withIdentity({ subject: USER }).query(views.forWork, { workId: String(workId) })).toEqual(
      [],
    );
  });

  test('gives the open items of that Work and the items closed today, newest last, for the caller only', async () => {
    const t = harness();
    await flag(t);
    await timezone(t);
    const workId = String(await work(t));
    const otherWork = String(await work(t, { title: 'Plan the offsite' }));
    const newer = await row(t, {
      workId,
      workTitle: 'Renew the Northwind contract',
      createdAt: CLOCK - 60_000,
      source: 'slack',
      sourceKey: 'slack:T1:C1:1',
      sourceLabel: '#release',
      url: 'https://northwind.slack.test/archives/C1/p1',
      accountId: undefined,
      threadId: undefined,
      messageId: undefined,
    });
    const older = await row(t, {
      workId,
      createdAt: CLOCK - 7_200_000,
      state: 'snoozed',
      snoozedUntil: CLOCK + 1,
    });
    const closedToday = await row(t, {
      workId,
      createdAt: CLOCK - 5_000_000,
      state: 'resolved',
      closeReason: 'evidence',
      closedBy: 'source',
      closedAt: DAY_START + 60_000,
    });
    await row(t, {
      workId,
      state: 'done',
      closeReason: 'user_done',
      closedBy: 'user',
      closedAt: DAY_START - 60_000,
    });
    await row(t, { workId: otherWork });
    await row(t, { workId, userId: OTHER });
    await row(t);

    const items = await t.withIdentity({ subject: USER }).query(views.forWork, { workId });
    expect(items.map((item: any) => item.id)).toEqual([String(older), String(closedToday), String(newer)]);
    expect(items[2]).toMatchObject({
      workId,
      workTitle: 'Renew the Northwind contract',
      source: 'slack',
      sourceLabel: '#release',
      url: 'https://northwind.slack.test/archives/C1/p1',
    });
    expect(items[0]).toMatchObject({ state: 'snoozed', snoozedUntil: CLOCK + 1 });
    expect(items[1]).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
    expect(await t.withIdentity({ subject: USER }).query(views.forWork, { workId: '  ' })).toEqual([]);
    // Another user sees none of the owner's items for the same Work id.
    await flag(t, OTHER);
    const theirs = await t.withIdentity({ subject: OTHER }).query(views.forWork, { workId });
    expect(theirs).toHaveLength(1);
    expect(theirs[0].id).not.toBe(String(newer));
  });

  test('a calendar row carries its event', async () => {
    const t = harness();
    await flag(t);
    const workId = String(await work(t));
    await row(t, {
      workId,
      kind: 'rsvp',
      source: 'calendar',
      sourceKey: 'calendar:acct:evt-1',
      eventId: 'evt-1',
      eventStart: CLOCK + 86_400_000,
      threadId: undefined,
      messageId: undefined,
    });
    const [item] = await t.withIdentity({ subject: USER }).query(views.forWork, { workId });
    expect(item).toMatchObject({ kind: 'rsvp', eventId: 'evt-1', eventStart: CLOCK + 86_400_000 });
  });
});

describe('obligationViews.snapshotFor', () => {
  test('needs the server secret', async () => {
    const t = harness();
    await expect(t.query(views.snapshotFor, { userId: USER })).rejects.toThrow(/internal secret/i);
    await expect(t.query(views.snapshotFor, { internalSecret: 'wrong', userId: USER })).rejects.toThrow(
      /internal secret/i,
    );
  });

  test('outside the flag: enabled false, the time zone, and no items', async () => {
    const t = harness();
    await timezone(t);
    await row(t);
    expect(await t.query(views.snapshotFor, { internalSecret: SECRET, userId: USER })).toEqual({
      enabled: false,
      timezone: 'America/New_York',
      items: [],
    });
    expect(await t.query(views.snapshotFor, { internalSecret: SECRET, userId: OTHER })).toEqual({
      enabled: false,
      timezone: 'UTC',
      items: [],
    });
  });

  test('in the flag: the open, snoozed, and closed-today items of that user, with the code value', async () => {
    const t = harness();
    await flag(t);
    await timezone(t);
    const open = await row(t);
    const snoozed = await row(t, { state: 'snoozed', snoozedUntil: CLOCK + 3_600_000 });
    const closed = await row(t, {
      state: 'done',
      closeReason: 'sent_reply',
      closedBy: 'user',
      closedAt: CLOCK - 60_000,
    });
    await row(t, { state: 'done', closeReason: 'user_done', closedAt: DAY_START - 1 });
    await row(t, { userId: OTHER });
    const codeId = await t.run((ctx) =>
      ctx.db.insert('mailOneTimeCodes', {
        userId: USER,
        accountId: 'acct',
        providerThreadId: 'code-thread',
        providerMessageId: 'code-message',
        code: '482913',
        label: 'Sign-in code',
        issuer: 'Northwind',
        serviceIdentifiers: ['northwind.test'],
        confidence: 0.99,
        status: 'active',
        receivedAt: CLOCK - 30_000,
        expiresAt: CLOCK + 300_000,
        createdAt: CLOCK - 30_000,
        updatedAt: CLOCK - 30_000,
      } as any),
    );
    const code = await row(t, {
      kind: 'code',
      pushLevel: 'time_sensitive',
      codeId,
      codeExpiresAt: CLOCK + 300_000,
      sourceKey: 'mail:acct:code-thread',
    });
    // A code that expired before today is not in today's list.
    await row(t, {
      kind: 'code',
      codeExpiresAt: DAY_START - 600_000,
      sourceKey: 'mail:acct:old-code',
    });

    const snapshot = await t.query(views.snapshotFor, { internalSecret: SECRET, userId: USER });
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.timezone).toBe('America/New_York');
    const ids = snapshot.items.map((item: any) => item.id);
    expect(ids.sort()).toEqual([open, snoozed, closed, code].map(String).sort());
    const codeView = snapshot.items.find((item: any) => item.id === String(code));
    expect(codeView.code).toEqual({ value: '482913', issuer: 'Northwind', expiresAt: CLOCK + 300_000 });
  });
});

describe('one loader for the page and the mobile routes', () => {
  test('snapshotFor and obligations.needsYou give the same snapshot, with the fields of phases 2 to 4', async () => {
    const t = harness();
    await flag(t);
    await timezone(t);
    const workId = String(await work(t));
    await row(t, {
      kind: 'action',
      source: 'github',
      sourceKey: 'github:conn:pr-482',
      sourceLabel: 'northwind/web #482',
      url: 'https://github.example.test/northwind/web/pull/482',
      accountId: undefined,
      threadId: undefined,
      messageId: undefined,
      workId,
      workTitle: 'Renew the Northwind contract',
    });
    await row(t, {
      kind: 'rsvp',
      source: 'calendar',
      sourceKey: 'calendar:acct:evt-1',
      eventId: 'evt-1',
      eventStart: CLOCK + 86_400_000,
      threadId: undefined,
      messageId: undefined,
    });
    await row(t, {
      state: 'resolved',
      closeReason: 'aged_out',
      closedBy: 'source',
      closedAt: CLOCK - 60_000,
    });
    const page = await t.withIdentity({ subject: USER }).query((api as any).obligations.needsYou, {});
    const mobile = await t.query(views.snapshotFor, { internalSecret: SECRET, userId: USER });
    expect(mobile).toEqual(page);
    expect(page.items).toHaveLength(3);
    expect(page.items.find((item: any) => item.source === 'github')).toMatchObject({
      sourceLabel: 'northwind/web #482',
      url: 'https://github.example.test/northwind/web/pull/482',
      workId,
      workTitle: 'Renew the Northwind contract',
    });
    expect(page.items.find((item: any) => item.kind === 'rsvp')).toMatchObject({
      eventId: 'evt-1',
      eventStart: CLOCK + 86_400_000,
    });
    // A user outside the flag: the same answer from both, with the time zone.
    await flag(t, OTHER, false);
    expect(await t.query(views.snapshotFor, { internalSecret: SECRET, userId: OTHER })).toEqual(
      await t.withIdentity({ subject: OTHER }).query((api as any).obligations.needsYou, {}),
    );
  });
});

describe('obligationViews.closedSinceFor', () => {
  test('gives the items that closed by themselves since a time, newest first, at most the limit', async () => {
    const t = harness();
    const since = CLOCK - 86_400_000;
    const newest = await row(t, {
      state: 'resolved',
      closeReason: 'evidence',
      closedBy: 'source',
      closedAt: CLOCK - 1_000,
    });
    const aged = await row(t, {
      kind: 'change',
      state: 'resolved',
      closeReason: 'aged_out',
      closedBy: 'source',
      closedAt: CLOCK - 2_000,
    });
    await row(t, { state: 'done', closeReason: 'user_done', closedBy: 'user', closedAt: CLOCK - 3_000 });
    await row(t, { state: 'dismissed', closeReason: 'not_mine', closedBy: 'user', closedAt: CLOCK - 4_000 });
    await row(t, { state: 'done', closeReason: 'sent_reply', closedBy: 'source', closedAt: CLOCK - 5_000 });
    await row(t, {
      kind: 'code',
      state: 'expired',
      closeReason: 'expired',
      closedBy: 'source',
      closedAt: CLOCK - 6_000,
    });
    await row(t, {
      state: 'resolved',
      closeReason: 'evidence',
      closedBy: 'source',
      closedAt: since - 1,
    });
    await row(t, {
      userId: OTHER,
      state: 'resolved',
      closeReason: 'evidence',
      closedBy: 'source',
      closedAt: CLOCK,
    });
    const third = await row(t, {
      kind: 'rsvp',
      source: 'calendar',
      state: 'expired',
      closeReason: 'event_passed',
      closedBy: 'source',
      closedAt: CLOCK - 7_000,
    });

    await expect(t.query(views.closedSinceFor, { userId: USER, since })).rejects.toThrow(/internal secret/i);
    const notes = await t.query(views.closedSinceFor, { internalSecret: SECRET, userId: USER, since });
    expect(notes.map((note: any) => note.id)).toEqual([newest, aged, third].map(String));
    expect(notes[1]).toMatchObject({
      title: expect.stringContaining('Confirm the start date'),
      asker: 'Dana Whitfield',
      source: 'mail',
      closeReason: 'aged_out',
      closedAt: CLOCK - 2_000,
    });
    const one = await t.query(views.closedSinceFor, {
      internalSecret: SECRET,
      userId: USER,
      since,
      limit: 1,
    });
    expect(one.map((note: any) => note.id)).toEqual([String(newest)]);
  });
});

describe('obligationViews.linkWork', () => {
  test('needs the server secret and the caller row', async () => {
    const t = harness();
    const workId = String(await work(t));
    const id = String(await row(t));
    await expect(t.mutation(views.linkWork, { userId: USER, id, workId })).rejects.toThrow(
      /internal secret/i,
    );
    const scope = { internalSecret: SECRET };
    expect(await t.mutation(views.linkWork, { ...scope, userId: OTHER, id, workId })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await t.mutation(views.linkWork, { ...scope, userId: USER, id: 'not-an-id', workId })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('refuses a Work that is gone, closed, or of another user', async () => {
    const t = harness();
    const scope = { internalSecret: SECRET, userId: USER };
    const id = String(await row(t));
    expect(await t.mutation(views.linkWork, { ...scope, id, workId: 'not-an-id' })).toEqual({
      ok: false,
      error: 'work_missing',
    });
    const theirs = String(await work(t, { userId: OTHER }));
    expect(await t.mutation(views.linkWork, { ...scope, id, workId: theirs })).toEqual({
      ok: false,
      error: 'work_missing',
    });
    for (const patch of [{ status: 'done' }, { status: 'archived' }, { workState: 'released' }]) {
      const closed = String(await work(t, patch));
      expect(await t.mutation(views.linkWork, { ...scope, id, workId: closed })).toEqual({
        ok: false,
        error: 'work_closed',
      });
    }
    const stored = await t.run((ctx) => ctx.db.get(id as Id<'obligations'>));
    expect(stored?.workId).toBeUndefined();
  });

  test('sets the workId and the workTitle and gives the view', async () => {
    const t = harness();
    const id = String(await row(t));
    const workId = String(await work(t, { title: undefined, rawText: '  Plan   the Q4 offsite  ' }));
    const result = await t.mutation(views.linkWork, { internalSecret: SECRET, userId: USER, id, workId });
    expect(result).toMatchObject({
      ok: true,
      workTitle: 'Plan the Q4 offsite',
      obligation: { id, workId, workTitle: 'Plan the Q4 offsite', state: 'open' },
    });
    const stored = await t.run((ctx) => ctx.db.get(id as Id<'obligations'>));
    expect(stored).toMatchObject({ workId, workTitle: 'Plan the Q4 offsite', updatedAt: CLOCK });
  });
});
