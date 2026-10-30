import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { BACKFILL_THREADS } from '../convex/jev';
import {
  CALENDAR_FILL_EVENTS,
  CALENDAR_FILL_EVERY_MS,
  OBLIGATION_RULES_VERSION,
  obligationView,
  openMailThreadPage,
  REPAIR_LEASE_MS,
  REPAIR_SCAN,
  syncCalendarObligations,
  syncThreadObligations,
  type ThreadSync,
} from '../convex/obligations';
import schema from '../convex/schema';
import { type JevAssessment, ROUTINE_NOTICE_QUESTION } from '../lib/jev/contract';
import { assessmentFromResponse } from '../lib/jev/mail';
import { CHANGE_AUTO_CLOSE_MS, CHANGE_NOW_WINDOW_MS, mailSourceKey } from '../lib/obligations/contract';
import { CLOSED_RETENTION_MS, prepareRevision } from '../lib/obligations/rules';
import { assessment, NOW, responseFor } from './fixtures/jev';

// Needs you phases 1.1, 2, and 4 on the Convex side. Invented people,
// companies, and services only.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/jev.ts': () => import('../convex/jev'),
  '../convex/obligations.ts': () => import('../convex/obligations'),
  '../convex/obligationViews.ts': () => import('../convex/obligationViews'),
  '../convex/content.ts': () => import('../convex/content'),
  '../convex/calendarData.ts': () => import('../convex/calendarData'),
  '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
  '../convex/mailOneTimeCodes.ts': () => import('../convex/mailOneTimeCodes'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/briefPreparations.ts': () => import('../convex/briefPreparations'),
};
const SECRET = 'synthetic-needs-you-sources';
const USER = 'owner';
const scope = { internalSecret: SECRET, userId: USER };
const ACCOUNT = 'acct-a';
const THREAD = 'thread-1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLOCK = NOW + HOUR;
const ob = (api as any).obligations;
const content = (api as any).content;
const calendar = (api as any).calendarData;
const jev = (api as any).jev;
const obligationViews = (api as any).obligationViews;

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

/** Runs the scheduled functions, and the functions that they schedule, until none waits. */
async function drain(t: TestConvex<typeof schema>) {
  for (let round = 0; round < 20; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});
    const waiting: Array<{ state: { kind: string } }> = await t.run((ctx) =>
      (ctx.db as any).system.query('_scheduled_functions').collect(),
    );
    if (!waiting.some((job) => job.state.kind === 'pending' || job.state.kind === 'inProgress')) return;
  }
}

async function connect(t: TestConvex<typeof schema>, userId = USER) {
  await t.run(async (ctx) => {
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId: ACCOUNT,
      email: `${userId}@example.test`,
      provider: 'google',
      grantId: `grant-${ACCOUNT}`,
      status: 'connected',
      scopes: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

async function flag(t: TestConvex<typeof schema>, doc: Record<string, unknown> = { enabled: true }) {
  await t.run((ctx) =>
    ctx.db.insert('userDocs', {
      userId: USER,
      kind: 'needsYouFlag',
      key: 'default',
      doc: { rulesVersion: OBLIGATION_RULES_VERSION, ...doc },
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function rows(t: TestConvex<typeof schema>) {
  return t.run((ctx) =>
    ctx.db
      .query('obligations')
      .withIndex('by_user_account', (q) => q.eq('userId', USER))
      .collect(),
  );
}

async function work(t: TestConvex<typeof schema>, patch: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId: USER,
      rawText: 'Close the Q3 budget',
      source: 'text',
      status: 'captured',
      title: 'Q3 budget',
      lastUserTouchAt: CLOCK - DAY,
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW,
      ...patch,
    } as any),
  );
}

const maya = {
  id: 'm1',
  from: 'Maya Chen <maya@university.test>',
  to: 'owner@example.test',
  body: 'Could you look at the budget?',
  date: CLOCK - HOUR,
};

function verdict(patch: Partial<JevAssessment> = {}) {
  return assessment({
    sourceMessageId: 'm1',
    obligations: [
      {
        kind: 'reply',
        evidence: { messageId: 'm1', text: 'Could you look at the budget?' },
        probability: 0.97,
      },
    ],
    ...patch,
  });
}

async function sync(t: TestConvex<typeof schema>, patch: Partial<ThreadSync> = {}) {
  return t.run((ctx) =>
    syncThreadObligations(ctx, {
      userId: USER,
      accountId: ACCOUNT,
      threadId: THREAD,
      subject: 'Budget',
      assessment: verdict(),
      messages: [maya],
      selfAddresses: ['owner@example.test'],
      latestMessageId: 'm1',
      corrections: [],
      preference: null,
      at: CLOCK,
      ...patch,
    }),
  );
}

async function contentItem(t: TestConvex<typeof schema>, patch: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('contentItems', {
      userId: USER,
      key: 'slack:slack-conn:slack:T:C1:1',
      connectionId: 'slack-conn',
      source: 'slack',
      externalId: 'slack:T:C1:1',
      title: '#release · Rosa Diaz: release notes',
      text: '#release · Rosa Diaz: release notes\nCan you sign off on the release notes today?',
      url: 'https://northwind.slack.test/archives/C1/p1',
      version: 'v1',
      modifiedAt: CLOCK - HOUR,
      indexedAt: CLOCK - HOUR,
      partial: false,
      deleted: false,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      lease: 'lease-1',
      ...patch,
    } as any),
  );
}

const slackLabels = {
  kind: 'request',
  actionable: true,
  resolved: false,
  workId: null,
  confidence: 0.95,
  model: 'typesafe/jev-1.13',
  evaluatedAt: CLOCK,
  due: 'today',
  actionableProbability: 0.92,
};

describe('mail: the Albatross of a thread (phase 1 gap)', () => {
  test('the content label of the thread links its Albatross; a recent one makes the item push', async () => {
    const t = harness();
    const workId = await work(t);
    await contentItem(t, {
      key: mailSourceKey(ACCOUNT, THREAD),
      source: 'mail',
      connectionId: ACCOUNT,
      externalId: THREAD,
      labels: { ...slackLabels, workId: String(workId) },
    });
    // No due date: only the recent Albatross makes it push.
    const ids = await sync(t, { assessment: verdict({ due: 'none' }) });
    expect(ids).toHaveLength(1);
    const [row] = await rows(t);
    expect(row).toMatchObject({ workId: String(workId), workTitle: 'Q3 budget', pushLevel: 'normal' });
    expect(obligationView(row, null, CLOCK)).toMatchObject({
      workId: String(workId),
      workTitle: 'Q3 budget',
    });
  });

  test('a link that the user set stays; an old, done, foreign, or proposal Albatross does not link', async () => {
    const t = harness();
    const old = await work(t, { lastUserTouchAt: CLOCK - 30 * DAY });
    await contentItem(t, {
      key: mailSourceKey(ACCOUNT, THREAD),
      source: 'mail',
      labels: { ...slackLabels, workId: String(old) },
    });
    expect(await sync(t, { assessment: verdict({ due: 'none' }) })).toEqual([]);
    const [row] = await rows(t);
    expect(row.workId).toBe(String(old));
    await t.run((ctx) => ctx.db.patch(row._id, { workId: 'user-chosen', workTitle: 'Mine' }));
    await sync(t, { assessment: verdict({ due: 'none' }), latestMessageId: 'm1' });
    expect((await rows(t))[0]).toMatchObject({ workId: 'user-chosen', workTitle: 'Mine' });
    const t2 = harness();
    const done = await work(t2, { status: 'done' });
    const foreign = await t2.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId: 'someone-else',
        rawText: 'x',
        source: 'text',
        status: 'captured',
        createdAt: NOW,
        updatedAt: NOW,
      } as any),
    );
    for (const workId of [String(done), String(foreign), 'proposal:p1', 'not-an-id']) {
      await t2.run(async (ctx) => {
        for (const item of await ctx.db.query('contentItems').collect()) await ctx.db.delete(item._id);
      });
      await contentItem(t2, {
        key: mailSourceKey(ACCOUNT, THREAD),
        source: 'mail',
        labels: { ...slackLabels, workId },
      });
      await sync(t2);
      expect((await rows(t2))[0].workId).toBeUndefined();
    }
  });

  test('labels of a mail item that arrive later link the open rows of the thread', async () => {
    const t = harness();
    await flag(t);
    const workId = await work(t);
    await sync(t);
    const itemId = await contentItem(t, {
      key: mailSourceKey(ACCOUNT, THREAD),
      source: 'mail',
      connectionId: ACCOUNT,
      externalId: THREAD,
    });
    const done = await t.mutation(content.completeItem, {
      ...scope,
      id: itemId,
      version: 'v1',
      lease: 'lease-1',
      labels: { ...slackLabels, workId: String(workId) },
      needsYou: true,
    });
    expect(done).toEqual({ ok: true, obligationIds: [] });
    expect((await rows(t))[0]).toMatchObject({ workId: String(workId), workTitle: 'Q3 budget' });
  });
});

describe('Start in Albatross and a later sync (integration)', () => {
  test('a re-sync with no label keeps the link that Start in Albatross set, for mail and a connected item', async () => {
    const t = harness();
    await flag(t);
    const chosen = String(await work(t, { title: 'Plan the Q3 review' }));
    const other = String(await work(t, { title: 'Another Albatross' }));
    await sync(t);
    const [mail] = await rows(t);
    expect(mail.workId).toBeUndefined();
    const linked = await t.mutation(obligationViews.linkWork, {
      internalSecret: SECRET,
      userId: USER,
      id: String(mail._id),
      workId: chosen,
    });
    expect(linked).toMatchObject({ ok: true, workTitle: 'Plan the Q3 review' });
    // A newer message from the same person, and no content label: no Albatross from the source.
    await sync(t, {
      messages: [maya, { ...maya, id: 'm2', date: CLOCK - 60_000 }],
      latestMessageId: 'm2',
      assessment: verdict({ sourceMessageId: 'm2' }),
    });
    expect((await rows(t))[0]).toMatchObject({ workId: chosen, workTitle: 'Plan the Q3 review' });
    // A label that names another Albatross does not move the link either.
    await contentItem(t, {
      key: mailSourceKey(ACCOUNT, THREAD),
      source: 'mail',
      labels: { ...slackLabels, workId: other },
    });
    await sync(t, { latestMessageId: 'm1' });
    expect((await rows(t))[0]).toMatchObject({ workId: chosen, workTitle: 'Plan the Q3 review' });

    // A connected item: the user links it, then a new version arrives with no workId.
    const itemId = await contentItem(t);
    const label = (version: string) =>
      t.mutation(content.completeItem, {
        ...scope,
        id: itemId,
        version,
        lease: 'lease-1',
        labels: { ...slackLabels, workId: null },
        needsYou: true,
      });
    expect(await label('v1')).toMatchObject({ ok: true });
    const slack = (await rows(t)).find((entry) => entry.source === 'slack')!;
    expect(slack.workId).toBeUndefined();
    await t.mutation(obligationViews.linkWork, {
      internalSecret: SECRET,
      userId: USER,
      id: String(slack._id),
      workId: chosen,
    });
    await t.run((ctx) => ctx.db.patch(itemId, { version: 'v2', lease: 'lease-1' } as any));
    expect(await label('v2')).toMatchObject({ ok: true });
    expect((await rows(t)).find((entry) => entry.source === 'slack')).toMatchObject({
      state: 'open',
      workId: chosen,
      workTitle: 'Plan the Q3 review',
    });
  });
});

describe('connected sources (phase 2)', () => {
  test('an actionable Slack label opens an action to push; without the flag the answer stays true', async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert('mcpItems', {
        userId: USER,
        connectionId: 'slack-conn',
        server: 'slack',
        externalId: 'slack:T:C1:1',
        kind: 'message',
        title: 'release notes',
        author: 'Rosa Diaz',
        raw: { channelName: 'release' },
        searchText: 'release notes',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const itemId = await contentItem(t);
    const result = await t.mutation(content.completeItem, {
      ...scope,
      id: itemId,
      version: 'v1',
      lease: 'lease-1',
      labels: slackLabels,
      needsYou: true,
    });
    expect(result.ok).toBe(true);
    expect(result.obligationIds).toHaveLength(1);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      kind: 'action',
      source: 'slack',
      sourceKey: 'slack:slack-conn:slack:T:C1:1',
      asker: 'Rosa Diaz',
      title: 'Can you sign off on the release notes today?',
      sourceLabel: '#release',
      url: 'https://northwind.slack.test/archives/C1/p1',
      pushLevel: 'normal',
      due: 'today',
      sourceMessageId: 'v1',
    });
    expect(obligationView(row, null, CLOCK)).toMatchObject({
      source: 'slack',
      sourceLabel: '#release',
      url: 'https://northwind.slack.test/archives/C1/p1',
    });
    const other = await contentItem(t, { key: 'slack:slack-conn:2', externalId: '2', lease: 'lease-2' });
    expect(
      await t.mutation(content.completeItem, {
        ...scope,
        id: other,
        version: 'v1',
        lease: 'lease-2',
        labels: slackLabels,
      }),
    ).toBe(true);
    expect(await rows(t)).toHaveLength(1);
  });

  test('a resolved label closes the item; a failed pass leaves it; a user close holds until the item changes', async () => {
    const t = harness();
    const itemId = await contentItem(t);
    const complete = (labels: unknown, version = 'v1', lease = 'lease-1') =>
      t.mutation(content.completeItem, { ...scope, id: itemId, version, lease, labels, needsYou: true });
    await complete(slackLabels);
    const [row] = await rows(t);
    // A connector row of another user is not this user's item.
    await t.run((ctx) => ctx.db.patch(itemId, { lease: 'lease-1' }));
    expect(await complete(undefined)).toEqual({ ok: true, obligationIds: [] });
    expect((await rows(t))[0].state).toBe('open');
    // Done by the user holds while the version is the same.
    expect(await t.mutation(ob.act, { ...scope, id: String(row._id), action: 'done' })).toMatchObject({
      ok: true,
    });
    await t.run((ctx) => ctx.db.patch(itemId, { lease: 'lease-1' }));
    await complete(slackLabels);
    expect((await rows(t))[0].state).toBe('done');
    // A new version reopens it.
    await t.run((ctx) => ctx.db.patch(itemId, { lease: 'lease-1', version: 'v2' }));
    await complete(slackLabels, 'v2');
    expect((await rows(t))[0].state).toBe('open');
    await t.run((ctx) => ctx.db.patch(itemId, { lease: 'lease-1' }));
    await complete({ ...slackLabels, resolved: true }, 'v2');
    expect((await rows(t))[0]).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
  });

  test('Not mine on a connected item closes it with no mail correction; a foreign connector row opens nothing', async () => {
    const t = harness();
    const itemId = await contentItem(t);
    await t.mutation(content.completeItem, {
      ...scope,
      id: itemId,
      version: 'v1',
      lease: 'lease-1',
      labels: slackLabels,
      needsYou: true,
    });
    const [row] = await rows(t);
    const dismissed = await t.mutation(ob.act, { ...scope, id: String(row._id), action: 'not_mine' });
    expect(dismissed).toMatchObject({
      ok: true,
      obligation: { state: 'dismissed', closeReason: 'not_mine' },
    });
    expect(await t.run((ctx) => ctx.db.query('userDocs').collect())).toEqual([]);
    const t2 = harness();
    await t2.run((ctx) =>
      ctx.db.insert('mcpItems', {
        userId: 'someone-else',
        connectionId: 'slack-conn',
        server: 'slack',
        externalId: 'slack:T:C1:1',
        kind: 'message',
        title: 'x',
        searchText: 'x',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const foreign = await contentItem(t2);
    await t2.mutation(content.completeItem, {
      ...scope,
      id: foreign,
      version: 'v1',
      lease: 'lease-1',
      labels: slackLabels,
      needsYou: true,
    });
    expect(await rows(t2)).toEqual([]);
  });

  test('a deleted item closes its item; a document opens nothing', async () => {
    const t = harness();
    const itemId = await contentItem(t);
    await t.mutation(content.completeItem, {
      ...scope,
      id: itemId,
      version: 'v1',
      lease: 'lease-1',
      labels: slackLabels,
      needsYou: true,
    });
    await t.mutation(content.upsert, {
      ...scope,
      items: [
        {
          source: 'slack',
          connectionId: 'slack-conn',
          externalId: 'slack:T:C1:1',
          title: 'gone',
          text: '',
          version: 'v-deleted',
          modifiedAt: CLOCK,
          deleted: true,
        },
      ],
    });
    expect((await rows(t))[0]).toMatchObject({
      state: 'resolved',
      closeReason: 'evidence',
      closedBy: 'source',
    });
    const doc = await contentItem(t, {
      key: 'document:library:d1',
      source: 'document',
      externalId: 'd1',
      lease: 'lease-3',
    });
    expect(
      await t.mutation(content.completeItem, {
        ...scope,
        id: doc,
        version: 'v1',
        lease: 'lease-3',
        labels: slackLabels,
        needsYou: true,
      }),
    ).toEqual({ ok: true, obligationIds: [] });
    expect(await rows(t)).toHaveLength(1);
  });

  test('the content text of a GitHub item says its owner facts', async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert('mcpItems', {
        userId: USER,
        connectionId: 'gh',
        server: 'github',
        externalId: 'github:pull_request:northwind/web#482',
        kind: 'pull_request',
        title: 'Add the export button',
        raw: { ownerFacts: ['review_requested', 'checks_failed'] },
        searchText: 'Add the export button pull_request northwind/web',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const page = await t.query(content.localPage, { ...scope, source: 'mcp', recent: true });
    expect(page.items[0].text).toContain('A review of this pull request is requested from the owner.');
    expect(page.items[0].text).toContain("Checks failed on the owner's branch.");
  });
});

describe('Trash and Spam close the thread items (phase 1 gap)', () => {
  test('a thread in Trash with an open item gets a tombstone, and the upsert closes the item', async () => {
    const t = harness();
    await connect(t);
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      grantId: `grant-${ACCOUNT}`,
      provider: 'google',
      threads: [],
      messages: [
        {
          providerMessageId: 'm1',
          providerThreadId: THREAD,
          subject: 'Budget',
          from: maya.from,
          to: 'owner@example.test',
          receivedAt: CLOCK - HOUR,
          snippet: maya.body,
          textBody: maya.body,
          searchText: maya.body,
          labels: ['TRASH'],
        },
      ],
    });
    // No content row and no item: no tombstone.
    const empty = await t.query(content.mailChanges, { ...scope, after: { updatedAt: 0, creationTime: 0 } });
    expect(empty.items).toEqual([]);
    await sync(t);
    const page = await t.query(content.mailChanges, { ...scope, after: { updatedAt: 0, creationTime: 0 } });
    expect(page.items).toEqual([
      expect.objectContaining({ source: 'mail', externalId: THREAD, deleted: true }),
    ]);
    await t.mutation(content.upsert, {
      ...scope,
      items: page.items.map((item: any) => ({ ...item, version: 'x' })),
    });
    expect((await rows(t))[0]).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
  });
});

describe('calendar (phase 4)', () => {
  const event = (patch: Record<string, unknown> = {}) => ({
    providerEventId: 'evt-1',
    providerCalendarId: 'cal-1',
    title: 'Budget review',
    startAt: CLOCK + 2 * DAY,
    endAt: CLOCK + 2 * DAY + HOUR,
    organizer: { name: 'Rosa Diaz', email: 'rosa@northwind.test' },
    participants: [
      { name: 'Rosa Diaz', email: 'rosa@northwind.test', status: 'yes' },
      { email: 'owner@example.test', status: 'noreply' },
    ],
    ...patch,
  });
  const batch = (events: unknown[]) => ({
    ...scope,
    accountId: ACCOUNT,
    grantId: `grant-${ACCOUNT}`,
    provider: 'google',
    events,
  });

  test('an invitation opens an rsvp for a flag user; an answer from anywhere closes it', async () => {
    const t = harness();
    await connect(t);
    await t.mutation(calendar.upsertEventBatch, batch([event()]));
    expect(await rows(t)).toEqual([]);
    await flag(t);
    await t.mutation(calendar.upsertEventBatch, batch([event({ description: 'Bring the numbers.' })]));
    const [row] = await rows(t);
    expect(row).toMatchObject({
      kind: 'rsvp',
      source: 'calendar',
      sourceKey: `calendar:${ACCOUNT}:evt-1`,
      title: 'Answer the invitation: Budget review',
      eventId: 'evt-1',
      calendarId: 'cal-1',
      eventStart: CLOCK + 2 * DAY,
      sweepAt: CLOCK + 2 * DAY,
      pushLevel: 'none',
    });
    expect(obligationView(row, null, CLOCK)).toMatchObject({ eventId: 'evt-1', eventStart: CLOCK + 2 * DAY });
    // An unchanged event costs no write and keeps the row.
    expect(
      await t.mutation(calendar.upsertEventBatch, batch([event({ description: 'Bring the numbers.' })])),
    ).toMatchObject({
      skipped: 1,
    });
    await t.mutation(
      calendar.upsertEventBatch,
      batch([event({ participants: [{ email: 'owner@example.test', status: 'yes' }] })]),
    );
    expect((await rows(t))[0]).toMatchObject({
      state: 'done',
      closeReason: 'event_passed',
      closedBy: 'source',
    });
  });

  test('an unchanged invitation opens its rsvp on the hourly fill when it enters the 14-day window', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    // Twenty days ahead: the sync opens no row, and the event does not change again.
    await t.mutation(
      calendar.upsertEventBatch,
      batch([event({ startAt: CLOCK + 20 * DAY, endAt: CLOCK + 20 * DAY + HOUR })]),
    );
    expect(await rows(t)).toEqual([]);
    // A week later the event is in the window. The claim of a flag user fills the calendar.
    const week = CLOCK + 7 * DAY;
    setSystemTime(new Date(week));
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      kind: 'rsvp',
      state: 'open',
      eventStart: CLOCK + 20 * DAY,
      pushLevel: 'none',
    });
    // At most once an hour: a claim within the hour does not fill again.
    await t.run((ctx) => ctx.db.delete(row._id));
    setSystemTime(new Date(week + CALENDAR_FILL_EVERY_MS - 1));
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    expect(await rows(t)).toEqual([]);
    setSystemTime(new Date(week + CALENDAR_FILL_EVERY_MS));
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    expect((await rows(t)).map((entry) => `${entry.kind}:${entry.state}`)).toEqual(['rsvp:open']);
    // A user without the flag fills nothing.
    expect(await t.mutation(internal.obligations.fillCalendar, { userId: 'someone-else' })).toEqual({
      synced: 0,
    });
  });

  const fillState = (t: TestConvex<typeof schema>) =>
    t.run((ctx) =>
      ctx.db
        .query('userDocs')
        .withIndex('by_user_kind_key', (q) =>
          q.eq('userId', USER).eq('kind', 'needsYouCalendarFill').eq('key', 'default'),
        )
        .unique(),
    );
  const ownEvents = (count: number, startAt: (index: number) => number) =>
    Array.from({ length: count }, (_, index) =>
      event({
        providerEventId: `own-${index}`,
        startAt: startAt(index),
        endAt: startAt(index) + HOUR,
        organizer: { email: 'owner@example.test' },
        participants: [{ email: 'owner@example.test', status: 'yes' }],
      }),
    );
  const upsertAll = async (t: TestConvex<typeof schema>, events: unknown[]) => {
    for (let start = 0; start < events.length; start += 50)
      await t.mutation(calendar.upsertEventBatch, batch(events.slice(start, start + 50)));
  };

  test('a long calendar fills in pages, so an invitation after the first page still opens', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    // 200 of the owner's own events (no invitation) between day 8 and day 12.
    await upsertAll(
      t,
      ownEvents(CALENDAR_FILL_EVENTS, (index) => CLOCK + 8 * DAY + index * 30 * 60_000),
    );
    // The invitation is 20 days ahead: no row now.
    await t.mutation(
      calendar.upsertEventBatch,
      batch([event({ providerEventId: 'late', startAt: CLOCK + 20 * DAY, endAt: CLOCK + 20 * DAY + HOUR })]),
    );
    expect(await rows(t)).toEqual([]);
    // A week later the window holds the 200 own events first, then the invitation.
    setSystemTime(new Date(CLOCK + 7 * DAY));
    await t.mutation(internal.obligations.fillCalendar, { userId: USER });
    expect(await rows(t)).toEqual([]);
    const saved = await fillState(t);
    expect(saved?.doc?.cycle).toMatchObject({ lower: CLOCK + 7 * DAY, upper: CLOCK + 21 * DAY });
    expect(typeof saved?.doc?.cycle?.cursor).toBe('string');
    // An hour later the pass continues in the same fixed window and opens the invitation.
    setSystemTime(new Date(CLOCK + 7 * DAY + HOUR));
    await t.mutation(internal.obligations.fillCalendar, { userId: USER });
    expect((await rows(t)).map((row) => `${row.kind}:${row.eventId}`)).toEqual(['rsvp:late']);
    expect((await fillState(t))?.doc?.cycle).toBeUndefined();
  });

  test('a pass reads every event once, also when more than one page starts at the same time', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    const sameStart = CLOCK + 3 * DAY;
    await upsertAll(
      t,
      ownEvents(CALENDAR_FILL_EVENTS + 5, () => sameStart),
    );
    await t.mutation(
      calendar.upsertEventBatch,
      batch([event({ providerEventId: 'tied', startAt: sameStart, endAt: sameStart + HOUR })]),
    );
    // The sync opened the invitation; remove it, so only the fill can open it again.
    for (const row of await rows(t)) await t.run((ctx) => ctx.db.delete(row._id));
    await t.mutation(internal.obligations.fillCalendar, { userId: USER });
    expect(await rows(t)).toEqual([]);
    expect((await fillState(t))?.doc?.cycle?.cursor).toBeTruthy();
    await t.mutation(internal.obligations.fillCalendar, { userId: USER });
    expect((await rows(t)).map((row) => `${row.kind}:${row.eventId}`)).toEqual(['rsvp:tied']);
    expect((await fillState(t))?.doc?.cycle).toBeUndefined();
  });

  test('a saved pass that Convex no longer accepts starts again at now', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    await t.run((ctx) =>
      ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'needsYouCalendarFill',
        key: 'default',
        doc: { at: CLOCK, cycle: { lower: CLOCK, upper: CLOCK + 14 * DAY, cursor: 'not-a-cursor' } },
        createdAt: CLOCK,
        updatedAt: CLOCK,
      }),
    );
    expect(await t.mutation(internal.obligations.fillCalendar, { userId: USER })).toEqual({ synced: 0 });
    const state = await fillState(t);
    expect(state?.doc).toEqual({ at: CLOCK });
  });

  test('a cancel closes the rsvp by evidence; a deleted or pruned event closes its items', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    await t.mutation(
      calendar.upsertEventBatch,
      batch([event(), event({ providerEventId: 'evt-2' }), event({ providerEventId: 'evt-3' })]),
    );
    expect((await rows(t)).filter((row) => row.state === 'open')).toHaveLength(3);
    await t.mutation(calendar.upsertEventBatch, batch([event({ status: 'cancelled' })]));
    await t.mutation(calendar.deleteEvent, { ...scope, accountId: ACCOUNT, providerEventId: 'evt-2' });
    const { events: _events, ...window } = batch([]);
    await t.mutation(calendar.reconcileWindow, {
      ...window,
      providerCalendarId: 'cal-1',
      windowStart: CLOCK,
      windowEnd: CLOCK + 14 * DAY,
      keepProviderEventIds: ['evt-1'],
    });
    const byEvent = Object.fromEntries((await rows(t)).map((row) => [row.eventId, row]));
    expect(byEvent['evt-1']).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
    expect(byEvent['evt-2']).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
    expect(byEvent['evt-3']).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
  });

  test('a series has one rsvp at its next instance; another instance does not move or close it', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    const instance = (day: number) =>
      event({
        providerEventId: `evt-1_${day}`,
        masterEventId: 'evt-1',
        startAt: CLOCK + day * DAY,
        endAt: CLOCK + day * DAY + HOUR,
      });
    await t.mutation(calendar.upsertEventBatch, batch([instance(2), instance(9)]));
    const [row] = await rows(t);
    expect(row).toMatchObject({
      eventId: 'evt-1',
      eventStart: CLOCK + 2 * DAY,
      sourceKey: `calendar:${ACCOUNT}:evt-1`,
    });
    // A later instance answered alone does not close the item of the next one.
    await t.mutation(
      calendar.upsertEventBatch,
      batch([{ ...instance(9), participants: [{ email: 'owner@example.test', status: 'no' }] }]),
    );
    expect((await rows(t))[0].state).toBe('open');
    await t.mutation(calendar.deleteEvent, { ...scope, accountId: ACCOUNT, providerEventId: 'evt-1_9' });
    expect((await rows(t))[0].state).toBe('open');
    await t.mutation(calendar.deleteEvent, { ...scope, accountId: ACCOUNT, providerEventId: 'evt-1_2' });
    expect((await rows(t))[0]).toMatchObject({ state: 'resolved', closeReason: 'evidence' });
  });

  test('the prepare question: claim once each revision, store the answer, push at the bar', async () => {
    const t = harness();
    await connect(t);
    const soon = event({
      startAt: CLOCK + 3 * HOUR,
      endAt: CLOCK + 4 * HOUR,
      description: 'Bring the Q3 numbers.',
    });
    await t.mutation(
      calendar.upsertEventBatch,
      batch([soon, event({ providerEventId: 'solo', startAt: CLOCK + 2 * HOUR, participants: [] })]),
    );
    expect(await t.mutation(ob.claimPrepareEvents, scope)).toEqual({ events: [] });
    await flag(t);
    const claim = await t.mutation(ob.claimPrepareEvents, scope);
    expect(claim.events).toHaveLength(1);
    expect(claim.events[0]).toMatchObject({
      providerEventId: 'evt-1',
      title: 'Budget review',
      description: 'Bring the Q3 numbers.',
      organizer: 'Rosa Diaz <rosa@northwind.test>',
      selfAddresses: ['owner@example.test'],
    });
    // A failed answer waits for a retry, at most three times.
    expect((await t.mutation(ob.claimPrepareEvents, scope)).events).toEqual([]);
    expect(
      (await t.mutation(ob.claimPrepareEvents, { ...scope, now: CLOCK + 20 * 60_000 })).events,
    ).toHaveLength(1);
    const { revision } = claim.events[0];
    const stored = await t.mutation(ob.storePrepare, {
      ...scope,
      results: [
        {
          accountId: ACCOUNT,
          providerCalendarId: 'cal-1',
          providerEventId: 'evt-1',
          revision,
          probability: 0.92,
        },
        {
          accountId: ACCOUNT,
          providerCalendarId: 'cal-1',
          providerEventId: 'evt-1',
          revision: 'stale',
          probability: 0.99,
        },
        {
          accountId: ACCOUNT,
          providerCalendarId: 'cal-1',
          providerEventId: 'none',
          revision,
          probability: 0.99,
        },
        { accountId: ACCOUNT, providerCalendarId: 'cal-1', providerEventId: 'evt-1', revision },
      ],
    });
    expect(stored.obligationIds).toHaveLength(1);
    const prepare = (await rows(t)).find((row) => row.kind === 'prepare')!;
    expect(prepare).toMatchObject({
      title: 'Prepare for Budget review',
      pushLevel: 'normal',
      probability: 0.92,
      eventStart: CLOCK + 3 * HOUR,
      sourceKey: `calendar:${ACCOUNT}:evt-1`,
    });
    // Answered: not claimed again for the same revision.
    expect((await t.mutation(ob.claimPrepareEvents, { ...scope, now: CLOCK + HOUR })).events).toEqual([]);
    // A move out of the next 24 hours closes it.
    await t.mutation(
      calendar.upsertEventBatch,
      batch([{ ...soon, startAt: CLOCK + 3 * DAY, endAt: CLOCK + 3 * DAY + HOUR }]),
    );
    expect((await rows(t)).find((row) => row.kind === 'prepare')).toMatchObject({ state: 'resolved' });
    // A started event deletes its stored answer at the next claim.
    expect((await t.mutation(ob.claimPrepareEvents, { ...scope, now: CLOCK + 4 * DAY })).events).toEqual([]);
    expect(
      (await t.run((ctx) => ctx.db.query('userDocs').collect())).filter(
        (row) => row.kind === 'needsYouPrepare',
      ),
    ).toEqual([]);
  });

  test('a low prepare answer opens nothing; an open prepare follows its event and ends at its start', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    const soon = event({ startAt: CLOCK + 3 * HOUR, endAt: CLOCK + 4 * HOUR });
    await t.mutation(calendar.upsertEventBatch, batch([soon]));
    const revision = prepareRevision({ ...soon, accountId: ACCOUNT } as any);
    const result = (probability: number) => ({
      accountId: ACCOUNT,
      providerCalendarId: 'cal-1',
      providerEventId: 'evt-1',
      revision,
      probability,
    });
    expect((await t.mutation(ob.storePrepare, { ...scope, results: [result(0.3)] })).obligationIds).toEqual(
      [],
    );
    expect((await rows(t)).some((row) => row.kind === 'prepare')).toBe(false);
    await t.mutation(ob.storePrepare, { ...scope, results: [result(0.8)] });
    const row = (await rows(t)).find((entry) => entry.kind === 'prepare')!;
    expect(row.pushLevel).toBe('none');
    const renamed = { ...soon, title: 'Budget review (moved room)' };
    await t.mutation(calendar.upsertEventBatch, batch([renamed]));
    expect((await rows(t)).find((entry) => entry.kind === 'prepare')).toMatchObject({
      state: 'open',
      title: 'Prepare for Budget review (moved room)',
    });
    await t.run((ctx) => syncCalendarObligations(ctx, USER, [], { at: CLOCK }));
    const events = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
    await t.run((ctx) =>
      syncCalendarObligations(ctx, USER, events, { at: CLOCK + 3 * HOUR, self: ['owner@example.test'] }),
    );
    expect((await rows(t)).find((entry) => entry.kind === 'prepare')).toMatchObject({
      state: 'expired',
      closeReason: 'event_passed',
    });
    expect((await rows(t)).find((entry) => entry.kind === 'rsvp')).toMatchObject({
      state: 'expired',
      closeReason: 'event_passed',
    });
  });

  test('the rsvp action closes the row for good; another kind is refused', async () => {
    const t = harness();
    await connect(t);
    await flag(t);
    await t.mutation(calendar.upsertEventBatch, batch([event()]));
    const [row] = await rows(t);
    const got = await t.query(ob.get, { ...scope, id: String(row._id) });
    expect(got.calendarId).toBe('cal-1');
    const answered = await t.mutation(ob.act, { ...scope, id: String(row._id), action: 'rsvp' });
    expect(answered).toMatchObject({ ok: true, obligation: { state: 'done', closeReason: 'event_passed' } });
    expect(answered.undoUntil).toBeUndefined();
    // A sync with the old status before the provider updates does not reopen it.
    await t.mutation(calendar.upsertEventBatch, batch([event({ description: 'Agenda added.' })]));
    expect((await rows(t))[0].state).toBe('done');
    await sync(t);
    const mailRow = (await rows(t)).find((entry) => entry.source === 'mail')!;
    expect(await t.mutation(ob.act, { ...scope, id: String(mailRow._id), action: 'rsvp' })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});

describe('the sweep', () => {
  test('a time-sensitive change leaves Now, ages out, and a closed row goes after 30 days', async () => {
    const t = harness();
    const text = 'Your payment of $20 failed.';
    const [id] = await sync(t, {
      assessment: verdict({
        purpose: 'transaction',
        subjectKind: 'finance',
        obligations: [],
        meaningfulChange: true,
        changeEvidence: { messageId: 'm1', text },
        probabilities: { reply: 0.02, action: 0.02, waiting: 0.02, change: 0.95 },
      }),
      messages: [{ ...maya, body: text }],
    });
    const sourceAt = maya.date;
    expect((await rows(t))[0]).toMatchObject({
      pushLevel: 'time_sensitive',
      sweepAt: sourceAt + CHANGE_NOW_WINDOW_MS,
    });
    expect(await t.mutation(internal.obligations.sweep, { now: CLOCK })).toMatchObject({
      closed: 0,
      demoted: 0,
    });
    expect(
      await t.mutation(internal.obligations.sweep, { now: sourceAt + CHANGE_NOW_WINDOW_MS }),
    ).toMatchObject({
      demoted: 1,
    });
    expect((await rows(t))[0]).toMatchObject({
      pushLevel: 'normal',
      sweepAt: sourceAt + CHANGE_AUTO_CLOSE_MS,
    });
    const closedAt = sourceAt + CHANGE_AUTO_CLOSE_MS;
    expect(await t.mutation(internal.obligations.sweep, { now: closedAt })).toMatchObject({ closed: 1 });
    expect((await rows(t))[0]).toMatchObject({ state: 'resolved', closeReason: 'aged_out', closedAt });
    expect((await rows(t))[0].sweepAt).toBeUndefined();
    // Undo of a user close puts the row back under the sweep.
    expect(
      await t.mutation(internal.obligations.sweep, { now: closedAt + CLOSED_RETENTION_MS - 1 }),
    ).toMatchObject({
      removed: 0,
    });
    expect(
      await t.mutation(internal.obligations.sweep, { now: closedAt + CLOSED_RETENTION_MS + 1 }),
    ).toMatchObject({
      removed: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(id as Id<'obligations'>))).toBeNull();
  });

  test('a snoozed change waits; a row without a step leaves the sweep; Undo puts a change back', async () => {
    const t = harness();
    const text = 'Your plan changed.';
    await sync(t, {
      assessment: verdict({
        purpose: 'transaction',
        subjectKind: 'order',
        obligations: [],
        meaningfulChange: true,
        changeEvidence: { messageId: 'm1', text },
        probabilities: { reply: 0.02, action: 0.02, waiting: 0.02, change: 0.95 },
      }),
      messages: [{ ...maya, body: text }],
    });
    const [row] = await rows(t);
    const later = CLOCK + 5 * DAY;
    await t.mutation(ob.act, { ...scope, id: String(row._id), action: 'later', until: later });
    expect(await t.mutation(internal.obligations.sweep, { now: CLOCK + 4 * DAY })).toMatchObject({
      deferred: 1,
    });
    expect((await rows(t))[0].sweepAt).toBe(later);
    await t.run((ctx) => ctx.db.patch(row._id, { kind: 'reply', sweepAt: CLOCK }));
    expect(await t.mutation(internal.obligations.sweep, { now: CLOCK + HOUR })).toMatchObject({
      closed: 0,
      deferred: 0,
    });
    expect((await rows(t))[0].sweepAt).toBeUndefined();
    await t.run((ctx) => ctx.db.patch(row._id, { kind: 'change', state: 'open', snoozedUntil: undefined }));
    const done = await t.mutation(ob.act, { ...scope, id: String(row._id), action: 'done' });
    expect(done.ok).toBe(true);
    await t.mutation(ob.act, { ...scope, id: String(row._id), action: 'undo' });
    expect((await rows(t))[0].sweepAt).toBe(maya.date + CHANGE_AUTO_CLOSE_MS);
  });

  test('a full batch schedules the next sweep; the Jev tick runs the sweep', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++)
        await ctx.db.insert('obligations', {
          userId: USER,
          kind: 'reply',
          state: 'open',
          source: 'mail',
          sourceKey: `mail:a:${i}`,
          title: 't',
          asker: 'a',
          due: 'none',
          probability: 0.9,
          pushLevel: 'none',
          sweepAt: CLOCK - 1,
          openedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        });
    });
    expect(await t.mutation(internal.obligations.sweep, {})).toMatchObject({ more: true });
    await drain(t);
    await t.action((internal as any).jev.tick, {});
    expect((await rows(t)).every((row) => row.sweepAt === undefined)).toBe(true);
  });
});

describe('the waiting follow-up (phase 1 gap)', () => {
  const owner = {
    id: 'm1',
    from: 'Owner <owner@example.test>',
    to: 'Marco Ruiz <marco@ruiz.test>',
    body: 'Can you send the signed lease by Friday?',
    date: CLOCK - HOUR,
  };
  const waiting = verdict({
    due: 'soon',
    obligations: [{ kind: 'waiting', evidence: { messageId: 'm1', text: owner.body }, probability: 0.95 }],
  });

  test('a waiting item with a due time holds one push until then; the release sends it once', async () => {
    const t = harness();
    const ids = await sync(t, { assessment: waiting, messages: [owner] });
    expect(ids).toEqual([]);
    const [row] = await rows(t);
    expect(row).toMatchObject({ kind: 'waiting', pushHoldReason: 'follow_up' });
    const dueAt = row.dueAt!;
    expect(row.pushHeldUntil).toBe(dueAt);
    expect(await t.mutation(ob.claimHeldPushes, { ...scope, now: dueAt - 1 })).toEqual({ kind: 'wait' });
    // A sync after the due time and before the release keeps the due follow-up.
    await sync(t, { assessment: waiting, messages: [owner], at: dueAt + 1 });
    expect((await rows(t))[0]).toMatchObject({ pushHeldUntil: dueAt, pushHoldReason: 'follow_up' });
    const released = await t.mutation(ob.claimHeldPushes, { ...scope, now: dueAt + 1 });
    expect(released).toMatchObject({ kind: 'push', push: { collapseId: String(row._id) } });
    const pushed = (await rows(t))[0];
    expect(pushed).toMatchObject({ followUpAt: dueAt + 1, pushCount: 1 });
    expect(pushed.pushHeldUntil).toBeUndefined();
    // The next sync does not arm a second follow-up.
    await sync(t, { assessment: waiting, messages: [owner] });
    expect((await rows(t))[0].pushHeldUntil).toBeUndefined();
  });

  test('a backfill arms no follow-up; a lost due time clears the hold; the switch off spends it', async () => {
    const t = harness();
    await sync(t, { assessment: waiting, messages: [owner], push: false });
    expect((await rows(t))[0].pushHeldUntil).toBeUndefined();
    await sync(t, { assessment: waiting, messages: [owner] });
    expect((await rows(t))[0].pushHoldReason).toBe('follow_up');
    await sync(t, {
      assessment: verdict({
        due: 'none',
        obligations: [{ kind: 'waiting', evidence: { messageId: 'm1', text: 'Thanks.' }, probability: 0.95 }],
      }),
      messages: [{ ...owner, body: 'Thanks.' }],
    });
    expect((await rows(t))[0].pushHoldReason).toBeUndefined();
    await sync(t, { assessment: waiting, messages: [owner] });
    const [row] = await rows(t);
    await t.run((ctx) =>
      ctx.db.insert('albatrossNotificationPreferences', {
        userId: USER,
        timezone: 'UTC',
        eveningCheckinEnabled: false,
        eveningCheckinLocalTime: '18:00',
        inAppEnabled: true,
        webPushEnabled: false,
        emailFallbackEnabled: true,
        emailFallbackDelayMinutes: 90,
        obligationPushEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    expect(await t.mutation(ob.claimHeldPushes, { ...scope, now: row.dueAt! + 1 })).toEqual({ kind: 'wait' });
    expect((await rows(t))[0]).toMatchObject({ followUpAt: row.dueAt! + 1 });
    expect((await rows(t))[0].pushedAt).toBeUndefined();
  });

  test('over the hourly limit a follow-up keeps its reason and goes in the summary', async () => {
    const t = harness();
    await sync(t, { assessment: waiting, messages: [owner] });
    const [row] = await rows(t);
    const at = row.dueAt! + 1;
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++)
        await ctx.db.insert('obligations', {
          userId: USER,
          kind: 'reply',
          state: 'open',
          source: 'mail',
          sourceKey: `mail:a:${i}`,
          title: 't',
          asker: 'a',
          due: 'none',
          probability: 0.9,
          pushLevel: 'normal',
          pushedAt: at - 60_000,
          openedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        });
      await ctx.db.insert('obligations', {
        userId: USER,
        kind: 'reply',
        state: 'open',
        source: 'mail',
        sourceKey: 'mail:a:held',
        title: 't',
        asker: 'a',
        due: 'none',
        probability: 0.9,
        pushLevel: 'normal',
        pushHeldUntil: at - 1,
        pushHoldReason: 'limit',
        openedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert('albatrossNotifications', {
        userId: USER,
        type: 'obligation',
        title: 'Needs you',
        body: '2 things need you.',
        dedupeKey: 'obligation-summary:000000000000001',
        deepLink: '/?view=notifications',
        status: 'delivered',
        scheduledFor: at - 60_000,
        createdAt: at - 60_000,
        updatedAt: at - 60_000,
      } as any);
    });
    const later = await t.mutation(ob.claimHeldPushes, { ...scope, now: at });
    expect(later.kind).toBe('later');
    expect((await t.run((ctx) => ctx.db.get(row._id)))!.pushHoldReason).toBe('follow_up');
    const summary = await t.mutation(ob.claimHeldPushes, { ...scope, now: later.until });
    expect(summary).toMatchObject({ kind: 'summary', count: 2 });
    expect((await t.run((ctx) => ctx.db.get(row._id)))!.followUpAt).toBe(later.until);
  });
});

describe('the phase 1.1 repair and the fill', () => {
  async function mail(
    t: TestConvex<typeof schema>,
    id: string,
    thread: string,
    subject: string,
    body: string,
    at: number,
  ) {
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      grantId: `grant-${ACCOUNT}`,
      provider: 'google',
      threads: [],
      messages: [
        {
          providerMessageId: id,
          providerThreadId: thread,
          subject,
          from: 'Bluefin Pay <notice@bluefin.test>',
          to: 'owner@example.test',
          receivedAt: at,
          snippet: body,
          textBody: body,
          searchText: body,
          labels: ['INBOX'],
        },
      ],
    });
  }

  /** One Jev pass that stores a change verdict for each claimed thread. */
  async function sweepChanges(
    t: TestConvex<typeof schema>,
    choices: Record<string, string | number>,
    needsYou: boolean,
  ) {
    const page = await t.mutation(jev.claimPending, { ...scope, limit: 12, needsYou });
    const items = page.items.map((item: any) => {
      const { facts: _facts, ...input } = item;
      const response = responseFor(input, {
        purpose: 'transaction',
        subject_kind: 'finance',
        reply: 0.02,
        change: 0.95,
        reply_evidence: 'none',
        change_evidence: 'm0',
        ...choices,
      });
      // A phase 1 verdict: stored before the routine_notice question.
      if (!(ROUTINE_NOTICE_QUESTION in choices)) delete (response.answers as any)[ROUTINE_NOTICE_QUESTION];
      return {
        accountId: input.accountId,
        threadId: input.threadId,
        messageId: input.messageId,
        sourceRevision: input.sourceRevision,
        leaseId: input.leaseId,
        assessment: assessmentFromResponse(input, response, NOW),
      };
    });
    return t.mutation(jev.storeAssessments, { ...scope, items, ...(needsYou ? { needsYou: true } : {}) });
  }

  test('the old rules opened routine and old changes; the repair closes them in the past, once, with no push', async () => {
    const t = harness();
    await connect(t);
    await mail(
      t,
      'terms',
      'th-terms',
      'Updates to our services agreement',
      'We are updating the Bluefin Pay services agreement on Dec 1.',
      CLOCK - 2 * HOUR,
    );
    await mail(t, 'old', 'th-old', 'Payment failed', 'Your payment failed.', CLOCK - 5 * DAY);
    await mail(
      t,
      'fail',
      'th-fail',
      'Payment failed',
      'Your payment failed. Update your card.',
      CLOCK - 2 * HOUR,
    );
    // Phase 1 stored these verdicts without the routine answer, and opened rows.
    await sweepChanges(t, {}, false);
    await t.run(async (ctx) => {
      for (const thread of ['th-terms', 'th-old', 'th-fail'])
        await ctx.db.insert('obligations', {
          userId: USER,
          kind: 'change',
          state: 'open',
          source: 'mail',
          sourceKey: mailSourceKey(ACCOUNT, thread),
          accountId: ACCOUNT,
          threadId: thread,
          messageId: thread === 'th-terms' ? 'terms' : thread === 'th-old' ? 'old' : 'fail',
          title: 'Changed',
          asker: 'Bluefin Pay',
          due: 'none',
          probability: 0.95,
          pushLevel: 'time_sensitive',
          openedAt: CLOCK - HOUR,
          createdAt: CLOCK - HOUR,
          updatedAt: CLOCK - HOUR,
        });
      await ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'needsYouFlag',
        key: 'default',
        doc: { enabled: true },
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    // The next claim of a flag user with older rules starts the repair once.
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    const byThread = Object.fromEntries((await rows(t)).map((row) => [row.threadId, row]));
    expect(byThread['th-terms']).toMatchObject({
      state: 'resolved',
      closeReason: 'evidence',
      closedAt: CLOCK - 2 * HOUR,
    });
    expect(byThread['th-old']).toMatchObject({
      state: 'resolved',
      closeReason: 'aged_out',
      closedAt: CLOCK - 5 * DAY + CHANGE_AUTO_CLOSE_MS,
    });
    expect(byThread['th-fail']).toMatchObject({
      state: 'open',
      pushLevel: 'time_sensitive',
      sourceAt: CLOCK - 2 * HOUR,
    });
    expect(await t.run((ctx) => ctx.db.query('albatrossNotifications').collect())).toEqual([]);
    const flagRow = (await t.run((ctx) => ctx.db.query('userDocs').collect())).find(
      (row) => row.kind === 'needsYouFlag',
    );
    expect(flagRow?.doc.rulesVersion).toBe(OBLIGATION_RULES_VERSION);
    // Idempotent: a second run leaves the rows as they are.
    const before = await rows(t);
    await t.mutation(internal.jev.repairObligations, { userId: USER });
    await drain(t);
    expect((await rows(t)).map(({ updatedAt: _u, ...row }) => row)).toEqual(
      before.map(({ updatedAt: _u, ...row }) => row),
    );
    // The flag off: nothing.
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: false });
    expect(await t.mutation(internal.jev.repairObligations, { userId: USER })).toEqual({
      synced: 0,
      done: true,
    });
  });

  test('the fill makes no time-sensitive row, and fills the labelled content and the invitations', async () => {
    const t = harness();
    await connect(t);
    await mail(
      t,
      'fail',
      'th-fail',
      'Payment failed',
      'Your payment failed. Update your card.',
      CLOCK - 2 * HOUR,
    );
    await sweepChanges(t, { [ROUTINE_NOTICE_QUESTION]: 0.05 }, false);
    await contentItem(t, { labels: slackLabels, status: 'ready' });
    await contentItem(t, {
      key: 'slack:slack-conn:2',
      externalId: '2',
      labels: { ...slackLabels, actionable: false },
    });
    await t.mutation(calendar.upsertEventBatch, {
      ...scope,
      accountId: ACCOUNT,
      grantId: `grant-${ACCOUNT}`,
      provider: 'google',
      events: [
        {
          providerEventId: 'evt-1',
          providerCalendarId: 'cal-1',
          title: 'Budget review',
          startAt: CLOCK + 2 * DAY,
          endAt: CLOCK + 2 * DAY + HOUR,
          organizer: { email: 'rosa@northwind.test' },
          participants: [{ email: 'owner@example.test', status: 'noreply' }],
        },
      ],
    });
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    const all = await rows(t);
    expect(all.map((row) => `${row.source}:${row.kind}:${row.pushLevel}`).sort()).toEqual([
      'calendar:rsvp:none',
      'mail:change:none',
      'slack:action:none',
    ]);
    expect(all.every((row) => row.pushedAt === undefined)).toBe(true);
  });

  const notice = 'We are updating the Bluefin Pay services agreement on Dec 1.';

  /** Routine notices with a phase 1 verdict (no routine answer), and an open change row each. */
  async function routineThreads(t: TestConvex<typeof schema>, threads: string[]) {
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      grantId: `grant-${ACCOUNT}`,
      provider: 'google',
      threads: [],
      messages: threads.map((thread) => ({
        providerMessageId: `msg-${thread}`,
        providerThreadId: thread,
        subject: 'Updates to our services agreement',
        from: 'Bluefin Pay <notice@bluefin.test>',
        to: 'owner@example.test',
        receivedAt: CLOCK - 2 * HOUR,
        snippet: notice,
        textBody: notice,
        searchText: notice,
        labels: ['INBOX'],
      })),
    });
    await t.run(async (ctx) => {
      const corpus = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) => q.eq('userId', USER))
        .collect();
      for (const row of corpus) {
        const messageId = row.latestMessageId as string;
        await ctx.db.patch(row._id, {
          llmPending: undefined,
          jev: assessment({
            sourceMessageId: messageId,
            purpose: 'transaction',
            subjectKind: 'finance',
            obligations: [],
            meaningfulChange: true,
            changeEvidence: { messageId, text: notice },
            probabilities: { reply: 0.02, action: 0.02, waiting: 0.02, change: 0.95 },
          }),
        });
        await openMailRow(ctx, row.providerThreadId, { messageId, pushLevel: 'time_sensitive' });
      }
    });
  }

  function openMailRow(ctx: any, thread: string, patch: Record<string, unknown> = {}) {
    return ctx.db.insert('obligations', {
      userId: USER,
      kind: 'change',
      state: 'open',
      source: 'mail',
      sourceKey: mailSourceKey(ACCOUNT, thread),
      accountId: ACCOUNT,
      threadId: thread,
      title: 'Changed',
      asker: 'Bluefin Pay',
      due: 'none',
      probability: 0.95,
      pushLevel: 'none',
      openedAt: CLOCK - HOUR,
      createdAt: CLOCK - HOUR,
      updatedAt: CLOCK - HOUR,
      ...patch,
    });
  }

  async function flagDoc(t: TestConvex<typeof schema>) {
    return (await t.run((ctx) => ctx.db.query('userDocs').collect())).find(
      (row) => row.kind === 'needsYouFlag',
    )?.doc;
  }

  test('the repair reads a page of threads at a time, skips none as rows close, and saves the version last', async () => {
    const t = harness();
    await connect(t);
    const threads = Array.from(
      { length: 2 * BACKFILL_THREADS + 10 },
      (_, i) => `th-${String(i).padStart(3, '0')}`,
    );
    await routineThreads(t, threads);
    await t.run((ctx) =>
      ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'needsYouFlag',
        key: 'default',
        doc: { enabled: true },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    // One page: at most BACKFILL_THREADS threads, and the next page waits.
    expect(await t.mutation(internal.jev.repairObligations, { userId: USER })).toEqual({
      synced: BACKFILL_THREADS,
      done: false,
    });
    await drain(t);
    // Each page closed its rows; the next page still read every thread after it.
    const all = await rows(t);
    expect(all).toHaveLength(threads.length);
    expect(all.every((row) => row.state === 'resolved' && row.closeReason === 'evidence')).toBe(true);
    const pages: Array<{ name: string; args: any[]; state: { kind: string } }> = await t.run((ctx) =>
      (ctx.db as any).system.query('_scheduled_functions').collect(),
    );
    const repairs = pages.filter((job) => job.name.includes('repairObligations'));
    expect(repairs.map((job) => [job.args[0].after, job.state.kind])).toEqual([
      [mailSourceKey(ACCOUNT, threads[BACKFILL_THREADS - 1]), 'success'],
      [mailSourceKey(ACCOUNT, threads[2 * BACKFILL_THREADS - 1]), 'success'],
    ]);
    // The version changes only after the last page, and the progress goes.
    expect(await flagDoc(t)).toEqual({ enabled: true, rulesVersion: OBLIGATION_RULES_VERSION });
    expect(await t.run((ctx) => ctx.db.query('albatrossNotifications').collect())).toEqual([]);
  });

  test('a stopped repair resumes at its last page; a claim waits while a repair runs', async () => {
    const t = harness();
    await connect(t);
    await routineThreads(t, ['th-a', 'th-b', 'th-c']);
    // A repair stopped after the page that ended at th-a, five minutes ago.
    const stopped = {
      enabled: true,
      repairAt: CLOCK - 5 * 60_000,
      repairAfter: mailSourceKey(ACCOUNT, 'th-a'),
    };
    await t.run((ctx) =>
      ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'needsYouFlag',
        key: 'default',
        doc: stopped,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    expect((await rows(t)).every((row) => row.state === 'open')).toBe(true);
    expect(await flagDoc(t)).toEqual(stopped);
    // No page for the lease: the next claim resumes after th-a, not from the start.
    setSystemTime(new Date(CLOCK - 5 * 60_000 + REPAIR_LEASE_MS));
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await drain(t);
    const byThread = Object.fromEntries((await rows(t)).map((row) => [row.threadId, row.state]));
    expect(byThread).toEqual({ 'th-a': 'open', 'th-b': 'resolved', 'th-c': 'resolved' });
    expect(await flagDoc(t)).toEqual({ enabled: true, rulesVersion: OBLIGATION_RULES_VERSION });
  });

  test('a page that reads REPAIR_SCAN rows reads its last thread again on the next page', async () => {
    const t = harness();
    const closed = Array.from({ length: REPAIR_SCAN - 1 }, (_, i) => `c-${String(i).padStart(3, '0')}`);
    await t.run(async (ctx) => {
      for (const thread of closed) await openMailRow(ctx, thread, { state: 'resolved', closedAt: CLOCK });
      // The 200th row is a closed change of th-z; its open reply is the 201st.
      await openMailRow(ctx, 'th-z', { state: 'resolved', closedAt: CLOCK });
      await openMailRow(ctx, 'th-z', { kind: 'reply' });
    });
    const first = await t.run((ctx) => openMailThreadPage(ctx, USER, BACKFILL_THREADS));
    expect(first).toEqual({ threads: [], next: mailSourceKey(ACCOUNT, closed[closed.length - 1]) });
    const second = await t.run((ctx) => openMailThreadPage(ctx, USER, BACKFILL_THREADS, first.next));
    expect(second).toEqual({ threads: [{ accountId: ACCOUNT, threadId: 'th-z' }] });
    // A full page of threads stops before the next open thread.
    await t.run(async (ctx) => {
      await openMailRow(ctx, 'th-x', { state: 'snoozed', snoozedUntil: CLOCK + DAY });
      await openMailRow(ctx, 'th-y');
      await openMailRow(ctx, 'th-y', { kind: 'code' });
    });
    const limited = await t.run((ctx) => openMailThreadPage(ctx, USER, 1, first.next));
    expect(limited).toEqual({
      threads: [{ accountId: ACCOUNT, threadId: 'th-x' }],
      next: mailSourceKey(ACCOUNT, 'th-x'),
    });
    expect(await t.run((ctx) => openMailThreadPage(ctx, USER, 1, limited.next))).toEqual({
      threads: [{ accountId: ACCOUNT, threadId: 'th-y' }],
      next: mailSourceKey(ACCOUNT, 'th-y'),
    });
  });
});
