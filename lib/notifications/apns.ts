import { createPrivateKey, sign } from 'node:crypto';
import { type ClientHttp2Stream, connect, constants, type IncomingHttpHeaders } from 'node:http2';
import type { NotificationEnvelope } from './delivery';
import { isAPNsDeviceToken, type MobilePushEnvironment } from './mobile-device';

export interface APNsDevice {
  token: string;
  environment: MobilePushEnvironment;
}

export interface APNsPayload {
  aps: {
    alert: { title: string; body: string };
    sound: 'default';
    category: 'LAB86_CHECKIN' | 'LAB86_COMMITMENT' | 'LAB86_MAIL';
    'thread-id': string;
    'content-available': 1;
  };
  notificationId: string;
  route: string;
  suggestionId?: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
}

interface APNsConfiguration {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
}

export class APNsDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
    readonly providerId?: string,
  ) {
    super(message);
    this.name = 'APNsDeliveryError';
  }

  get invalidToken() {
    return (
      this.status === 410 ||
      this.reason === 'Unregistered' ||
      this.reason === 'BadDeviceToken' ||
      this.reason === 'DeviceTokenNotForTopic'
    );
  }
}

const MAX_TOKEN_AGE_SECONDS = 50 * 60;
let cachedProviderToken: { identity: string; issuedAt: number; token: string } | undefined;

let connectImpl: typeof connect = connect;

export function __setAPNsConnectForTest(override?: typeof connect) {
  connectImpl = override ?? connect;
}

export function apnsHost(environment: MobilePushEnvironment) {
  return environment === 'development' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
}

function nativeRoute(envelope: NotificationEnvelope) {
  if (/[?&]checkin=/.test(envelope.deepLink)) {
    const checkinId = new URL(envelope.deepLink, 'https://lab86.io').searchParams.get('checkin');
    return checkinId ? `/checkin?id=${encodeURIComponent(checkinId)}` : '/checkin';
  }
  return envelope.deepLink.startsWith('/') ? envelope.deepLink : '/activity';
}

export function buildAPNsPayload(envelope: NotificationEnvelope): APNsPayload {
  const route = nativeRoute(envelope);
  const deepLink = new URL(envelope.deepLink, 'https://lab86.io');
  const suggestionId = deepLink.searchParams.get('suggestion');
  const accountId = deepLink.searchParams.get('account');
  const threadId = deepLink.searchParams.get('thread');
  const messageId = deepLink.searchParams.get('message');
  const category = route.startsWith('/checkin')
    ? 'LAB86_CHECKIN'
    : suggestionId
      ? 'LAB86_COMMITMENT'
      : route.startsWith('/mail/thread')
        ? 'LAB86_MAIL'
        : 'LAB86_COMMITMENT';
  return {
    aps: {
      alert: {
        title: envelope.title.trim().slice(0, 180),
        body: envelope.body.trim().slice(0, 1_000),
      },
      sound: 'default',
      category,
      'thread-id': accountId && threadId ? `mail.${accountId}.${threadId}` : `albatross.${envelope.id}`,
      'content-available': 1,
    },
    notificationId: envelope.id,
    route,
    ...(suggestionId ? { suggestionId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function configuration(): APNsConfiguration {
  const keyId = String(process.env.APNS_KEY_ID || '').trim();
  const teamId = String(process.env.APNS_TEAM_ID || '').trim();
  const privateKey = String(process.env.APNS_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();
  const bundleId = String(process.env.APNS_BUNDLE_ID || 'io.lab86.mail').trim();
  if (!keyId || !teamId || !privateKey || !bundleId) throw new Error('APNs is not configured.');
  return { keyId, teamId, privateKey, bundleId };
}

function providerToken(config: APNsConfiguration, timestamp = Math.floor(Date.now() / 1_000)) {
  const identity = `${config.teamId}:${config.keyId}:${config.privateKey.length}`;
  if (
    cachedProviderToken?.identity === identity &&
    timestamp - cachedProviderToken.issuedAt < MAX_TOKEN_AGE_SECONDS
  ) {
    return cachedProviderToken.token;
  }
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: timestamp })).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const token = `${unsigned}.${signature}`;
  cachedProviderToken = { identity, issuedAt: timestamp, token };
  return token;
}

function readResponseBody(request: ClientHttp2Stream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

export async function sendAPNsPush(envelope: NotificationEnvelope, device: APNsDevice) {
  if (!isAPNsDeviceToken(device.token)) throw new Error('Invalid APNs device token.');
  const config = configuration();
  const host = apnsHost(device.environment);
  const client = connectImpl(`https://${host}`);
  let responseHeaders: IncomingHttpHeaders = {};
  try {
    const request = client.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
      authorization: `bearer ${providerToken(config)}`,
      'content-type': 'application/json',
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1_000) + 12 * 60 * 60),
    });
    request.setEncoding('utf8');
    request.once('response', (headers) => {
      responseHeaders = headers;
    });
    const bodyPromise = readResponseBody(request);
    request.end(JSON.stringify(buildAPNsPayload(envelope)));
    const responseBody = await bodyPromise;
    const status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] || 0);
    const providerId = String(responseHeaders['apns-id'] || '');
    if (status === 200) return { providerId };
    const payload = JSON.parse(responseBody || '{}') as { reason?: string };
    const reason = String(payload.reason || `HTTP ${status || 'error'}`);
    throw new APNsDeliveryError(`APNs rejected the notification: ${reason}.`, status, reason, providerId);
  } finally {
    client.close();
  }
}
