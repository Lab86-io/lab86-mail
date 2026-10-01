import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { hashChannelToken } from '../lib/google/push/channel-token';
import {
  __setGooglePushReceiveDepsForTest,
  CHANNEL_LOOKUPS_PER_MINUTE,
  decodeGmailPushMessage,
  handleChannelPush,
  handleGmailPush,
  MAX_PUSH_BODY_BYTES,
} from '../lib/google/push/receive';

const NOW = 1_800_000_000_000;
const CONFIG = {
  topic: 'projects/lab86-mail-production/topics/gmail-push',
  audience: 'https://mail.lab86.io/api/google/push/gmail',
  serviceAccount: 'gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com',
};
const CHANNEL_ID = '5f1c2a7e-4c1b-4b0e-9d3a-2a9c1e0b7f11';
const TOKEN = 'channel-secret';

interface World {
  flags: { gmail: boolean; calendar: boolean; drive: boolean };
  config: typeof CONFIG | null;
  verified: boolean;
  tokens: Array<string | null>;
  queries: Array<{ name: string; args: any }>;
  mutations: Array<{ name: string; args: any; options?: any }>;
  targets: Record<string, Array<{ userId: string; accountId: string }>>;
  channel: any;
  gmailSyncs: any[];
  gmailAnswers: any[];
  calendarSyncs: any[];
  calendarAnswers: any[];
  driveSyncs: any[];
  driveAnswers: any[];
  timers: Array<{ fn: () => void; ms: number }>;
  now: number;
  queryError?: Error;
}

let world: World;

function install() {
  __setGooglePushReceiveDepsForTest({
    flags: () => world.flags,
    gmailConfig: () => world.config,
    verifyToken: (async (token: string | null) => {
      world.tokens.push(token);
      return world.verified ? { ok: true, claims: {} } : { ok: false, reason: 'signature' };
    }) as any,
    query: (async (fn: unknown, args: any) => {
      const name = getFunctionName(fn as any);
      world.queries.push({ name, args });
      if (world.queryError) throw world.queryError;
      if (name === 'googlePush:gmailPushTargets') return world.targets[args.email] ?? [];
      if (name === 'googlePush:channelForPush') return world.channel;
      return null;
    }) as any,
    mutate: (async (fn: unknown, args: any, options?: any) => {
      world.mutations.push({ name: getFunctionName(fn as any), args, options });
      return { recorded: true };
    }) as any,
    syncGmail: (async (input: any) => {
      world.gmailSyncs.push(input);
      return world.gmailAnswers.shift() ?? { ok: true };
    }) as any,
    syncCalendar: (async (input: any) => {
      world.calendarSyncs.push(input);
      return world.calendarAnswers.shift() ?? { ok: true };
    }) as any,
    syncDrive: (async (input: any) => {
      world.driveSyncs.push(input);
      return world.driveAnswers.shift() ?? [{ ok: true, pending: false }];
    }) as any,
    now: () => world.now,
    schedule: (fn: () => void, ms: number) => {
      world.timers.push({ fn, ms });
      return world.timers.length;
    },
  });
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function fireTimer() {
  const timer = world.timers.shift();
  if (!timer) throw new Error('no timer to fire');
  timer.fn();
  await settle();
  return timer.ms;
}

function pubsubBody(payload: unknown, encoding: 'base64' | 'base64url' = 'base64') {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString(encoding),
      messageId: '1234',
      publishTime: '2026-10-01T00:00:00Z',
    },
    subscription: 'projects/lab86-mail-production/subscriptions/gmail-push-albatross',
  });
}

function gmailRequest(body: string, authorization = 'Bearer header.payload.signature') {
  let reads = 0;
  return {
    input: {
      authorization,
      readBody: async () => {
        reads += 1;
        return body;
      },
    },
    reads: () => reads,
  };
}

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function channelHeaders(overrides: Record<string, string> = {}) {
  return headers({
    'X-Goog-Channel-ID': CHANNEL_ID,
    'X-Goog-Channel-Token': TOKEN,
    'X-Goog-Resource-ID': 'res-1',
    'X-Goog-Resource-State': 'exists',
    'X-Goog-Message-Number': '2',
    ...overrides,
  });
}

beforeEach(() => {
  world = {
    flags: { gmail: true, calendar: true, drive: true },
    config: CONFIG,
    verified: true,
    tokens: [],
    queries: [],
    mutations: [],
    targets: { 'ann@example.com': [{ userId: 'user_1', accountId: 'acct_1' }] },
    channel: null,
    gmailSyncs: [],
    gmailAnswers: [],
    calendarSyncs: [],
    calendarAnswers: [],
    driveSyncs: [],
    driveAnswers: [],
    timers: [],
    now: NOW,
  };
  install();
});

afterEach(() => {
  __setGooglePushReceiveDepsForTest();
});

describe('decodeGmailPushMessage', () => {
  test('decodes the address and History id of a Pub/Sub message', () => {
    const body = JSON.parse(pubsubBody({ emailAddress: ' Ann@Example.com ', historyId: 9876543210 }));
    expect(decodeGmailPushMessage(body)).toEqual({
      emailAddress: 'ann@example.com',
      historyId: '9876543210',
      messageId: '1234',
    });
  });

  test('accepts base64url data and a string History id', () => {
    const body = JSON.parse(pubsubBody({ emailAddress: 'ann@example.com', historyId: '42' }, 'base64url'));
    expect(decodeGmailPushMessage(body)).toMatchObject({ emailAddress: 'ann@example.com', historyId: '42' });
    const noId = {
      message: { data: Buffer.from('{"emailAddress":"a@b.c","historyId":7}').toString('base64') },
    };
    expect(decodeGmailPushMessage(noId)).toEqual({ emailAddress: 'a@b.c', historyId: '7' });
  });

  test('refuses bodies that are not a Gmail notification', () => {
    const encode = (value: string) => ({ message: { data: Buffer.from(value).toString('base64') } });
    expect(decodeGmailPushMessage(null)).toBeNull();
    expect(decodeGmailPushMessage({})).toBeNull();
    expect(decodeGmailPushMessage({ message: { data: '' } })).toBeNull();
    expect(decodeGmailPushMessage({ message: { data: 'x'.repeat(5000) } })).toBeNull();
    expect(decodeGmailPushMessage(encode('not json'))).toBeNull();
    expect(decodeGmailPushMessage(encode('{"historyId":1}'))).toBeNull();
    expect(decodeGmailPushMessage(encode('{"emailAddress":"no-at-sign","historyId":1}'))).toBeNull();
    expect(decodeGmailPushMessage(encode('{"emailAddress":"a@b.c"}'))).toBeNull();
    expect(decodeGmailPushMessage(encode('{"emailAddress":"a@b.c","historyId":"12a"}'))).toBeNull();
    expect(decodeGmailPushMessage(encode('{"emailAddress":"a@b.c","historyId":1.5}'))).toBeNull();
    expect(
      decodeGmailPushMessage(encode(`{"emailAddress":"${'a'.repeat(330)}@b.c","historyId":1}`)),
    ).toBeNull();
  });
});

describe('Gmail push route', () => {
  const good = () => pubsubBody({ emailAddress: 'ann@example.com', historyId: 100 });

  test('with the flag off the route answers 204 and does nothing', async () => {
    world.flags.gmail = false;
    const request = gmailRequest(good());
    const result = await handleGmailPush(request.input);
    expect(result).toMatchObject({ status: 204, reason: 'disabled' });
    expect(await result.done).toBe('disabled');
    expect(world.tokens).toEqual([]);
    expect(request.reads()).toBe(0);
    expect(world.queries).toEqual([]);
  });

  test('without the Pub/Sub settings the route refuses with 401 and logs once', async () => {
    world.config = null;
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      expect((await handleGmailPush(gmailRequest(good()).input)).status).toBe(401);
      expect((await handleGmailPush(gmailRequest(good()).input)).reason).toBe('not_configured');
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
    expect(world.tokens).toEqual([]);
  });

  test('a request without a valid token gets 401, and the body is not read', async () => {
    world.verified = false;
    const request = gmailRequest(good(), 'Bearer forged.token.value');
    const result = await handleGmailPush(request.input);
    expect(result).toMatchObject({ status: 401, reason: 'signature' });
    expect(world.tokens).toEqual(['forged.token.value']);
    expect(request.reads()).toBe(0);
    const missing = await handleGmailPush(gmailRequest(good(), 'Basic abc').input);
    expect(missing.status).toBe(401);
    expect(world.tokens.at(-1)).toBeNull();
  });

  test('bad input is acknowledged with 204, so Pub/Sub does not send it again', async () => {
    expect((await handleGmailPush(gmailRequest('not json').input)).reason).toBe('bad_message');
    expect((await handleGmailPush(gmailRequest('{"message":{}}').input)).reason).toBe('bad_message');
    const huge = gmailRequest('x'.repeat(MAX_PUSH_BODY_BYTES + 1));
    expect(await handleGmailPush(huge.input)).toMatchObject({ status: 204, reason: 'too_large' });
    const declared = gmailRequest(good());
    expect(
      await handleGmailPush({ ...declared.input, contentLength: MAX_PUSH_BODY_BYTES + 1 }),
    ).toMatchObject({ status: 204, reason: 'too_large' });
    expect(declared.reads()).toBe(0);
    const failed = {
      authorization: 'Bearer a.b.c',
      readBody: async () => Promise.reject(new Error('aborted')),
    };
    expect((await handleGmailPush(failed)).reason).toBe('bad_message');
    expect(world.queries).toEqual([]);
  });

  test('an unknown address is acknowledged and starts no sync', async () => {
    const body = pubsubBody({ emailAddress: 'nobody@example.com', historyId: 1 });
    const result = await handleGmailPush(gmailRequest(body).input);
    expect(result.status).toBe(204);
    expect(await result.done).toBe('unknown_address');
    expect(world.timers).toEqual([]);
    expect(world.mutations).toEqual([]);
  });

  test('a push kicks the History sync of each direct account with the address, after a short delay', async () => {
    world.targets['ann@example.com'] = [
      { userId: 'user_1', accountId: 'acct_1' },
      { userId: 'user_2', accountId: 'acct_2' },
    ];
    const result = await handleGmailPush(gmailRequest(good()).input);
    expect(result).toMatchObject({ status: 204, reason: 'accepted' });
    expect(await result.done).toBe('kicked');
    expect(world.queries).toEqual([
      { name: 'googlePush:gmailPushTargets', args: { email: 'ann@example.com' } },
    ]);
    expect(world.mutations.map((m) => [m.name, m.args, m.options])).toEqual([
      ['googlePush:recordGmailPush', { userId: 'user_1', accountId: 'acct_1' }, { skipQueue: true }],
      ['googlePush:recordGmailPush', { userId: 'user_2', accountId: 'acct_2' }, { skipQueue: true }],
    ]);
    expect(world.gmailSyncs).toEqual([]);
    expect(await fireTimer()).toBe(2000);
    expect(await fireTimer()).toBe(2000);
    expect(world.gmailSyncs).toEqual([
      { userId: 'user_1', accountId: 'acct_1' },
      { userId: 'user_2', accountId: 'acct_2' },
    ]);
  });

  test('a burst of pushes starts one sync, reads the address once, and records once', async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await handleGmailPush(gmailRequest(good()).input);
      await result.done;
    }
    expect(world.queries).toHaveLength(1);
    expect(world.mutations).toHaveLength(1);
    expect(world.timers).toHaveLength(1);
    await fireTimer();
    expect(world.gmailSyncs).toHaveLength(1);
    // After the cache and record times, the next push reads and records again.
    world.now += 61_000;
    await (await handleGmailPush(gmailRequest(good()).input)).done;
    expect(world.queries).toHaveLength(2);
    expect(world.mutations).toHaveLength(2);
  });

  test('a busy or unfinished History run reads again soon', async () => {
    world.gmailAnswers = [{ ok: false, skipped: 'busy' }, { ok: true, more: true }, { ok: true }];
    await (await handleGmailPush(gmailRequest(good()).input)).done;
    expect(await fireTimer()).toBe(2000);
    expect(await fireTimer()).toBe(5000);
    expect(await fireTimer()).toBe(5000);
    expect(world.timers).toEqual([]);
    expect(world.gmailSyncs).toHaveLength(3);
  });

  test('a failed record write is retried on the next push', async () => {
    let fail = true;
    __setGooglePushReceiveDepsForTest({
      flags: () => world.flags,
      gmailConfig: () => world.config,
      verifyToken: (async () => ({ ok: true, claims: {} })) as any,
      query: (async () => world.targets['ann@example.com']) as any,
      mutate: (async (_fn: unknown, args: any) => {
        world.mutations.push({ name: 'record', args });
        if (fail) throw new Error('convex down');
        return {};
      }) as any,
      syncGmail: (async () => ({ ok: true })) as any,
      now: () => world.now,
      schedule: () => 0,
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      await (await handleGmailPush(gmailRequest(good()).input)).done;
      fail = false;
      await (await handleGmailPush(gmailRequest(good()).input)).done;
    } finally {
      console.warn = original;
    }
    expect(world.mutations).toHaveLength(2);
  });

  test('a failed lookup is logged and the push is still acknowledged', async () => {
    world.queryError = new Error('convex down');
    const original = console.error;
    console.error = () => {};
    try {
      const result = await handleGmailPush(gmailRequest(good()).input);
      expect(result.status).toBe(204);
      expect(await result.done).toBe('error');
    } finally {
      console.error = original;
    }
  });
});

describe('Calendar and Drive channel routes', () => {
  const calendarRow = (overrides: Record<string, unknown> = {}) => ({
    userId: 'user_1',
    kind: 'calendar',
    channelId: CHANNEL_ID,
    accountId: 'acct_1',
    calendarId: 'primary@example.com',
    resourceId: 'res-1',
    tokenHash: hashChannelToken(TOKEN),
    status: 'active',
    ...overrides,
  });

  test('with the flag off the route answers 204 and does nothing', async () => {
    world.flags.calendar = false;
    const result = handleChannelPush('calendar', channelHeaders());
    expect(result).toMatchObject({ status: 204, reason: 'disabled' });
    expect(await result.done).toBe('disabled');
    expect(world.queries).toEqual([]);
  });

  test('a message without the channel headers is ignored without a read', async () => {
    const cases: Array<Record<string, string>> = [
      { 'X-Goog-Channel-ID': 'not-a-uuid' },
      { 'X-Goog-Channel-Token': '' },
      { 'X-Goog-Channel-Token': 'x'.repeat(257) },
      { 'X-Goog-Resource-ID': '' },
      { 'X-Goog-Resource-ID': 'r'.repeat(513) },
      { 'X-Goog-Resource-State': '' },
    ];
    for (const bad of cases) {
      expect(handleChannelPush('calendar', channelHeaders(bad)).reason).toBe('bad_message');
    }
    expect(world.queries).toEqual([]);
  });

  test('an unknown channel is ignored, and the next message for it needs no read', async () => {
    const result = handleChannelPush('calendar', channelHeaders());
    expect(result.status).toBe(204);
    expect(await result.done).toBe('unknown_channel');
    expect(handleChannelPush('calendar', channelHeaders()).reason).toBe('unknown_channel');
    expect(world.queries).toHaveLength(1);
    world.now += 11 * 60_000;
    expect(handleChannelPush('calendar', channelHeaders()).reason).toBe('accepted');
  });

  test('the unknown-channel memory has a size limit; the oldest id goes first', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 0; n <= 2000; n += 1) {
      // Stay inside the read budget of each minute.
      if (n % 500 === 0) world.now += 60_001;
      await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Channel-ID': id(n) })).done;
    }
    expect(world.queries).toHaveLength(2001);
    // The first id left the memory, so it is read again; the last id is still known.
    expect(handleChannelPush('calendar', channelHeaders({ 'X-Goog-Channel-ID': id(0) })).reason).toBe(
      'accepted',
    );
    expect(handleChannelPush('calendar', channelHeaders({ 'X-Goog-Channel-ID': id(2000) })).reason).toBe(
      'unknown_channel',
    );
  });

  test('Convex reads of channel rows have a budget for each minute', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 0; n < CHANNEL_LOOKUPS_PER_MINUTE; n += 1) {
      expect(await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Channel-ID': id(n) })).done).toBe(
        'unknown_channel',
      );
    }
    // Over the budget: 503 before any read, so Google sends a real message again.
    const over = channelHeaders({ 'X-Goog-Channel-ID': id(CHANNEL_LOOKUPS_PER_MINUTE) });
    const original = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      const first = handleChannelPush('calendar', over);
      expect(first).toMatchObject({ status: 503, reason: 'rate_limited' });
      expect(handleChannelPush('drive', over).status).toBe(503);
    } finally {
      console.warn = original;
    }
    expect(warned).toHaveLength(1);
    expect(world.queries).toHaveLength(CHANNEL_LOOKUPS_PER_MINUTE);
    world.now += 60_000;
    expect(await handleChannelPush('calendar', over).done).toBe('unknown_channel');
  });

  test('a row in memory needs no read budget', async () => {
    world.channel = calendarRow();
    expect(await handleChannelPush('calendar', channelHeaders()).done).toBe('kicked');
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 1; n < CHANNEL_LOOKUPS_PER_MINUTE; n += 1) {
      await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Channel-ID': id(n) })).done;
    }
    const result = handleChannelPush('calendar', channelHeaders());
    expect(result.status).toBe(204);
    expect(await result.done).toBe('kicked');
  });

  test('a checked row stays in memory; a pending row is read again', async () => {
    world.channel = calendarRow({ resourceId: undefined, status: 'pending' });
    await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Resource-State': 'sync' })).done;
    world.channel = calendarRow();
    await handleChannelPush('calendar', channelHeaders()).done;
    await handleChannelPush('calendar', channelHeaders()).done;
    expect(world.queries).toHaveLength(2);
    world.now += 5 * 60_000;
    await handleChannelPush('calendar', channelHeaders()).done;
    expect(world.queries).toHaveLength(3);
  });

  test('a channel of the other kind is unknown to this route', async () => {
    world.channel = calendarRow({ kind: 'drive', connectionId: 'conn_1' });
    expect(await handleChannelPush('calendar', channelHeaders()).done).toBe('unknown_channel');
  });

  test('a wrong token or a wrong resource is ignored and records nothing', async () => {
    world.channel = calendarRow();
    const original = console.warn;
    console.warn = () => {};
    try {
      expect(
        await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Channel-Token': 'guess' })).done,
      ).toBe('bad_token');
      expect(
        await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Resource-ID': 'other' })).done,
      ).toBe('bad_resource');
    } finally {
      console.warn = original;
    }
    expect(world.mutations).toEqual([]);
    expect(world.timers).toEqual([]);
  });

  test('a sync message records the message and starts no sync', async () => {
    // The sync message can come before the watch call returns the resource id.
    world.channel = calendarRow({ resourceId: undefined, status: 'pending' });
    expect(
      await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Resource-State': 'sync' })).done,
    ).toBe('sync');
    expect(world.mutations).toEqual([
      {
        name: 'googlePush:recordChannelMessage',
        args: { channelId: CHANNEL_ID },
        options: { skipQueue: true },
      },
    ]);
    expect(world.timers).toEqual([]);
  });

  test('a calendar change kicks the calendar sync of the account once for a burst', async () => {
    world.channel = calendarRow();
    world.calendarAnswers = [{ ok: true, skipped: true, reason: 'active' }, { ok: true }];
    expect(await handleChannelPush('calendar', channelHeaders()).done).toBe('kicked');
    expect(
      await handleChannelPush('calendar', channelHeaders({ 'X-Goog-Resource-State': 'not_exists' })).done,
    ).toBe('kicked');
    expect(world.mutations).toHaveLength(1);
    expect(await fireTimer()).toBe(5000);
    // An active sync claim: try again after the retry delay.
    expect(await fireTimer()).toBe(30_000);
    expect(world.calendarSyncs).toEqual([
      { userId: 'user_1', accountId: 'acct_1' },
      { userId: 'user_1', accountId: 'acct_1' },
    ]);
    expect(world.timers).toEqual([]);
  });

  test('a Drive change kicks the content sync of the connection, and more pages run soon', async () => {
    world.channel = calendarRow({ kind: 'drive', accountId: undefined, connectionId: 'conn_1' });
    world.driveAnswers = [[{ ok: true, pending: true }], [{ ok: true, pending: false }]];
    expect(await handleChannelPush('drive', channelHeaders({ 'X-Goog-Resource-State': 'change' })).done).toBe(
      'kicked',
    );
    expect(await fireTimer()).toBe(5000);
    expect(await fireTimer()).toBe(2000);
    expect(world.driveSyncs).toEqual([
      { userId: 'user_1', connectionId: 'conn_1' },
      { userId: 'user_1', connectionId: 'conn_1' },
    ]);
  });

  test('a row without an account or a connection kicks nothing', async () => {
    world.channel = calendarRow({ accountId: undefined });
    expect(await handleChannelPush('calendar', channelHeaders()).done).toBe('no_target');
    // The row of the first message stays in memory for five minutes.
    world.now += 5 * 60_000;
    world.channel = calendarRow({ kind: 'drive', accountId: undefined });
    expect(await handleChannelPush('drive', channelHeaders()).done).toBe('no_target');
  });

  test('a failed read is logged and the message is still acknowledged', async () => {
    world.queryError = new Error('convex down');
    const original = console.error;
    console.error = () => {};
    try {
      const result = handleChannelPush('drive', channelHeaders());
      expect(result.status).toBe(204);
      expect(await result.done).toBe('error');
    } finally {
      console.error = original;
    }
  });
});
