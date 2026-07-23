import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  __setAPNsConnectForTest,
  APNsDeliveryError,
  apnsHost,
  buildAPNsPayload,
  sendAPNsPush,
} from '../lib/notifications/apns';

const DEVICE_TOKEN = 'ab'.repeat(32);

const PRIVATE_KEY_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const ENV_KEYS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID'] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notice-1',
    userId: 'user-1',
    title: 'Design review',
    body: 'Ari proposed a concrete time.',
    deepLink: '/activity',
    ...overrides,
  };
}

class FakeAPNsStream extends EventEmitter {
  sentBody = '';

  constructor(private readonly response: { headers: Record<string, unknown>; body: string }) {
    super();
  }

  setEncoding() {}

  end(payload: string) {
    this.sentBody = payload;
    queueMicrotask(() => {
      this.emit('response', this.response.headers);
      if (this.response.body) this.emit('data', this.response.body);
      this.emit('end');
    });
  }
}

function installFakeAPNs(response: { headers: Record<string, unknown>; body?: string }) {
  const requests: Array<Record<string, unknown>> = [];
  const state = { authority: '', closed: false, lastStream: undefined as FakeAPNsStream | undefined };
  __setAPNsConnectForTest(((authority: unknown) => {
    state.authority = String(authority);
    return {
      request(headers: Record<string, unknown>) {
        requests.push(headers);
        const stream = new FakeAPNsStream({ headers: response.headers, body: response.body ?? '' });
        state.lastStream = stream;
        return stream;
      },
      close() {
        state.closed = true;
      },
    };
  }) as any);
  return { requests, state };
}

beforeEach(() => {
  process.env.APNS_KEY_ID = 'KEY1234567';
  process.env.APNS_TEAM_ID = 'TEAM567890';
  // Stored with escaped newlines the way Railway env vars arrive.
  process.env.APNS_PRIVATE_KEY = PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
  process.env.APNS_BUNDLE_ID = 'io.lab86.mail.test';
});

afterEach(() => {
  __setAPNsConnectForTest();
});

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('APNs payload shaping', () => {
  test('routes each environment to the matching Apple host', () => {
    expect(apnsHost('development')).toBe('api.sandbox.push.apple.com');
    expect(apnsHost('production')).toBe('api.push.apple.com');
  });

  test('non-native deep links fall back to the activity surface', () => {
    const payload = buildAPNsPayload(envelope({ deepLink: 'https://evil.example/phish' }));
    expect(payload.route).toBe('/activity');
    expect(payload.aps.category).toBe('LAB86_COMMITMENT');
    expect(payload.aps['thread-id']).toBe('albatross.notice-1');
  });

  test('a check-in link without an id still lands on the check-in surface', () => {
    expect(buildAPNsPayload(envelope({ deepLink: '/?checkin=' })).route).toBe('/checkin');
    expect(buildAPNsPayload(envelope({ deepLink: '/?checkin=checkin_9' })).route).toBe(
      '/checkin?id=checkin_9',
    );
  });

  test('mail thread links group notifications per thread and carry ids as custom data', () => {
    const payload = buildAPNsPayload(
      envelope({ deepLink: '/mail/thread?account=acct-1&thread=thr-1&message=msg-1' }),
    );
    expect(payload.aps.category).toBe('LAB86_MAIL');
    expect(payload.aps['thread-id']).toBe('mail.acct-1.thr-1');
    expect(payload).toMatchObject({ accountId: 'acct-1', threadId: 'thr-1', messageId: 'msg-1' });
  });

  test('bounds alert copy so oversized titles cannot break delivery', () => {
    const payload = buildAPNsPayload(
      envelope({ title: `  ${'t'.repeat(300)}  `, body: `  ${'b'.repeat(2_000)}  ` }),
    );
    expect(payload.aps.alert.title).toBe('t'.repeat(180));
    expect(payload.aps.alert.body).toBe('b'.repeat(1_000));
  });

  test('classifies invalid-token rejections separately from transient failures', () => {
    expect(new APNsDeliveryError('gone', 410, 'SomeReason').invalidToken).toBe(true);
    expect(new APNsDeliveryError('gone', 400, 'Unregistered').invalidToken).toBe(true);
    expect(new APNsDeliveryError('gone', 400, 'BadDeviceToken').invalidToken).toBe(true);
    expect(new APNsDeliveryError('gone', 400, 'DeviceTokenNotForTopic').invalidToken).toBe(true);
    expect(new APNsDeliveryError('busy', 503, 'ServiceUnavailable').invalidToken).toBe(false);
  });
});

describe('sendAPNsPush', () => {
  test('refuses malformed device tokens before opening a connection', async () => {
    const { requests } = installFakeAPNs({ headers: { ':status': 200 } });
    await expect(
      sendAPNsPush(envelope() as any, { token: 'not-a-token', environment: 'production' }),
    ).rejects.toThrow(/Invalid APNs device token/);
    expect(requests).toEqual([]);
  });

  test('fails fast when APNs credentials are not configured', async () => {
    const { requests } = installFakeAPNs({ headers: { ':status': 200 } });
    delete process.env.APNS_KEY_ID;
    await expect(
      sendAPNsPush(envelope() as any, { token: DEVICE_TOKEN, environment: 'production' }),
    ).rejects.toThrow(/APNs is not configured/);
    expect(requests).toEqual([]);
  });

  test('delivers a signed alert to the sandbox host for development devices', async () => {
    const { requests, state } = installFakeAPNs({ headers: { ':status': 200, 'apns-id': 'apns-uuid-1' } });

    const result = await sendAPNsPush(envelope() as any, {
      token: DEVICE_TOKEN,
      environment: 'development',
    });

    expect(result).toEqual({ providerId: 'apns-uuid-1' });
    expect(state.authority).toBe('https://api.sandbox.push.apple.com');
    expect(state.closed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${DEVICE_TOKEN}`,
      'apns-topic': 'io.lab86.mail.test',
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    expect(String(requests[0].authorization)).toStartWith('bearer ');
    expect(JSON.parse(state.lastStream?.sentBody || '{}')).toEqual(buildAPNsPayload(envelope()));
  });

  test('reuses the cached provider token until the signing identity changes', async () => {
    const first = installFakeAPNs({ headers: { ':status': 200 } });
    await sendAPNsPush(envelope() as any, { token: DEVICE_TOKEN, environment: 'production' });
    await sendAPNsPush(envelope() as any, { token: DEVICE_TOKEN, environment: 'production' });

    const [authA, authB] = first.requests.map((headers) => String(headers.authorization));
    expect(authA).toBe(authB);

    process.env.APNS_KEY_ID = 'KEY0000001';
    const second = installFakeAPNs({ headers: { ':status': 200 } });
    await sendAPNsPush(envelope() as any, { token: DEVICE_TOKEN, environment: 'production' });
    const authC = String(second.requests[0].authorization);
    expect(authC).not.toBe(authA);

    const decodedHeader = JSON.parse(
      Buffer.from(authC.replace(/^bearer /, '').split('.')[0], 'base64url').toString('utf8'),
    );
    expect(decodedHeader).toEqual({ alg: 'ES256', kid: 'KEY0000001' });
  });

  test('maps unregistered-device rejections onto an invalid-token delivery error', async () => {
    const { state } = installFakeAPNs({
      headers: { ':status': 410, 'apns-id': 'apns-err-1' },
      body: JSON.stringify({ reason: 'Unregistered' }),
    });

    const failure = sendAPNsPush(envelope() as any, { token: DEVICE_TOKEN, environment: 'production' });
    await expect(failure).rejects.toBeInstanceOf(APNsDeliveryError);
    const error = (await failure.catch((cause) => cause)) as APNsDeliveryError;
    expect(error.status).toBe(410);
    expect(error.reason).toBe('Unregistered');
    expect(error.invalidToken).toBe(true);
    expect(error.providerId).toBe('apns-err-1');
    expect(state.closed).toBe(true);
  });

  test('falls back to the HTTP status when Apple returns no reason body', async () => {
    installFakeAPNs({ headers: { ':status': 500 } });

    const error = (await sendAPNsPush(envelope() as any, {
      token: DEVICE_TOKEN,
      environment: 'production',
    }).catch((cause) => cause)) as APNsDeliveryError;
    expect(error).toBeInstanceOf(APNsDeliveryError);
    expect(error.reason).toBe('HTTP 500');
    expect(error.invalidToken).toBe(false);
  });
});
