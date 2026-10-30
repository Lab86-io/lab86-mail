import { createPrivateKey, sign } from 'node:crypto';
import { type ClientHttp2Stream, connect, constants, type IncomingHttpHeaders } from 'node:http2';
import { truncateText } from '../shared/text';
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
    category: 'LAB86_CHECKIN' | 'LAB86_COMMITMENT' | 'LAB86_MAIL' | 'LAB86_BRIEF' | 'LAB86_URGENT';
    'thread-id': string;
    'content-available': 1;
    // Only urgent mail carries an elevated level. Applying it more widely is
    // how an app loses the Focus exemption the user granted it, since the
    // setting is per-app rather than per-notification.
    'interruption-level'?: 'time-sensitive';
    'relevance-score'?: number;
  };
  notificationId: string;
  route: string;
  suggestionId?: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  promptKind?: 'reflection' | 'tomorrow';
  /** Tells the woken app to refresh one-time codes before doing anything else. */
  codeAvailable?: true;
  /** The notification type (`obligation`, `urgent_mail`, ...). The app routes a tap by it. */
  type?: string;
  /** Needs you: the obligation that the push names. A tap opens that item. */
  obligationId?: string;
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
    const link = new URL(envelope.deepLink, 'https://lab86.io');
    const checkinId = link.searchParams.get('checkin');
    const promptKind = link.searchParams.get('prompt');
    if (!checkinId) return '/checkin';
    return `/checkin?id=${encodeURIComponent(checkinId)}${
      promptKind ? `&prompt=${encodeURIComponent(promptKind)}` : ''
    }`;
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
  const promptKind =
    deepLink.searchParams.get('prompt') === 'tomorrow' ? ('tomorrow' as const) : ('reflection' as const);
  // Urgent mail and a time-sensitive obligation (Needs you) share the level.
  const urgent = envelope.type === 'urgent_mail' || envelope.timeSensitive === true;
  const category = urgent
    ? 'LAB86_URGENT'
    : envelope.type === 'brief_ready'
      ? 'LAB86_BRIEF'
      : route.startsWith('/checkin')
        ? 'LAB86_CHECKIN'
        : suggestionId
          ? 'LAB86_COMMITMENT'
          : route.startsWith('/mail/thread')
            ? 'LAB86_MAIL'
            : 'LAB86_COMMITMENT';
  const notificationThread =
    accountId && threadId
      ? `mail.${accountId}.${threadId}`
      : category === 'LAB86_CHECKIN'
        ? 'albatross.checkin'
        : category === 'LAB86_BRIEF'
          ? 'albatross.brief'
          : category === 'LAB86_COMMITMENT'
            ? 'albatross.commitments'
            : `albatross.${envelope.id}`;
  const relevanceScore =
    category === 'LAB86_URGENT'
      ? 1
      : category === 'LAB86_CHECKIN'
        ? 0.9
        : category === 'LAB86_BRIEF'
          ? 0.8
          : category === 'LAB86_COMMITMENT'
            ? 0.6
            : 0.25;
  return {
    aps: {
      alert: {
        title: truncateText(envelope.title.trim(), 180),
        body: truncateText(envelope.body.trim(), 1_000),
      },
      sound: 'default',
      category,
      'thread-id': notificationThread,
      'content-available': 1,
      'relevance-score': relevanceScore,
      ...(urgent ? ({ 'interruption-level': 'time-sensitive' } as const) : {}),
    },
    notificationId: envelope.id,
    route,
    ...(envelope.codeAvailable ? ({ codeAvailable: true } as const) : {}),
    ...(envelope.type ? { type: envelope.type } : {}),
    ...(envelope.obligationId ? { obligationId: envelope.obligationId } : {}),
    ...(suggestionId ? { suggestionId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(route.startsWith('/checkin') ? { promptKind } : {}),
  };
}

/** APNs takes a collapse id of at most 64 bytes. A longer one is left out. */
export function apnsCollapseId(envelope: NotificationEnvelope): string | undefined {
  const id = envelope.collapseId?.trim();
  return id && Buffer.byteLength(id, 'utf8') <= 64 ? id : undefined;
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
  const collapseId = apnsCollapseId(envelope);
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
      ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
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
