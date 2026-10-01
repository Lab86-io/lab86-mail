// Direct Google push: the Google calls that make, renew, and stop a Gmail
// watch, a Calendar channel, and a Drive changes channel. Gmail and Calendar
// use the direct mail grant (googleJson). Drive uses the access token of the
// Drive connection. No call needs a new scope: gmail.modify covers
// users.watch and users.stop, calendar covers events.watch and channels.stop,
// and drive.readonly covers changes.watch and channels.stop.

import { GoogleApiError } from '../errors';
import { CALENDAR_API, GMAIL_API, googleJson } from '../http';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_TIMEOUT_MS = 15_000;

export interface PushChannelRequest {
  id: string;
  token: string;
  address: string;
  expiration: number;
}

export interface PushChannelResult {
  resourceId: string;
  expiration: number;
}

type GoogleJson = typeof googleJson;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function expirationMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function channelResult(body: any, requested: number): PushChannelResult {
  const resourceId = typeof body?.resourceId === 'string' ? body.resourceId : '';
  if (!resourceId) throw new GoogleApiError(502, 'Google gave no resource id for the channel.');
  return { resourceId, expiration: expirationMs(body?.expiration, requested) };
}

function channelBody(channel: PushChannelRequest) {
  return {
    id: channel.id,
    type: 'web_hook',
    address: channel.address,
    token: channel.token,
    expiration: channel.expiration,
  };
}

/**
 * Starts or renews the Gmail watch of a mailbox. Drafts are left out: Gmail
 * saves a draft every few seconds while a person writes, and the History
 * sync skips drafts.
 */
export async function watchGmailMailbox(
  grantId: string,
  topicName: string,
  json: GoogleJson = googleJson,
): Promise<{ historyId?: string; expiration: number }> {
  const body = await json<{ historyId?: string | number; expiration?: string | number }>(
    grantId,
    `${GMAIL_API}/watch`,
    {
      method: 'POST',
      json: { topicName, labelIds: ['DRAFT'], labelFilterBehavior: 'exclude' },
    },
  );
  const expiration = expirationMs(body?.expiration, 0);
  if (!expiration) throw new GoogleApiError(502, 'Gmail gave no expiration for the watch.');
  return {
    ...(body?.historyId !== undefined ? { historyId: String(body.historyId) } : {}),
    expiration,
  };
}

/** Stops all push messages of a mailbox for this Google Cloud project. */
export async function stopGmailMailbox(grantId: string, json: GoogleJson = googleJson): Promise<void> {
  await json(grantId, `${GMAIL_API}/stop`, { method: 'POST' });
}

export async function watchCalendarEvents(
  grantId: string,
  calendarId: string,
  channel: PushChannelRequest,
  json: GoogleJson = googleJson,
): Promise<PushChannelResult> {
  const body = await json(
    grantId,
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: 'POST',
      json: channelBody(channel),
    },
  );
  return channelResult(body, channel.expiration);
}

/** Stops a Calendar channel. A channel that Google does not know (404) counts as stopped. */
export async function stopCalendarChannel(
  grantId: string,
  channel: { channelId: string; resourceId: string },
  json: GoogleJson = googleJson,
): Promise<void> {
  try {
    await json(grantId, `${CALENDAR_API}/channels/stop`, {
      method: 'POST',
      json: { id: channel.channelId, resourceId: channel.resourceId },
    });
  } catch (err) {
    if ((err as GoogleApiError)?.statusCode !== 404) throw err;
  }
}

async function driveRequest(
  fetcher: FetchLike,
  accessToken: string,
  url: string,
  init: { method?: string; json?: unknown } = {},
): Promise<any> {
  const response = await fetcher(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
    cache: 'no-store',
  });
  const text = await response.text().catch(() => '');
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = body?.error;
    throw new GoogleApiError(
      response.status,
      error?.message || `Drive answered ${response.status}.`,
      error?.errors?.[0]?.reason || error?.status,
    );
  }
  return body;
}

/** The current Drive change position of the connection. */
export async function driveStartPageToken(
  accessToken: string,
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<string> {
  const body = await driveRequest(
    fetcher,
    accessToken,
    `${DRIVE_API}/changes/startPageToken?supportsAllDrives=true`,
  );
  const token = typeof body?.startPageToken === 'string' ? body.startPageToken : '';
  if (!token) throw new GoogleApiError(502, 'Drive gave no start page token.');
  return token;
}

/**
 * Starts a Drive changes channel from a page token. The parameters match the
 * changes.list call of the content sync, so a change in a shared drive sends
 * a message too.
 */
export async function watchDriveChanges(
  accessToken: string,
  pageToken: string,
  channel: PushChannelRequest,
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<PushChannelResult> {
  const url = new URL(`${DRIVE_API}/changes/watch`);
  url.searchParams.set('pageToken', pageToken);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  const body = await driveRequest(fetcher, accessToken, url.href, {
    method: 'POST',
    json: channelBody(channel),
  });
  return channelResult(body, channel.expiration);
}

/** Stops a Drive channel. A channel that Google does not know (404) counts as stopped. */
export async function stopDriveChannel(
  accessToken: string,
  channel: { channelId: string; resourceId: string },
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<void> {
  try {
    await driveRequest(fetcher, accessToken, `${DRIVE_API}/channels/stop`, {
      method: 'POST',
      json: { id: channel.channelId, resourceId: channel.resourceId },
    });
  } catch (err) {
    if ((err as GoogleApiError)?.statusCode !== 404) throw err;
  }
}
