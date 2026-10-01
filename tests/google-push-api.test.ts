import { describe, expect, test } from 'bun:test';
import { GoogleApiError } from '../lib/google/errors';
import { channelTokenMatches, hashChannelToken, newChannelToken } from '../lib/google/push/channel-token';
import {
  DRIVE_API,
  driveStartPageToken,
  stopCalendarChannel,
  stopDriveChannel,
  stopGmailMailbox,
  watchCalendarEvents,
  watchDriveChanges,
  watchGmailMailbox,
} from '../lib/google/push/google-api';

const GRANT = 'google:11111111-1111-4111-8111-111111111111';
const CHANNEL = {
  id: '5f1c2a7e-4c1b-4b0e-9d3a-2a9c1e0b7f11',
  token: 'secret-token',
  address: 'https://mail.lab86.io/api/google/push/calendar',
  expiration: 1_800_604_800_000,
};

function recordingJson(answer: unknown | Error) {
  const calls: Array<{ grantId: string; url: string; init: any }> = [];
  const json = (async (grantId: string, url: string, init: any) => {
    calls.push({ grantId, url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as any;
  return { calls, json };
}

function recordingFetch(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init || {} });
    const answer = answers.shift() ?? { status: 200, body: {} };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    });
  };
  return { calls, fetcher };
}

describe('channel token', () => {
  test('a new token is random, 43 characters, and only its hash matches', () => {
    const a = newChannelToken();
    const b = newChannelToken();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(43);
    const hash = hashChannelToken(a);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(channelTokenMatches(a, hash)).toBe(true);
    expect(channelTokenMatches(b, hash)).toBe(false);
    expect(channelTokenMatches(a, a)).toBe(false);
    expect(channelTokenMatches('', hash)).toBe(false);
    expect(channelTokenMatches(a, undefined)).toBe(false);
  });
});

describe('Gmail watch calls', () => {
  test('watch posts the topic and leaves drafts out', async () => {
    const { calls, json } = recordingJson({ historyId: 12345, expiration: '1800604800000' });
    expect(await watchGmailMailbox(GRANT, 'projects/lab86-mail-production/topics/gmail-push', json)).toEqual({
      historyId: '12345',
      expiration: 1_800_604_800_000,
    });
    expect(calls).toEqual([
      {
        grantId: GRANT,
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/watch',
        init: {
          method: 'POST',
          json: {
            topicName: 'projects/lab86-mail-production/topics/gmail-push',
            labelIds: ['DRAFT'],
            labelFilterBehavior: 'exclude',
          },
        },
      },
    ]);
  });

  test('a watch answer without an expiration is an error', async () => {
    const { json } = recordingJson({ historyId: '1' });
    await expect(watchGmailMailbox(GRANT, 'projects/p-12345/topics/t', json)).rejects.toThrow(
      'no expiration',
    );
    const { json: noHistory } = recordingJson({ expiration: 5 });
    expect(await watchGmailMailbox(GRANT, 'projects/p-12345/topics/t', noHistory)).toEqual({ expiration: 5 });
  });

  test('stop posts to users.stop', async () => {
    const { calls, json } = recordingJson(undefined);
    await stopGmailMailbox(GRANT, json);
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/stop');
    expect(calls[0].init).toEqual({ method: 'POST' });
  });
});

describe('Calendar channel calls', () => {
  test('watch posts a web_hook channel for the calendar', async () => {
    const { calls, json } = recordingJson({ resourceId: 'res-1', expiration: '1800600000000' });
    expect(await watchCalendarEvents(GRANT, 'team@group.calendar.google.com', CHANNEL, json)).toEqual({
      resourceId: 'res-1',
      expiration: 1_800_600_000_000,
    });
    expect(calls[0].url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events/watch',
    );
    expect(calls[0].init.json).toEqual({
      id: CHANNEL.id,
      type: 'web_hook',
      address: CHANNEL.address,
      token: CHANNEL.token,
      expiration: CHANNEL.expiration,
    });
  });

  test('a channel answer without a resource id is an error; a missing expiration keeps the requested one', async () => {
    await expect(watchCalendarEvents(GRANT, 'primary', CHANNEL, recordingJson({}).json)).rejects.toThrow(
      'no resource id',
    );
    expect(
      await watchCalendarEvents(GRANT, 'primary', CHANNEL, recordingJson({ resourceId: 'r' }).json),
    ).toEqual({
      resourceId: 'r',
      expiration: CHANNEL.expiration,
    });
  });

  test('stop posts the channel id and resource id; a 404 counts as stopped', async () => {
    const { calls, json } = recordingJson(undefined);
    await stopCalendarChannel(GRANT, { channelId: 'c1', resourceId: 'r1' }, json);
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/channels/stop');
    expect(calls[0].init.json).toEqual({ id: 'c1', resourceId: 'r1' });
    await stopCalendarChannel(
      GRANT,
      { channelId: 'c1', resourceId: 'r1' },
      recordingJson(new GoogleApiError(404, 'not found')).json,
    );
    await expect(
      stopCalendarChannel(
        GRANT,
        { channelId: 'c1', resourceId: 'r1' },
        recordingJson(new GoogleApiError(403, 'no')).json,
      ),
    ).rejects.toThrow('no');
  });
});

describe('Drive channel calls', () => {
  test('the start page token comes from changes.startPageToken', async () => {
    const { calls, fetcher } = recordingFetch([{ status: 200, body: { startPageToken: '777' } }]);
    expect(await driveStartPageToken('access', fetcher)).toBe('777');
    expect(calls[0].url).toBe(`${DRIVE_API}/changes/startPageToken?supportsAllDrives=true`);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer access');
    const empty = recordingFetch([{ status: 200, body: {} }]);
    await expect(driveStartPageToken('access', empty.fetcher)).rejects.toThrow('no start page token');
  });

  test('watch posts the channel with the page token and the shared drive parameters', async () => {
    const { calls, fetcher } = recordingFetch([
      { status: 200, body: { resourceId: 'drive-res', expiration: '9' } },
    ]);
    expect(await watchDriveChanges('access', 'page-5', CHANNEL, fetcher)).toEqual({
      resourceId: 'drive-res',
      expiration: 9,
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/drive/v3/changes/watch');
    expect(url.searchParams.get('pageToken')).toBe('page-5');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ id: CHANNEL.id, type: 'web_hook' });
  });

  test('a Drive error keeps its status and reason', async () => {
    const { fetcher } = recordingFetch([
      {
        status: 403,
        body: { error: { message: 'denied', errors: [{ reason: 'insufficientPermissions' }] } },
      },
    ]);
    const error = await watchDriveChanges('access', 'p', CHANNEL, fetcher).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.statusCode).toBe(403);
    expect(error.reason).toBe('insufficientPermissions');
    const plain = recordingFetch([{ status: 500 }]);
    const second = await watchDriveChanges('access', 'p', CHANNEL, plain.fetcher).catch((err) => err);
    expect(second.message).toBe('Drive answered 500.');
  });

  test('a Drive body that is not JSON is read as empty', async () => {
    const fetcher = async () => new Response('not json', { status: 200 });
    await expect(driveStartPageToken('access', fetcher)).rejects.toThrow('no start page token');
  });

  test('stop posts the channel; a 404 counts as stopped', async () => {
    const { calls, fetcher } = recordingFetch([{ status: 204 }, { status: 404 }, { status: 500 }]);
    await stopDriveChannel('access', { channelId: 'c', resourceId: 'r' }, fetcher);
    expect(calls[0].url).toBe(`${DRIVE_API}/channels/stop`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: 'c', resourceId: 'r' });
    await stopDriveChannel('access', { channelId: 'c', resourceId: 'r' }, fetcher);
    await expect(stopDriveChannel('access', { channelId: 'c', resourceId: 'r' }, fetcher)).rejects.toThrow(
      'Drive answered 500.',
    );
  });
});
