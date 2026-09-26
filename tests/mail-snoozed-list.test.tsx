import './tools/harness';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { SnoozedThreadsList } from '../components/inbox/SnoozedThreads';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { AGENT_TOOL_NAMES } from '../lib/ai/loop';
import { type SnoozedThreadRow, snoozeReturnLabel, unsnoozeSnoozedThread } from '../lib/mail/snoozed';
import { unsnoozeThread } from '../lib/store/snooze';
import { TOOLS } from '../lib/tools';
import { listSnoozed, listSnoozedForUser } from '../lib/tools/mail';
import { toolContext } from './tools/harness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};

const SECRET = 'snoozed-list-secret';
const USER = 'snoozed_list_user';
const HOUR = 3_600_000;
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

type Harness = ReturnType<typeof newHarness>;

async function seedMailbox(t: Harness) {
  await t.run(async (ctx) => {
    await ctx.db.insert('connectedAccounts', {
      userId: USER,
      accountId: 'acct_1',
      email: 'me@example.test',
      provider: 'google',
      grantId: 'grant_1',
      status: 'connected',
      scopes: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('mailCorpusThreads', {
      userId: USER,
      accountId: 'acct_1',
      grantId: 'grant_1',
      provider: 'google',
      providerThreadId: 't1',
      subject: 'Quarterly plan',
      fromAddress: 'Alice <alice@example.com>',
      lastDate: 5_000,
      snippet: 'Draft attached for review',
      labels: [],
      unread: false,
      yearMonth: '2026-09',
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

function snooze(t: Harness, threadId: string, untilTs: number, userId = USER) {
  return t.mutation(api.mailCorpus.createSnooze, {
    internalSecret: SECRET,
    userId,
    accountId: 'acct_1',
    threadId,
    untilTs,
  });
}

const asUser = (t: Harness, userId = USER) => t.withIdentity({ subject: userId });
const internalQuery = (t: Harness) => (fn: any, args: Record<string, unknown>) =>
  t.query(fn, { ...args, internalSecret: SECRET }) as Promise<any>;

describe('Snoozed list query', () => {
  test('lists only the signed-in user active snoozes, newest first, with thread details', async () => {
    const t = newHarness();
    await seedMailbox(t);
    const now = Date.now();
    await snooze(t, 't1', now + HOUR);
    // The thread is not in the corpus yet; the snooze still shows.
    await snooze(t, 't2', now + 2 * HOUR);
    await snooze(t, 't3', now + 3 * HOUR);
    await t.mutation(api.mailCorpus.cancelSnooze, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'acct_1',
      threadId: 't3',
    });
    await snooze(t, 't9', now + HOUR, 'someone_else');

    const { items } = await asUser(t).query(api.mailCorpus.listSnoozedThreads, {});
    expect(items.map((item: SnoozedThreadRow) => item.threadId)).toEqual(['t2', 't1']);
    expect(items[1]).toMatchObject({
      account: 'acct_1',
      accountEmail: 'me@example.test',
      subject: 'Quarterly plan',
      fromAddress: 'Alice <alice@example.com>',
      snippet: 'Draft attached for review',
      untilTs: now + HOUR,
      lastDate: 5_000,
    });
    expect(items[0]).toMatchObject({ subject: '(no subject)', fromAddress: '', lastDate: null });

    // Another user sees only their own snooze.
    const other = await asUser(t, 'someone_else').query(api.mailCorpus.listSnoozedThreads, {});
    expect(other.items.map((item: SnoozedThreadRow) => item.threadId)).toEqual(['t9']);
    expect(other.items[0].accountEmail).toBeNull();
  });

  test('requires a signed-in user, and the tool path requires the internal secret', async () => {
    const t = newHarness();
    await expect(t.query(api.mailCorpus.listSnoozedThreads, {})).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.mailCorpus.listSnoozedThreadsInternal, { internalSecret: 'wrong', userId: USER }),
    ).rejects.toThrow(/Invalid Convex internal secret/);
  });

  test('list_snoozed returns the same rows with an ISO return time', async () => {
    const t = newHarness();
    await seedMailbox(t);
    const until = Date.UTC(2026, 9, 2, 13, 0, 0);
    await snooze(t, 't1', until);
    const rows = await listSnoozedForUser(USER, 10, internalQuery(t) as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ threadId: 't1', untilTs: until, untilIso: '2026-10-02T13:00:00.000Z' });

    expect(TOOLS.list_snoozed).toBe(listSnoozed);
    expect(AGENT_TOOL_NAMES.has('list_snoozed')).toBe(true);
    // Without a Convex deployment the tool answers with an empty list.
    expect(await listSnoozed.handler({}, toolContext())).toEqual({ snoozed: [] });
  });
});

describe('Unsnooze from the list', () => {
  test('cancels the snooze, moves the thread back to the inbox, and the list drops it', async () => {
    const t = newHarness();
    await seedMailbox(t);
    await snooze(t, 't1', Date.now() + HOUR);
    const [row] = (await asUser(t).query(api.mailCorpus.listSnoozedThreads, {})).items;

    const moveThread = mock(async () => ({ ok: true }));
    const deps = {
      query: internalQuery(t),
      mutate: (fn: any, args: Record<string, unknown>) => t.mutation(fn, { ...args, internalSecret: SECRET }),
      moveThread,
      updateThread: mock(async () => ({ ok: true })),
    };
    // The web list calls the unsnooze_thread tool; its handler runs unsnoozeThread.
    const call = mock(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('unsnooze_thread');
      return unsnoozeThread(
        { userId: USER, ...(args as { account: string; threadId: string }) },
        deps as any,
      );
    });
    expect(await unsnoozeSnoozedThread(row, call)).toEqual({ restored: 1 });
    expect(call.mock.calls[0][1]).toEqual({ account: 'acct_1', threadId: 't1' });
    expect(moveThread).toHaveBeenCalledWith({ userId: USER, account: 'acct_1', threadId: 't1', to: 'inbox' });
    expect((await asUser(t).query(api.mailCorpus.listSnoozedThreads, {})).items).toEqual([]);
  });
});

describe('Snoozed list view', () => {
  const now = new Date(2026, 8, 26, 10, 0);
  const row: SnoozedThreadRow = {
    id: 'snooze_1',
    account: 'acct_1',
    accountEmail: 'me@example.test',
    threadId: 't1',
    messageId: null,
    untilTs: new Date(2026, 8, 27, 9, 0).getTime(),
    snoozedAt: now.getTime(),
    subject: 'Quarterly plan',
    fromAddress: 'Alice <alice@example.com>',
    snippet: 'Draft attached &amp; ready',
    lastDate: 5_000,
  };

  test('the return time reads as today, tomorrow, a date, or due now', () => {
    const at = (date: Date) => snoozeReturnLabel(date.getTime(), now, 'en-US').replace(/\s/g, ' ');
    expect(at(new Date(2026, 8, 26, 17, 0))).toBe('Back today at 5:00 PM');
    expect(at(new Date(2026, 8, 27, 9, 0))).toBe('Back tomorrow at 9:00 AM');
    const later = new Date(2026, 9, 2, 9, 0);
    const day = later.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    expect(at(later)).toBe(`Back ${day} at 9:00 AM`.replace(/\s/g, ' '));
    expect(at(new Date(2027, 0, 4, 9, 0))).toContain('2027');
    expect(snoozeReturnLabel(now.getTime() - 1, now)).toBe('Due back now');
    expect(snoozeReturnLabel(Number.NaN, now)).toBe('Due back now');
  });

  test('each row shows the thread, its mailbox, and when it comes back, with Unsnooze', async () => {
    const onUnsnooze = mock(() => {});
    const onOpen = mock(() => {});
    let view: any;
    await act(async () => {
      view = create(
        <SnoozedThreadsList
          loading={false}
          error={false}
          rows={[row]}
          onUnsnooze={onUnsnooze}
          onOpen={onOpen}
          now={now}
        />,
      );
    });
    const buttons = view.root.findAllByType('button');
    await act(async () =>
      buttons.find((b: any) => b.props['aria-label'] === 'Open Quarterly plan').props.onClick(),
    );
    expect(onOpen).toHaveBeenCalledWith(row);
    await act(async () => buttons[buttons.length - 1].props.onClick());
    expect(onUnsnooze).toHaveBeenCalledWith(row);
    await act(async () => view.unmount());

    const html = renderToStaticMarkup(
      <SnoozedThreadsList loading={false} error={false} rows={[row]} onUnsnooze={onUnsnooze} now={now} />,
    );
    expect(html).toContain('Quarterly plan');
    expect(html).toContain('me@example.test');
    expect(html).toContain('Draft attached &amp; ready');
    expect(html).toContain('Back tomorrow at 9:00');
    expect(html).toContain('Unsnooze');
    expect(
      renderToStaticMarkup(
        <SnoozedThreadsList
          loading={false}
          error={false}
          rows={[row]}
          unsnoozing="snooze_1"
          onUnsnooze={onUnsnooze}
          now={now}
        />,
      ),
    ).toContain('Unsnoozing…');
    const empty = (props: { loading?: boolean; error?: boolean }) =>
      renderToStaticMarkup(
        <SnoozedThreadsList loading={false} error={false} rows={[]} onUnsnooze={onUnsnooze} {...props} />,
      );
    expect(empty({})).toContain('Nothing is snoozed.');
    expect(empty({ loading: true })).toContain('Loading snoozed mail');
    expect(empty({ error: true })).toContain('Could not load snoozed mail.');
  });
});
