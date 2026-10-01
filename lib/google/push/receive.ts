// Direct Google push: the receive side of the three push routes
// (docs/google-direct-transport.md, "Push").
//
// - Gmail (`/api/google/push/gmail`): Cloud Pub/Sub posts a message with an
//   OIDC token. The route checks the token, decodes `emailAddress`, and kicks
//   the History sync of each connected direct account with that address.
// - Calendar and Drive (`/api/google/push/calendar`, `/api/google/push/drive`):
//   Google posts the headers of a channel. The route checks the channel id,
//   the token, and the resource id against the stored row, and kicks the
//   calendar sync of the account or the content sync of the Drive connection.
//
// Each route answers fast with 204. Bad input gets 204 too, so Google does
// not send it again. Only a Gmail push without a valid token gets 401. A
// message never carries data that the sync uses: it only starts the existing
// sync, which reads the changes from Google.

import { runWithAiRequestContext } from '@/lib/ai/context';
import { syncCalendarAccount } from '@/lib/calendar/sync';
import { syncCloudContent } from '@/lib/content/cloud-sync';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { syncGoogleHistory } from '../history-sync';
import { channelTokenMatches } from './channel-token';
import { gmailPushConfig, googlePushFlags } from './config';
import { createPushKicker, type PushKicker } from './kicker';
import { bearerToken, createPubSubPushVerifier } from './oidc';

/** Pub/Sub posts small JSON bodies; a larger body is not a Gmail push. */
export const MAX_PUSH_BODY_BYTES = 64 * 1024;
const GMAIL_KICK_DELAY_MS = 2_000;
const GMAIL_RETRY_DELAY_MS = 5_000;
const GMAIL_MAX_CHAIN = 5;
const CALENDAR_KICK_DELAY_MS = 5_000;
const CALENDAR_RETRY_DELAY_MS = 30_000;
const CALENDAR_MAX_CHAIN = 4;
const DRIVE_KICK_DELAY_MS = 5_000;
const DRIVE_RETRY_DELAY_MS = 2_000;
const DRIVE_MAX_CHAIN = 5;
/** An address lookup stays valid this long, so a burst of pushes reads Convex once. */
const TARGET_CACHE_MS = 60_000;
/** Each app instance sends a message time to Convex at most this often for one row. */
const RECORD_INTERVAL_MS = 60_000;
/** A channel id that has no row stays known as unknown this long. */
const UNKNOWN_CHANNEL_MS = 10 * 60_000;
/** A checked channel row stays in memory this long, so a burst of messages reads Convex once. */
const KNOWN_CHANNEL_MS = 5 * 60_000;
/**
 * The most Convex reads of channel rows in one minute for each app instance.
 * The channel routes are public, so a flood of random channel ids must not
 * become a flood of Convex reads.
 */
export const CHANNEL_LOOKUPS_PER_MINUTE = 600;
const CACHE_MAX_ENTRIES = 2000;
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GmailPushMessage {
  emailAddress: string;
  historyId: string;
  messageId?: string;
}

export interface PushHandling {
  status: 204 | 401;
  reason: string;
  /** The background work after the answer: the lookup, the checks, and the kick. */
  done: Promise<string>;
}

interface MailTarget {
  userId: string;
  accountId: string;
}

interface DriveTarget {
  userId: string;
  connectionId: string;
}

interface ChannelRow {
  userId: string;
  kind: 'calendar' | 'drive';
  channelId: string;
  accountId?: string;
  connectionId?: string;
  resourceId?: string;
  tokenHash?: string;
}

const defaults = {
  flags: () => googlePushFlags(),
  gmailConfig: () => gmailPushConfig(),
  verifyToken: createPubSubPushVerifier(),
  query: convexQuery,
  mutate: convexMutation,
  syncGmail: (input: MailTarget) =>
    runWithAiRequestContext({ userId: input.userId, agent: 'ai' }, () => syncGoogleHistory(input)),
  syncCalendar: (input: MailTarget) =>
    runWithAiRequestContext({ userId: input.userId, agent: 'ai' }, () =>
      syncCalendarAccount({ ...input, reason: 'google_push', window: 'auto' }),
    ),
  syncDrive: (input: DriveTarget) =>
    runWithAiRequestContext({ userId: input.userId, agent: 'ai' }, () =>
      syncCloudContent(input.userId, undefined, [input.connectionId]),
    ),
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
};

type Deps = typeof defaults;
let deps: Deps = defaults;

function buildKickers(current: Deps) {
  return {
    gmail: createPushKicker<MailTarget>({
      delayMs: GMAIL_KICK_DELAY_MS,
      retryDelayMs: GMAIL_RETRY_DELAY_MS,
      maxChain: GMAIL_MAX_CHAIN,
      schedule: current.schedule,
      run: async (input) => {
        const result = await current.syncGmail(input);
        // Another run of the same mailbox was busy, or the run stopped at its
        // limit: read again soon, so the change of this push comes in.
        return result?.skipped === 'busy' || result?.more ? 'again' : 'done';
      },
    }),
    calendar: createPushKicker<MailTarget>({
      delayMs: CALENDAR_KICK_DELAY_MS,
      retryDelayMs: CALENDAR_RETRY_DELAY_MS,
      maxChain: CALENDAR_MAX_CHAIN,
      schedule: current.schedule,
      run: async (input) => {
        const result = await current.syncCalendar(input);
        return result?.skipped && result.reason === 'active' ? 'again' : 'done';
      },
    }),
    drive: createPushKicker<DriveTarget>({
      delayMs: DRIVE_KICK_DELAY_MS,
      retryDelayMs: DRIVE_RETRY_DELAY_MS,
      maxChain: DRIVE_MAX_CHAIN,
      schedule: current.schedule,
      run: async (input) => {
        const results = await current.syncDrive(input);
        // One run reads one page of changes; read the next page soon.
        return (results || []).some((result: any) => result?.ok && result?.pending) ? 'again' : 'done';
      },
    }),
  } satisfies Record<string, PushKicker<any>>;
}

let kickers = buildKickers(deps);
const targetCache = new Map<string, { at: number; targets: MailTarget[] }>();
const recordedAt = new Map<string, number>();
const unknownChannels = new Map<string, number>();
const knownChannels = new Map<string, { at: number; row: ChannelRow }>();
let lookupWindow = { start: 0, count: 0 };
let warnedNotConfigured = false;

export function __setGooglePushReceiveDepsForTest(overrides: Partial<Deps> = {}) {
  deps = { ...defaults, ...overrides };
  kickers = buildKickers(deps);
  targetCache.clear();
  recordedAt.clear();
  unknownChannels.clear();
  knownChannels.clear();
  lookupWindow = { start: 0, count: 0 };
  warnedNotConfigured = false;
}

function remember<V>(map: Map<string, V>, key: string, value: V) {
  if (!map.has(key) && map.size >= CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function handled(status: 204 | 401, reason: string, done: Promise<string> = Promise.resolve(reason)) {
  return { status, reason, done };
}

/**
 * The Gmail notification in a Pub/Sub push body, or null. `message.data` is
 * base64 JSON: `{ "emailAddress": "...", "historyId": 1234 }`.
 */
export function decodeGmailPushMessage(body: unknown): GmailPushMessage | null {
  const message = (body as { message?: Record<string, unknown> } | null)?.message;
  const data = message?.data;
  if (typeof data !== 'string' || !data || data.length > 4096) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const emailAddress =
    typeof parsed?.emailAddress === 'string' ? parsed.emailAddress.trim().toLowerCase() : '';
  const rawHistoryId = parsed?.historyId;
  const historyId =
    typeof rawHistoryId === 'number' && Number.isSafeInteger(rawHistoryId)
      ? String(rawHistoryId)
      : typeof rawHistoryId === 'string'
        ? rawHistoryId.trim()
        : '';
  if (emailAddress.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(emailAddress)) return null;
  if (!/^\d{1,20}$/.test(historyId)) return null;
  const messageId = typeof message?.messageId === 'string' ? message.messageId : undefined;
  return { emailAddress, historyId, ...(messageId ? { messageId } : {}) };
}

async function gmailTargets(email: string): Promise<MailTarget[]> {
  const cached = targetCache.get(email);
  if (cached && deps.now() - cached.at < TARGET_CACHE_MS) return cached.targets;
  const targets = (await deps.query<MailTarget[]>(api.googlePush.gmailPushTargets, { email })) || [];
  remember(targetCache, email, { at: deps.now(), targets });
  return targets;
}

/** Sends a message time to Convex at most once a minute for each row from this instance. */
async function recordMessage(key: string, write: () => Promise<unknown>) {
  const last = recordedAt.get(key);
  if (last !== undefined && deps.now() - last < RECORD_INTERVAL_MS) return;
  remember(recordedAt, key, deps.now());
  await write().catch((err: any) => {
    recordedAt.delete(key);
    console.warn('[google-push] could not record a message', err?.message || err);
  });
}

async function deliverGmail(message: GmailPushMessage): Promise<string> {
  const targets = await gmailTargets(message.emailAddress);
  if (!targets.length) return 'unknown_address';
  for (const target of targets) {
    const key = `${target.userId}:${target.accountId}`;
    kickers.gmail.kick(key, target);
    await recordMessage(`gmail:${key}`, () =>
      deps.mutate(api.googlePush.recordGmailPush, target, { skipQueue: true }),
    );
  }
  return 'kicked';
}

/** One Gmail push from Cloud Pub/Sub. */
export async function handleGmailPush(input: {
  authorization: string | null | undefined;
  /** The Content-Length of the request, when it has one. */
  contentLength?: number;
  /** Reads the body. It runs only after the token check. */
  readBody: () => Promise<string>;
}): Promise<PushHandling> {
  if (!deps.flags().gmail) return handled(204, 'disabled');
  const config = deps.gmailConfig();
  if (!config) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.error(
        '[google-push] LAB86_GOOGLE_GMAIL_PUSH=1, but LAB86_GOOGLE_PUBSUB_TOPIC, LAB86_GOOGLE_PUBSUB_AUDIENCE, or LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT is missing or not valid',
      );
    }
    return handled(401, 'not_configured');
  }
  const verification = await deps.verifyToken(bearerToken(input.authorization), {
    audience: config.audience,
    serviceAccount: config.serviceAccount,
  });
  if (!verification.ok) {
    console.warn(`[google-push] Gmail push refused: ${verification.reason}`);
    return handled(401, verification.reason);
  }
  if ((input.contentLength ?? 0) > MAX_PUSH_BODY_BYTES) return handled(204, 'too_large');
  const text = await input.readBody().catch(() => '');
  if (Buffer.byteLength(text) > MAX_PUSH_BODY_BYTES) return handled(204, 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return handled(204, 'bad_message');
  }
  const message = decodeGmailPushMessage(body);
  if (!message) {
    console.warn('[google-push] Gmail push without a valid message; acknowledged');
    return handled(204, 'bad_message');
  }
  const done = deliverGmail(message).catch((err: any) => {
    console.error('[google-push] Gmail push delivery failed', err?.message || err);
    return 'error';
  });
  return { status: 204, reason: 'accepted', done };
}

interface ChannelMessage {
  channelId: string;
  token: string;
  resourceId: string;
  state: string;
}

/** The stored row of a channel, from memory or from Convex. `limited` when the read budget is spent. */
async function channelRow(channelId: string): Promise<ChannelRow | null | 'limited'> {
  const now = deps.now();
  const cached = knownChannels.get(channelId);
  if (cached && now - cached.at < KNOWN_CHANNEL_MS) return cached.row;
  if (now - lookupWindow.start >= 60_000) lookupWindow = { start: now, count: 0 };
  if (lookupWindow.count >= CHANNEL_LOOKUPS_PER_MINUTE) return 'limited';
  lookupWindow.count += 1;
  const row = await deps.query<ChannelRow | null>(api.googlePush.channelForPush, { channelId });
  // A pending row has no resource id yet; read it again next time.
  if (row?.resourceId) remember(knownChannels, channelId, { at: now, row });
  return row;
}

async function deliverChannel(kind: 'calendar' | 'drive', message: ChannelMessage): Promise<string> {
  const row = await channelRow(message.channelId);
  if (row === 'limited') return 'rate_limited';
  if (!row || row.kind !== kind) {
    remember(unknownChannels, message.channelId, deps.now());
    return 'unknown_channel';
  }
  if (!channelTokenMatches(message.token, row.tokenHash)) {
    console.warn(`[google-push] ${kind} message with a wrong channel token; ignored`);
    return 'bad_token';
  }
  // A new channel can send its sync message before the watch call returns
  // the resource id. After that, the resource id must match.
  if (row.resourceId && row.resourceId !== message.resourceId) {
    console.warn(`[google-push] ${kind} message for another resource; ignored`);
    return 'bad_resource';
  }
  await recordMessage(`channel:${message.channelId}`, () =>
    deps.mutate(api.googlePush.recordChannelMessage, { channelId: message.channelId }, { skipQueue: true }),
  );
  if (message.state === 'sync') return 'sync';
  if (kind === 'calendar' && row.accountId) {
    kickers.calendar.kick(`${row.userId}:${row.accountId}`, { userId: row.userId, accountId: row.accountId });
    return 'kicked';
  }
  if (kind === 'drive' && row.connectionId) {
    kickers.drive.kick(`${row.userId}:${row.connectionId}`, {
      userId: row.userId,
      connectionId: row.connectionId,
    });
    return 'kicked';
  }
  return 'no_target';
}

/** One Calendar or Drive channel message. The answer is always 204. */
export function handleChannelPush(
  kind: 'calendar' | 'drive',
  headers: { get(name: string): string | null },
): PushHandling {
  if (!deps.flags()[kind]) return handled(204, 'disabled');
  const channelId = headers.get('x-goog-channel-id')?.trim() || '';
  const token = headers.get('x-goog-channel-token') || '';
  const resourceId = headers.get('x-goog-resource-id')?.trim() || '';
  const state = headers.get('x-goog-resource-state')?.trim().toLowerCase() || '';
  if (!CHANNEL_ID.test(channelId) || !token || token.length > 256 || !resourceId || resourceId.length > 512) {
    return handled(204, 'bad_message');
  }
  if (!state) return handled(204, 'bad_message');
  const unknownAt = unknownChannels.get(channelId);
  if (unknownAt !== undefined && deps.now() - unknownAt < UNKNOWN_CHANNEL_MS) {
    return handled(204, 'unknown_channel');
  }
  const done = deliverChannel(kind, { channelId, token, resourceId, state }).catch((err: any) => {
    console.error(`[google-push] ${kind} message delivery failed`, err?.message || err);
    return 'error';
  });
  return { status: 204, reason: 'accepted', done };
}
