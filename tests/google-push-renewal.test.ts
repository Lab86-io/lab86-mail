import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { GoogleApiError } from '../lib/google/errors';
import { hashChannelToken } from '../lib/google/push/channel-token';
import {
  __setGooglePushRenewalDepsForTest,
  type GooglePushPlan,
  MAX_REGISTRATIONS_PER_RUN,
  type PlanChannel,
  reconcileGooglePush,
  stopDrivePushForConnection,
  stopGooglePushForGrant,
} from '../lib/google/push/renewal';
import {
  PUSH_CHANNEL_TTL_MS,
  PUSH_RETRY_AFTER_FAILURE_MS,
  PUSH_RETRY_AFTER_UNSUPPORTED_MS,
} from '../lib/google/push/rules';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USER = 'user_1';
const GRANT = 'google:11111111-1111-4111-8111-111111111111';
const TOPIC = 'projects/lab86-mail-production/topics/gmail-push';

interface World {
  flags: { gmail: boolean; calendar: boolean; drive: boolean };
  config: { topic: string; audience: string; serviceAccount: string } | null;
  addresses: boolean;
  plan: GooglePushPlan;
  stopPlan: any;
  connectionRows: PlanChannel[];
  calls: Array<[string, ...unknown[]]>;
  mutations: Array<{ name: string; args: any }>;
  failures: Record<string, Error>;
  accessToken: string | null | Error;
  ids: number;
  queryError?: Error;
}

let world: World;

const account = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'acct_1',
  grantId: GRANT,
  email: 'ann@example.com',
  status: 'connected',
  ...overrides,
});

const channel = (overrides: Partial<PlanChannel> = {}): PlanChannel => ({
  userId: USER,
  kind: 'calendar',
  channelId: 'old-channel',
  accountId: 'acct_1',
  grantId: GRANT,
  calendarId: 'primary@example.com',
  resourceId: 'res-old',
  status: 'active',
  requestedAt: NOW - DAY,
  renewedAt: NOW - DAY,
  expiration: NOW + 5 * DAY,
  lastMessageAt: NOW - DAY + 1000,
  ...overrides,
});

const plan = (overrides: Partial<GooglePushPlan> = {}): GooglePushPlan => ({
  accounts: [account()],
  calendars: [],
  drives: [],
  contentEnabled: true,
  channels: [],
  ...overrides,
});

function failOr<T>(name: string, value: T): T {
  const error = world.failures[name];
  if (error) throw error;
  return value;
}

function install() {
  __setGooglePushRenewalDepsForTest({
    flags: () => world.flags,
    gmailConfig: () => world.config,
    address: (kind) => (world.addresses ? `https://mail.lab86.io/api/google/push/${kind}` : null),
    query: (async (fn: unknown, args: any) => {
      const name = getFunctionName(fn as any);
      world.calls.push(['query', name, args]);
      if (world.queryError) throw world.queryError;
      if (name === 'googlePush:userPlan') return world.plan;
      if (name === 'googlePush:stopPlanForGrant') return world.stopPlan;
      if (name === 'googlePush:channelsForConnection') return world.connectionRows;
      return null;
    }) as any,
    mutate: (async (fn: unknown, args: any) => {
      const name = getFunctionName(fn as any);
      world.mutations.push({ name, args });
      if (name === 'googlePush:beginRegistration') return { channelId: args.channelId, requestedAt: NOW };
      if (name === 'googlePush:removeChannels') return { removed: args.channelIds.length };
      return { updated: true };
    }) as any,
    watchGmailMailbox: (async (grantId: string, topic: string) => {
      world.calls.push(['watchGmail', grantId, topic]);
      return failOr('watchGmail', { historyId: '555', expiration: NOW + 7 * DAY });
    }) as any,
    stopGmailMailbox: (async (grantId: string) => {
      world.calls.push(['stopGmail', grantId]);
      failOr('stopGmail', undefined);
    }) as any,
    watchCalendarEvents: (async (grantId: string, calendarId: string, request: any) => {
      world.calls.push(['watchCalendar', grantId, calendarId, request]);
      return failOr('watchCalendar', { resourceId: `res-${calendarId}`, expiration: request.expiration });
    }) as any,
    stopCalendarChannel: (async (grantId: string, target: any) => {
      world.calls.push(['stopCalendar', grantId, target]);
      failOr('stopCalendar', undefined);
    }) as any,
    watchDriveChanges: (async (accessToken: string, pageToken: string, request: any) => {
      world.calls.push(['watchDrive', accessToken, pageToken, request.id]);
      return failOr('watchDrive', { resourceId: 'drive-res', expiration: request.expiration });
    }) as any,
    stopDriveChannel: (async (accessToken: string, target: any) => {
      world.calls.push(['stopDrive', accessToken, target]);
      failOr('stopDrive', undefined);
    }) as any,
    driveStartPageToken: (async (accessToken: string) => {
      world.calls.push(['startPageToken', accessToken]);
      return 'start-token';
    }) as any,
    driveAccessToken: async () => {
      if (world.accessToken instanceof Error) throw world.accessToken;
      return world.accessToken;
    },
    newChannelId: () => `new-channel-${++world.ids}`,
    newChannelToken: () => `token-${world.ids}`,
    now: () => NOW,
  });
}

const callNames = () => world.calls.filter(([kind]) => kind !== 'query').map(([kind]) => kind);
const mutationNames = () => world.mutations.map((m) => m.name);
const removed = () =>
  world.mutations.filter((m) => m.name === 'googlePush:removeChannels').flatMap((m) => m.args.channelIds);

let warn: typeof console.warn;

beforeEach(() => {
  world = {
    flags: { gmail: false, calendar: false, drive: false },
    config: { topic: TOPIC, audience: 'aud', serviceAccount: 'sa@example.com' },
    addresses: true,
    plan: plan(),
    stopPlan: null,
    connectionRows: [],
    calls: [],
    mutations: [],
    failures: {},
    accessToken: 'drive-access',
    ids: 0,
  };
  install();
  warn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  console.warn = warn;
  __setGooglePushRenewalDepsForTest();
});

describe('Gmail watch renewal', () => {
  test('all flags off and no rows: nothing happens', async () => {
    expect(await reconcileGooglePush(USER)).toEqual({
      registered: 0,
      renewed: 0,
      failed: 0,
      stopped: 0,
      removed: 0,
    });
    expect(callNames()).toEqual([]);
    expect(world.mutations).toEqual([]);
  });

  test('a connected direct mailbox without a watch gets one', async () => {
    world.flags.gmail = true;
    world.plan = plan({ accounts: [account(), account({ accountId: 'acct_2', status: 'error' })] });
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ registered: 1, renewed: 0, failed: 0 });
    expect(world.calls.filter(([kind]) => kind === 'watchGmail')).toEqual([['watchGmail', GRANT, TOPIC]]);
    expect(world.mutations).toEqual([
      {
        name: 'googlePush:beginRegistration',
        args: {
          userId: USER,
          kind: 'gmail',
          channelId: 'new-channel-1',
          accountId: 'acct_1',
          grantId: GRANT,
        },
      },
      {
        name: 'googlePush:finishRegistration',
        args: {
          userId: USER,
          channelId: 'new-channel-1',
          outcome: 'active',
          expiration: NOW + 7 * DAY,
          historyId: '555',
        },
      },
    ]);
  });

  test('a fresh watch is left alone; a day-old watch is renewed on its own row', async () => {
    world.flags.gmail = true;
    world.plan = plan({
      channels: [
        channel({ kind: 'gmail', channelId: 'gmail-row', calendarId: undefined, renewedAt: NOW - HOUR }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(callNames()).toEqual([]);
    world.plan = plan({
      channels: [
        channel({ kind: 'gmail', channelId: 'gmail-row', calendarId: undefined, renewedAt: NOW - DAY }),
      ],
    });
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ renewed: 1, registered: 0 });
    expect(world.mutations[0].args.channelId).toBe('gmail-row');
  });

  test('a watch of another grant is made again for the current grant', async () => {
    world.flags.gmail = true;
    world.plan = plan({
      channels: [
        channel({
          kind: 'gmail',
          channelId: 'gmail-row',
          grantId: 'google:old',
          calendarId: undefined,
          renewedAt: NOW,
        }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(world.calls.filter(([kind]) => kind === 'watchGmail')).toEqual([['watchGmail', GRANT, TOPIC]]);
  });

  test('a refused watch is stored as failed with a retry time', async () => {
    world.flags.gmail = true;
    world.failures.watchGmail = new GoogleApiError(403, 'User not authorized to perform this action.');
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ failed: 1, registered: 0 });
    expect(world.mutations[1]).toEqual({
      name: 'googlePush:finishRegistration',
      args: {
        userId: USER,
        channelId: 'new-channel-1',
        outcome: 'failed',
        error: '403: User not authorized to perform this action.',
        retryAfter: NOW + PUSH_RETRY_AFTER_FAILURE_MS,
      },
    });
  });

  test('flag off: the watch of a live mailbox stops at Google, and every Gmail row goes', async () => {
    world.plan = plan({
      accounts: [account(), account({ accountId: 'acct_err', grantId: 'google:err', status: 'error' })],
      channels: [
        channel({ kind: 'gmail', channelId: 'g1', calendarId: undefined }),
        channel({
          kind: 'gmail',
          channelId: 'g2',
          accountId: 'acct_err',
          grantId: 'google:err',
          calendarId: undefined,
        }),
        channel({ kind: 'gmail', channelId: 'g3', accountId: 'acct_gone', calendarId: undefined }),
      ],
    });
    const summary = await reconcileGooglePush(USER);
    expect(world.calls.filter(([kind]) => kind === 'stopGmail')).toEqual([['stopGmail', GRANT]]);
    expect(removed().sort()).toEqual(['g1', 'g2', 'g3']);
    expect(summary).toMatchObject({ stopped: 1, removed: 3 });
  });

  test('flag on without the Pub/Sub settings counts as off', async () => {
    world.flags.gmail = true;
    world.config = null;
    world.plan = plan({ channels: [channel({ kind: 'gmail', channelId: 'g1', calendarId: undefined })] });
    await reconcileGooglePush(USER);
    expect(callNames()).toEqual(['stopGmail']);
    expect(removed()).toEqual(['g1']);
  });

  test('a failed stop or a failed row still goes', async () => {
    world.failures.stopGmail = new Error('network');
    world.plan = plan({
      channels: [
        channel({ kind: 'gmail', channelId: 'g1', calendarId: undefined }),
        channel({ kind: 'gmail', channelId: 'g2', calendarId: undefined, status: 'failed' }),
      ],
    });
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ stopped: 0, removed: 2 });
  });

  test('a second run for the same user while one runs is skipped', async () => {
    world.flags.gmail = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    __setGooglePushRenewalDepsForTest({
      flags: () => world.flags,
      query: (async () => {
        await gate;
        return plan({ accounts: [] });
      }) as any,
    });
    const first = reconcileGooglePush(USER);
    expect(await reconcileGooglePush(USER)).toMatchObject({ skipped: 'busy' });
    release();
    expect(await first).toEqual({ registered: 0, renewed: 0, failed: 0, stopped: 0, removed: 0 });
  });
});

describe('Calendar channel renewal', () => {
  test('each calendar of a connected direct account gets a channel with a hashed token', async () => {
    world.flags.calendar = true;
    world.plan = plan({
      accounts: [account(), account({ accountId: 'acct_off', grantId: 'google:off', status: 'error' })],
      calendars: [
        { accountId: 'acct_1', calendarId: 'primary@example.com' },
        { accountId: 'acct_1', calendarId: 'team@group.calendar.google.com' },
        { accountId: 'acct_off', calendarId: 'ignored' },
      ],
    });
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ registered: 2, failed: 0 });
    const watches = world.calls.filter(([kind]) => kind === 'watchCalendar');
    expect(watches.map((call) => call[2])).toEqual(['primary@example.com', 'team@group.calendar.google.com']);
    expect(watches[0][3]).toEqual({
      id: 'new-channel-1',
      token: 'token-1',
      address: 'https://mail.lab86.io/api/google/push/calendar',
      expiration: NOW + PUSH_CHANNEL_TTL_MS,
    });
    const begin = world.mutations.find((m) => m.name === 'googlePush:beginRegistration');
    expect(begin?.args).toEqual({
      userId: USER,
      kind: 'calendar',
      channelId: 'new-channel-1',
      tokenHash: hashChannelToken('token-1'),
      accountId: 'acct_1',
      grantId: GRANT,
      calendarId: 'primary@example.com',
    });
    expect(JSON.stringify(world.mutations)).not.toContain('"token-1"');
    const finish = world.mutations.find((m) => m.name === 'googlePush:finishRegistration');
    expect(finish?.args).toEqual({
      userId: USER,
      channelId: 'new-channel-1',
      outcome: 'active',
      resourceId: 'res-primary@example.com',
      expiration: NOW + PUSH_CHANNEL_TTL_MS,
    });
  });

  test('without an HTTPS address no channel is made', async () => {
    world.flags.calendar = true;
    world.addresses = false;
    world.plan = plan({ calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }] });
    expect(await reconcileGooglePush(USER)).toMatchObject({ registered: 0 });
    expect(world.mutations).toEqual([]);
  });

  test('a live channel stays; older duplicates stop and go', async () => {
    world.flags.calendar = true;
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }],
      channels: [
        channel({ channelId: 'newest', requestedAt: NOW - HOUR }),
        channel({ channelId: 'older', requestedAt: NOW - 2 * DAY, resourceId: 'res-older' }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(world.calls.filter(([kind]) => kind === 'stopCalendar')).toEqual([
      ['stopCalendar', GRANT, { channelId: 'older', resourceId: 'res-older' }],
    ]);
    expect(removed()).toEqual(['older']);
  });

  test('a channel that ends within two days gets a replacement, and then the old one stops', async () => {
    world.flags.calendar = true;
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }],
      channels: [channel({ channelId: 'ending', expiration: NOW + DAY })],
    });
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ registered: 1, stopped: 1, removed: 1 });
    expect(callNames()).toEqual(['watchCalendar', 'stopCalendar']);
    expect(removed()).toEqual(['ending']);
  });

  test('a failed replacement keeps the old live channel', async () => {
    world.flags.calendar = true;
    world.failures.watchCalendar = new GoogleApiError(500, 'backend error');
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }],
      channels: [channel({ channelId: 'ending', expiration: NOW + DAY })],
    });
    const summary = await reconcileGooglePush(USER);
    expect(summary).toMatchObject({ failed: 1, removed: 0 });
    expect(removed()).toEqual([]);
    const finish = world.mutations.find((m) => m.name === 'googlePush:finishRegistration');
    expect(finish?.args).toMatchObject({ outcome: 'failed', retryAfter: NOW + PUSH_RETRY_AFTER_FAILURE_MS });
  });

  test('a calendar that Google cannot watch waits a week and is not retried each hour', async () => {
    world.flags.calendar = true;
    world.failures.watchCalendar = new GoogleApiError(
      400,
      'Push notifications are not supported by this resource.',
      'pushNotSupportedForRequestedResource',
    );
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'en.usa#holiday@group.v.calendar.google.com' }],
    });
    await reconcileGooglePush(USER);
    const finish = world.mutations.find((m) => m.name === 'googlePush:finishRegistration');
    expect(finish?.args).toMatchObject({
      outcome: 'failed',
      unsupported: true,
      retryAfter: NOW + PUSH_RETRY_AFTER_UNSUPPORTED_MS,
    });
    // The next run sees the failed row and makes no call.
    world.calls = [];
    world.mutations = [];
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'en.usa#holiday@group.v.calendar.google.com' }],
      channels: [
        channel({
          channelId: 'holiday',
          calendarId: 'en.usa#holiday@group.v.calendar.google.com',
          status: 'failed',
          unsupported: true,
          resourceId: undefined,
          retryAfter: NOW + 6 * DAY,
        }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(callNames()).toEqual([]);
    expect(world.mutations).toEqual([]);
  });

  test('a stuck pending row is replaced and goes without a stop', async () => {
    world.flags.calendar = true;
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }],
      channels: [
        channel({ channelId: 'stuck', status: 'pending', resourceId: undefined, requestedAt: NOW - HOUR }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(callNames()).toEqual(['watchCalendar']);
    expect(removed()).toEqual(['stuck']);
  });

  test('rows of a removed calendar, another grant, or a dead account go; only a live grant stops them', async () => {
    world.flags.calendar = true;
    world.plan = plan({
      accounts: [account(), account({ accountId: 'acct_err', grantId: 'google:err', status: 'error' })],
      calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }],
      channels: [
        channel({ channelId: 'keep' }),
        channel({ channelId: 'removed-calendar', calendarId: 'gone@example.com', resourceId: 'res-gone' }),
        channel({ channelId: 'other-grant', grantId: 'google:previous', requestedAt: NOW }),
        channel({ channelId: 'dead-account', accountId: 'acct_err', grantId: 'google:err' }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(world.calls.filter(([kind]) => kind === 'stopCalendar')).toEqual([
      ['stopCalendar', GRANT, { channelId: 'removed-calendar', resourceId: 'res-gone' }],
    ]);
    expect(removed().sort()).toEqual(['dead-account', 'other-grant', 'removed-calendar']);
  });

  test('flag off: every calendar channel stops and goes; a failed stop is logged', async () => {
    world.failures.stopCalendar = new Error('network');
    world.plan = plan({
      calendars: [{ accountId: 'acct_1', calendarId: 'primary@example.com' }],
      channels: [channel({ channelId: 'c1' })],
    });
    const summary = await reconcileGooglePush(USER);
    expect(callNames()).toEqual(['stopCalendar']);
    expect(summary).toMatchObject({ stopped: 0, removed: 1 });
  });

  test('one run makes at most the registration limit; the rest wait for the next run', async () => {
    world.flags.calendar = true;
    world.plan = plan({
      calendars: Array.from({ length: MAX_REGISTRATIONS_PER_RUN + 5 }, (_, i) => ({
        accountId: 'acct_1',
        calendarId: `cal-${i}`,
      })),
    });
    const summary = await reconcileGooglePush(USER);
    expect(summary.registered).toBe(MAX_REGISTRATIONS_PER_RUN);
  });
});

describe('Drive channel renewal', () => {
  const drive = { connectionId: 'conn_1', status: 'connected', pageToken: 'stored-token' };

  test('a connected Drive connection gets a channel from its stored page token', async () => {
    world.flags.drive = true;
    world.plan = plan({ accounts: [], drives: [drive] });
    expect(await reconcileGooglePush(USER)).toMatchObject({ registered: 1 });
    expect(world.calls.filter(([kind]) => kind === 'watchDrive')).toEqual([
      ['watchDrive', 'drive-access', 'stored-token', 'new-channel-1'],
    ]);
    const begin = world.mutations.find((m) => m.name === 'googlePush:beginRegistration');
    expect(begin?.args).toMatchObject({ kind: 'drive', connectionId: 'conn_1' });
  });

  test('without a stored page token the channel starts from the current position', async () => {
    world.flags.drive = true;
    world.plan = plan({ accounts: [], drives: [{ connectionId: 'conn_1', status: 'connected' }] });
    await reconcileGooglePush(USER);
    expect(callNames()).toEqual(['startPageToken', 'watchDrive']);
  });

  test('no access or a failed access read makes no channel', async () => {
    world.flags.drive = true;
    world.plan = plan({ accounts: [], drives: [drive] });
    world.accessToken = null;
    expect(await reconcileGooglePush(USER)).toMatchObject({ registered: 0 });
    world.accessToken = new Error('File access expired. Reconnect this account.');
    expect(await reconcileGooglePush(USER)).toMatchObject({ registered: 0 });
    expect(world.mutations).toEqual([]);
  });

  test('content indexing off, a broken connection, or a gone connection retires the channel', async () => {
    world.flags.drive = true;
    world.plan = plan({
      accounts: [],
      contentEnabled: false,
      drives: [drive],
      channels: [
        channel({
          kind: 'drive',
          channelId: 'd1',
          connectionId: 'conn_1',
          accountId: undefined,
          grantId: undefined,
        }),
        channel({
          kind: 'drive',
          channelId: 'd2',
          connectionId: 'conn_gone',
          accountId: undefined,
          grantId: undefined,
        }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(world.calls.filter(([kind]) => kind === 'stopDrive')).toEqual([
      ['stopDrive', 'drive-access', { channelId: 'd1', resourceId: 'res-old' }],
    ]);
    expect(removed().sort()).toEqual(['d1', 'd2']);
  });

  test('flag off: Drive channels stop; without access they only go', async () => {
    world.accessToken = null;
    world.plan = plan({
      accounts: [],
      drives: [drive],
      channels: [
        channel({
          kind: 'drive',
          channelId: 'd1',
          connectionId: 'conn_1',
          accountId: undefined,
          grantId: undefined,
        }),
      ],
    });
    await reconcileGooglePush(USER);
    expect(callNames()).toEqual([]);
    expect(removed()).toEqual(['d1']);
  });
});

describe('stop before a disconnect', () => {
  test('with all flags off nothing is read', async () => {
    await stopGooglePushForGrant(GRANT);
    await stopDrivePushForConnection(USER, 'conn_1');
    expect(world.calls).toEqual([]);
  });

  test('a grant stops its Gmail watch once and each Calendar channel, then the rows go', async () => {
    world.flags.gmail = true;
    world.stopPlan = {
      userId: USER,
      sharedMailbox: false,
      channels: [
        channel({ kind: 'gmail', channelId: 'g1', calendarId: undefined }),
        channel({ channelId: 'c1', resourceId: 'r1' }),
        channel({ channelId: 'c2', resourceId: undefined, status: 'pending' }),
        channel({ channelId: 'c3', resourceId: 'r3', status: 'failed' }),
      ],
    };
    await stopGooglePushForGrant(GRANT);
    expect(world.calls.filter(([kind]) => kind !== 'query')).toEqual([
      ['stopGmail', GRANT],
      ['stopCalendar', GRANT, { channelId: 'c1', resourceId: 'r1' }],
    ]);
    expect(removed()).toEqual(['g1', 'c1', 'c2', 'c3']);
  });

  test('a shared mailbox keeps its Gmail watch; failures do not stop the cleanup', async () => {
    world.flags.calendar = true;
    world.failures.stopCalendar = new Error('network');
    world.stopPlan = {
      userId: USER,
      sharedMailbox: true,
      channels: [
        channel({ kind: 'gmail', channelId: 'g1', calendarId: undefined }),
        channel({ channelId: 'c1' }),
      ],
    };
    await stopGooglePushForGrant(GRANT);
    expect(callNames()).toEqual(['stopCalendar']);
    expect(removed()).toEqual(['g1', 'c1']);
  });

  test('a grant without rows, or a failed read, does nothing more', async () => {
    world.flags.drive = true;
    await stopGooglePushForGrant(GRANT);
    world.queryError = new Error('convex down');
    await stopGooglePushForGrant(GRANT);
    expect(world.mutations).toEqual([]);
  });

  test('a Drive connection stops its channels with its token, then the rows go', async () => {
    world.flags.drive = true;
    world.connectionRows = [
      channel({ kind: 'drive', channelId: 'd1', connectionId: 'conn_1', resourceId: 'r1' }),
      channel({
        kind: 'drive',
        channelId: 'd2',
        connectionId: 'conn_1',
        resourceId: undefined,
        status: 'pending',
      }),
    ];
    world.failures.stopDrive = new Error('network');
    await stopDrivePushForConnection(USER, 'conn_1');
    expect(callNames()).toEqual(['stopDrive']);
    expect(removed()).toEqual(['d1', 'd2']);
  });

  test('a Drive connection without access, without rows, or with a failed read', async () => {
    world.flags.drive = true;
    await stopDrivePushForConnection(USER, 'conn_1');
    expect(world.mutations).toEqual([]);
    world.connectionRows = [channel({ kind: 'drive', channelId: 'd1', connectionId: 'conn_1' })];
    world.accessToken = new Error('expired');
    await stopDrivePushForConnection(USER, 'conn_1');
    expect(callNames()).toEqual([]);
    expect(removed()).toEqual(['d1']);
    world.queryError = new Error('convex down');
    await stopDrivePushForConnection(USER, 'conn_1');
    expect(mutationNames()).toEqual(['googlePush:removeChannels']);
  });
});
