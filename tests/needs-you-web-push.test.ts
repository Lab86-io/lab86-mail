import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getFunctionName } from 'convex/server';
import { pushLinkTarget, pushMessageSearch } from '../components/needs-you/NeedsYouPushLinks';
import {
  type NotificationEnvelope,
  sendWebPush,
  setNotificationDeliveryDependenciesForTest,
  webPushTopic,
} from '../lib/notifications/delivery';
import { CODE_PUSH_BODY, CODE_PUSH_TITLE, dispatchWebNotification } from '../lib/notifications/web-delivery';
import {
  abandonBrowserPush,
  type BrowserPushEnvironment,
  browserPushEnvironment,
  disableBrowserPush,
  enableBrowserPush,
  readBrowserPush,
  urlBase64ToUint8Array,
} from '../lib/notifications/web-push-client';
import { NEEDS_YOU_LINK, needsYouItemLink } from '../lib/obligations/contract';
import {
  deliverObligationPushes,
  releaseHeldObligationPushes,
  SUMMARY_COLLAPSE_ID,
} from '../lib/obligations/delivery';
import {
  anyPushChannel,
  decideObligationPush,
  obligationPushSettingsFromRow,
} from '../lib/obligations/push-policy';
import { NEEDS_YOU_PUSH_MESSAGE, obligationIdFromSearch } from '../lib/shared/types';

// Needs you in the browser. No real push leaves: the sender is a fake.

const CODE = '482913';
const subscription = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  p256dh: `key-${name}`,
  auth: `auth-${name}`,
});

const notification = {
  _id: 'n1',
  title: 'Maya Chen',
  body: 'Approve the budget',
  deepLink: '/mail/thread?account=a&thread=t',
  type: 'obligation',
};

function webHarness(
  context: any,
  send: (envelope: NotificationEnvelope, subscription: any) => Promise<any> = async () => ({
    statusCode: 201,
  }),
) {
  const mutations: Array<{ fn: string; args: any }> = [];
  const envelopes: NotificationEnvelope[] = [];
  const queries: Array<{ fn: string; args: any }> = [];
  return {
    mutations,
    envelopes,
    queries,
    deps: {
      query: (async (fn: any, args: any) => {
        queries.push({ fn: getFunctionName(fn), args });
        return context;
      }) as any,
      mutate: (async (fn: any, args: any) => {
        mutations.push({ fn: getFunctionName(fn), args });
        return null;
      }) as any,
      send: (async (envelope: NotificationEnvelope, target: any) => {
        envelopes.push(envelope);
        return send(envelope, target);
      }) as any,
    },
  };
}

const context = (patch: Record<string, unknown> = {}) => ({
  notification,
  subscriptions: [subscription('one')],
  deliveries: [],
  ...patch,
});

describe('dispatchWebNotification', () => {
  test('sends to each subscription with the collapse id and the item link, and records one send', async () => {
    const { deps, envelopes, mutations, queries } = webHarness(
      context({ subscriptions: [subscription('one'), subscription('two')] }),
    );
    const result = await dispatchWebNotification('u', 'n1', deps, {
      collapseId: 'ob_1',
      obligationId: 'ob_1',
      timeSensitive: true,
    });
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(queries).toEqual([
      { fn: 'albatrossNotifications:webDeliveryContext', args: { userId: 'u', notificationId: 'n1' } },
    ]);
    expect(envelopes[0]).toEqual({
      id: 'n1',
      userId: 'u',
      type: 'obligation',
      title: 'Maya Chen',
      body: 'Approve the budget',
      deepLink: '/mail/thread?account=a&thread=t',
      appLink: '/?view=notifications&obligation=ob_1',
      collapseId: 'ob_1',
      timeSensitive: true,
      obligationId: 'ob_1',
    });
    expect(mutations).toEqual([
      {
        fn: 'albatrossNotifications:recordDelivery',
        args: { userId: 'u', notificationId: 'n1', channel: 'web_push', status: 'sent', error: undefined },
      },
    ]);
  });

  test('the summary push opens the page and names no item', async () => {
    const { deps, envelopes } = webHarness(context());
    await dispatchWebNotification('u', 'n1', deps, { collapseId: SUMMARY_COLLAPSE_ID });
    expect(envelopes[0].appLink).toBe(NEEDS_YOU_LINK);
    expect(envelopes[0].obligationId).toBeUndefined();
    expect(envelopes[0].collapseId).toBe(SUMMARY_COLLAPSE_ID);
  });

  test('a code push holds no value, no sender, and no subject', async () => {
    const leaky = {
      ...notification,
      title: `Code ${CODE} from Northwind`,
      body: `Your code is ${CODE}`,
    };
    const { deps, envelopes } = webHarness(context({ notification: leaky }));
    await dispatchWebNotification('u', 'n1', deps, {
      codeAvailable: true,
      collapseId: 'ob_code',
      obligationId: 'ob_code',
      timeSensitive: true,
    });
    expect(envelopes[0]).toMatchObject({
      title: CODE_PUSH_TITLE,
      body: CODE_PUSH_BODY,
      appLink: '/?view=notifications&obligation=ob_code',
    });
    expect(CODE_PUSH_TITLE).toBe('A code is ready');
    const sent: any[] = [];
    const restore = setNotificationDeliveryDependenciesForTest({
      hostedPublicUrl: () => 'https://mail.example.test',
      setVapidDetails: (() => undefined) as any,
      sendNotification: (async (...args: any[]) => {
        sent.push(args);
        return { statusCode: 201 };
      }) as any,
    });
    const env = { ...process.env };
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'public-key';
    process.env.VAPID_PRIVATE_KEY = 'private-key';
    try {
      await sendWebPush(envelopes[0], subscription('one'));
    } finally {
      restore();
      for (const key of ['NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as const) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
    }
    expect(sent[0][1]).not.toContain(CODE);
    expect(JSON.parse(sent[0][1])).toEqual({
      title: 'A code is ready',
      body: 'Open Albatross to copy it.',
      url: '/?view=notifications&obligation=ob_code',
      notificationId: 'n1',
      inApp: true,
      tag: 'ob_code',
    });
    expect(sent[0][2]).toMatchObject({ TTL: 600, urgency: 'high' });
  });

  test('a long body is cut, so the payload stays under the push limit', async () => {
    const { deps, envelopes } = webHarness(
      context({ notification: { ...notification, body: 'word '.repeat(400) } }),
    );
    await dispatchWebNotification('u', 'n1', deps, {});
    expect(envelopes[0].body.length).toBeLessThanOrEqual(301);
  });

  test('a 404 or a 410 removes the subscription; other failures keep it', async () => {
    const statuses: Record<string, number> = { gone: 410, missing: 404, busy: 503 };
    const { deps, mutations } = webHarness(
      context({ subscriptions: [subscription('gone'), subscription('missing'), subscription('busy')] }),
      async (_envelope, target) => {
        const name = target.endpoint.split('/').pop();
        throw Object.assign(new Error(`failed ${name}`), { statusCode: statuses[name] });
      },
    );
    expect(await dispatchWebNotification('u', 'n1', deps, {})).toEqual({ sent: 0, failed: 3 });
    expect(
      mutations
        .filter((call) => call.fn === 'albatrossNotifications:expireSubscription')
        .map((call) => call.args.endpoint),
    ).toEqual([subscription('gone').endpoint, subscription('missing').endpoint]);
    expect(mutations.find((call) => call.fn === 'albatrossNotifications:recordDelivery')?.args).toMatchObject(
      {
        channel: 'web_push',
        status: 'failed',
        error: 'failed busy',
      },
    );
  });

  test('`status` also reads as the code of a dead subscription', async () => {
    const { deps, mutations } = webHarness(context(), async () => {
      throw Object.assign(new Error('gone'), { status: 410 });
    });
    await dispatchWebNotification('u', 'n1', deps, {});
    expect(mutations.map((call) => call.fn)).toContain('albatrossNotifications:expireSubscription');
    expect(mutations.find((call) => call.fn === 'albatrossNotifications:recordDelivery')?.args.error).toBe(
      'All browser subscriptions are expired.',
    );
  });

  test('one browser that fails does not stop the other, and a non-Error failure has text', async () => {
    const { deps, mutations } = webHarness(
      context({ subscriptions: [subscription('bad'), subscription('good')] }),
      async (_envelope, target) => {
        if (target.endpoint.endsWith('bad')) throw 'plain failure';
        return { statusCode: 201 };
      },
    );
    expect(await dispatchWebNotification('u', 'n1', deps, {})).toEqual({ sent: 1, failed: 1 });
    expect(mutations.at(-1)?.args).toMatchObject({ status: 'sent' });
    const none = webHarness(context(), async () => {
      throw 'plain failure';
    });
    await dispatchWebNotification('u', 'n1', none.deps, {});
    expect(none.mutations.at(-1)?.args).toMatchObject({ status: 'failed', error: 'plain failure' });
  });

  test('a failed write of the record or the expiry does not fail the send', async () => {
    const failing = webHarness(context());
    failing.deps.mutate = (async () => {
      throw new Error('Convex down');
    }) as any;
    expect(await dispatchWebNotification('u', 'n1', failing.deps, {})).toEqual({ sent: 1, failed: 0 });
    const gone = webHarness(context(), async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    gone.deps.mutate = failing.deps.mutate;
    expect(await dispatchWebNotification('u', 'n1', gone.deps, {})).toEqual({ sent: 0, failed: 1 });
  });

  test('no row, no subscription, or a send that already went: nothing goes and nothing is written', async () => {
    for (const [value, skipped] of [
      [null, 'not_found'],
      [context({ subscriptions: [] }), 'no_subscriptions'],
      [context({ deliveries: [{ channel: 'web_push', status: 'sent' }] }), 'already_sent'],
    ] as const) {
      const { deps, envelopes, mutations } = webHarness(value);
      expect(await dispatchWebNotification('u', 'n1', deps, {})).toEqual({ sent: 0, failed: 0, skipped });
      expect(envelopes).toEqual([]);
      expect(mutations).toEqual([]);
    }
    // Only a sent record on this channel stops the send.
    const { deps, envelopes } = webHarness(
      context({
        deliveries: [
          { channel: 'native_push', status: 'sent' },
          { channel: 'web_push', status: 'failed' },
        ],
      }),
    );
    await dispatchWebNotification('u', 'n1', deps);
    expect(envelopes).toHaveLength(1);
  });
});

describe('sendWebPush', () => {
  const envelope: NotificationEnvelope = {
    id: 'n1',
    userId: 'u',
    title: 'T',
    body: 'B',
    deepLink: '/',
  };
  let sent: any[];
  let restore: () => void;
  const previous = { ...process.env };
  beforeEach(() => {
    sent = [];
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'public-key';
    process.env.VAPID_PRIVATE_KEY = 'private-key';
    process.env.LAB86_NOTIFICATION_LINK_SECRET = 'link-secret';
    restore = setNotificationDeliveryDependenciesForTest({
      hostedPublicUrl: () => 'https://mail.example.test',
      setVapidDetails: (() => undefined) as any,
      sendNotification: (async (...args: any[]) => {
        sent.push(args);
        return { statusCode: 201 };
      }) as any,
    });
  });
  afterEach(() => {
    restore();
    for (const key of [
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
      'VAPID_PRIVATE_KEY',
      'LAB86_NOTIFICATION_LINK_SECRET',
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  test('the topic is the hash of the collapse id: URL-safe, at most 32 characters, stable', () => {
    const long = 'x'.repeat(200);
    for (const id of ['k57abc', SUMMARY_COLLAPSE_ID, long]) {
      expect(webPushTopic(id)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(webPushTopic(id)).toBe(webPushTopic(id));
    }
    expect(webPushTopic('a')).not.toBe(webPushTopic('b'));
  });

  test('a Needs you push has the topic, the tag, and a plain link', async () => {
    await sendWebPush(
      { ...envelope, collapseId: 'ob_1', appLink: needsYouItemLink('ob_1') },
      subscription('one'),
    );
    expect(sent[0][2]).toEqual({
      TTL: 60 * 60 * 12,
      urgency: 'normal',
      topic: webPushTopic('ob_1'),
      timeout: 10_000,
    });
    expect(JSON.parse(sent[0][1])).toEqual({
      title: 'T',
      body: 'B',
      url: '/?view=notifications&obligation=ob_1',
      notificationId: 'n1',
      inApp: true,
      tag: 'ob_1',
    });
  });

  test('a push of another type keeps its options and its signed link', async () => {
    await sendWebPush(envelope, subscription('one'));
    expect(sent[0][2]).toEqual({ TTL: 60 * 60 * 12, urgency: 'normal' });
    const payload = JSON.parse(sent[0][1]);
    expect(payload.url).toContain('https://mail.example.test/api/notifications/open?');
    expect('inApp' in payload || 'tag' in payload).toBe(false);
  });
});

function deliveryHarness(claims: any[], channels: { native?: any; web?: any } = {}) {
  const native: any[] = [];
  const web: any[] = [];
  let index = 0;
  const run = (channel: any, sink: any[]) =>
    (async (userId: string, notificationId: string, _deps: any, options: any) => {
      sink.push({ userId, notificationId, options });
      if (channel instanceof Error) throw channel;
      return channel ?? { sent: 1, failed: 0 };
    }) as any;
  return {
    native,
    web,
    deps: {
      query: (async () => ({ userIds: ['u1'] })) as any,
      mutate: (async () => {
        const claim = claims[index++];
        if (claim instanceof Error) throw claim;
        return claim;
      }) as any,
      dispatch: run(channels.native, native),
      dispatchWeb: run(channels.web, web),
      clock: () => 1_000,
    },
  };
}

const claim = {
  action: 'push',
  notificationId: 'n1',
  collapseId: 'ob1',
  codeAvailable: false,
  timeSensitive: false,
};

describe('one decision, two channels (lib/obligations/delivery.ts)', () => {
  test('a push goes to APNs and to the browser, with the same options', async () => {
    const { deps, native, web } = deliveryHarness([claim]);
    expect(await deliverObligationPushes('u', ['ob1'], deps)).toEqual({
      pushed: 1,
      held: 0,
      inApp: 0,
      failed: 0,
    });
    const options = { collapseId: 'ob1', obligationId: 'ob1' };
    expect(native).toEqual([{ userId: 'u', notificationId: 'n1', options }]);
    expect(web).toEqual(native);
  });

  test('a hold or an in-app decision sends to neither channel', async () => {
    const { deps, native, web } = deliveryHarness([
      { action: 'hold', reason: 'quiet_hours', until: 5 },
      { action: 'none', reason: 'in_app_only' },
    ]);
    expect(await deliverObligationPushes('u', ['a', 'b'], deps)).toMatchObject({
      held: 1,
      inApp: 1,
      pushed: 0,
    });
    expect(native).toEqual([]);
    expect(web).toEqual([]);
  });

  test('a web failure does not stop APNs, and an APNs failure does not stop the web', async () => {
    const webDown = deliveryHarness([claim], { web: new Error('push service down') });
    expect(await deliverObligationPushes('u', ['ob1'], webDown.deps)).toMatchObject({ pushed: 1, failed: 0 });
    expect(webDown.native).toHaveLength(1);
    const apnsDown = deliveryHarness([claim], { native: new Error('APNs down') });
    expect(await deliverObligationPushes('u', ['ob1'], apnsDown.deps)).toMatchObject({
      pushed: 1,
      failed: 0,
    });
    expect(apnsDown.web).toHaveLength(1);
  });

  test('the item fails only when a channel threw and no channel reached a device', async () => {
    const both = deliveryHarness([claim], { native: new Error('a'), web: new Error('b') });
    expect(await deliverObligationPushes('u', ['ob1'], both.deps)).toMatchObject({ pushed: 0, failed: 1 });
    const webOnlyUser = deliveryHarness([claim], {
      native: { sent: 0, failed: 0, skipped: 'no_devices' },
      web: new Error('b'),
    });
    expect(await deliverObligationPushes('u', ['ob1'], webOnlyUser.deps)).toMatchObject({ failed: 1 });
    const noDevice = deliveryHarness([claim], {
      native: { sent: 0, failed: 0, skipped: 'no_devices' },
      web: { sent: 0, failed: 0, skipped: 'no_subscriptions' },
    });
    expect(await deliverObligationPushes('u', ['ob1'], noDevice.deps)).toMatchObject({ pushed: 1 });
  });

  test('a release goes to both channels, as a single push or as the summary', async () => {
    const single = deliveryHarness([
      {
        kind: 'push',
        push: { notificationId: 'n1', collapseId: 'ob1', codeAvailable: false, timeSensitive: false },
      },
    ]);
    expect(await releaseHeldObligationPushes(single.deps)).toMatchObject({ pushes: 1 });
    expect(single.web[0].options).toEqual({ collapseId: 'ob1', obligationId: 'ob1' });
    const summary = deliveryHarness([{ kind: 'summary', notificationId: 'n2', count: 3 }]);
    expect(await releaseHeldObligationPushes(summary.deps)).toMatchObject({ summaries: 1 });
    expect(summary.web[0].options).toEqual({ collapseId: SUMMARY_COLLAPSE_ID });
    expect(summary.native).toEqual(summary.web);
    const failed = deliveryHarness([{ kind: 'summary', notificationId: 'n2', count: 3 }], {
      native: new Error('a'),
      web: new Error('b'),
    });
    expect(await releaseHeldObligationPushes(failed.deps)).toMatchObject({ failed: 1, summaries: 0 });
  });
});

describe('iPhone pushes off, browser alerts on', () => {
  const candidate = { kind: 'reply', state: 'open', pushLevel: 'normal' } as const;
  const base = obligationPushSettingsFromRow({ nativePushEnabled: false });
  test('the decision needs one channel', () => {
    expect(anyPushChannel(base)).toBe(false);
    expect(anyPushChannel({ ...base, webPushActive: true })).toBe(true);
    expect(anyPushChannel({ nativePushEnabled: true })).toBe(true);
    const decide = (settings: typeof base) =>
      decideObligationPush({ obligation: candidate, settings, now: 1_000, recentPushes: [] });
    expect(decide(base)).toEqual({ action: 'none', reason: 'disabled' });
    expect(decide({ ...base, webPushActive: true })).toMatchObject({ action: 'push' });
    // The other switch still stops it.
    expect(decide({ ...base, webPushActive: true, obligationPushEnabled: false })).toEqual({
      action: 'none',
      reason: 'disabled',
    });
  });
});

describe('the service worker', () => {
  const source = readFileSync(path.join(import.meta.dir, '../public/albatross-sw.js'), 'utf8');

  function worker(clients: any[], openWindow?: (url: string) => any) {
    const listeners: Record<string, (event: any) => void> = {};
    const shown: any[] = [];
    const opened: string[] = [];
    const self = {
      skipWaiting: async () => shown.push('skipWaiting'),
      addEventListener: (name: string, listener: (event: any) => void) => {
        listeners[name] = listener;
      },
      registration: {
        showNotification: async (title: string, options: any) => shown.push({ title, options }),
      },
      clients: {
        claim: async () => shown.push('claim'),
        matchAll: async () => clients,
        openWindow:
          openWindow ??
          (async (url: string) => {
            opened.push(url);
          }),
      },
    };
    new Function('self', source)(self);
    return { listeners, shown, opened };
  }

  async function click(listeners: Record<string, (event: any) => void>, data: any) {
    let closed = false;
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({
      notification: {
        data,
        close: () => {
          closed = true;
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        done = promise;
      },
    });
    await done;
    expect(closed).toBe(true);
  }

  function tab(url: string, patch: Record<string, unknown> = {}) {
    const calls: any[] = [];
    return {
      calls,
      url,
      focus: async () => {
        calls.push('focus');
      },
      postMessage: (message: any) => calls.push(message),
      navigate: async (to: string) => {
        calls.push(`navigate ${to}`);
        return null;
      },
      ...patch,
    };
  }

  const item = { url: '/?view=notifications&obligation=ob_1', inApp: true };

  test('a push with a tag alerts again when it replaces one, and other pushes stay silent', async () => {
    const { listeners, shown } = worker([]);
    const push = async (payload: Record<string, unknown>) => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.push({
        data: { json: () => payload },
        waitUntil: (promise: Promise<unknown>) => {
          done = promise;
        },
      });
      await done;
    };
    await push({ title: 'Needs you', tag: 'ob_1' });
    await push({ title: 'Check-in', notificationId: 'n1' });
    expect(shown[0].options).toMatchObject({ tag: 'ob_1', renotify: true });
    expect(shown[1].options).toMatchObject({ tag: 'n1', renotify: false });
  });

  test('a tab that cannot take the link does not lose the click', async () => {
    // The message cannot reach the tab: a new tab opens. The app tab does not load a page.
    const silent = tab('https://mail.example.test/', {
      postMessage: () => {
        throw new Error('gone');
      },
    });
    const app = worker([silent]);
    await click(app.listeners, item);
    expect(app.opened).toEqual([item.url]);
    expect(silent.calls).toEqual([]);
    // A tab that cannot move: a new tab opens.
    const stuck = tab('https://mail.example.test/settings', {
      navigate: async () => {
        throw new Error('gone');
      },
    });
    const plain = worker([stuck]);
    await click(plain.listeners, { url: '/x', inApp: false });
    expect(plain.opened).toEqual(['/x']);
  });

  test('a focus that fails after the link went through opens no second tab', async () => {
    const away = tab('https://mail.example.test/', {
      focus: async () => {
        throw new Error('not allowed');
      },
    });
    const app = worker([away]);
    await click(app.listeners, item);
    expect(app.opened).toEqual([]);
    expect(away.calls).toEqual([{ type: 'albatross:open-link', url: item.url }]);
  });

  test('the tab that navigate returns takes the focus', async () => {
    const replaced = tab('https://mail.example.test/other');
    const old = tab('https://mail.example.test/settings', {
      navigate: async () => replaced,
    });
    const run = worker([old]);
    await click(run.listeners, { url: '/x', inApp: false });
    expect(replaced.calls).toEqual(['focus']);
    // The focus starts before the page load, while the click permission lasts.
    expect(old.calls).toEqual(['focus']);
  });

  test('a new version takes over at once, so a tab that it controls can move', async () => {
    const { listeners, shown } = worker([]);
    listeners.install({});
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate({
      waitUntil: (promise: Promise<unknown>) => {
        done = promise;
      },
    });
    await done;
    expect(shown).toEqual(['skipWaiting', 'claim']);
  });

  test('the tag of a push is the collapse id, so a later push replaces it', async () => {
    const { listeners, shown } = worker([]);
    const push = async (json: any) => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.push({
        data: { json: () => json },
        waitUntil: (promise: Promise<unknown>) => {
          done = promise;
        },
      });
      await done;
    };
    await push({ title: 'T', body: 'B', tag: 'ob_1', notificationId: 'n1', ...item });
    await push({ title: 'T', notificationId: 'n2', url: '/x' });
    expect(shown[0].options).toMatchObject({ tag: 'ob_1', data: item, body: 'B' });
    expect(shown[1].options).toMatchObject({ tag: 'n2', data: { url: '/x', inApp: false } });
  });

  test('a tab of the app gets the link and the focus, with no page load', async () => {
    const other = tab('https://mail.example.test/settings');
    const app = tab('https://mail.example.test/?view=mail');
    const { listeners, opened } = worker([other, app]);
    await click(listeners, item);
    expect(app.calls).toEqual([{ type: NEEDS_YOU_PUSH_MESSAGE, url: item.url }, 'focus']);
    expect(other.calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('a tab on another page moves to the link; with no tab, a new tab opens', async () => {
    const other = tab('https://mail.example.test/settings');
    const moved = worker([other]);
    await click(moved.listeners, item);
    expect(other.calls).toEqual([`navigate ${item.url}`, 'focus']);
    const fresh = worker([]);
    await click(fresh.listeners, item);
    expect(fresh.opened).toEqual([item.url]);
  });

  test('a tab that cannot move falls through to a new tab', async () => {
    const stuck = tab('https://mail.example.test/settings', {
      navigate: async () => {
        throw new TypeError('not controlled');
      },
    });
    const { listeners, opened } = worker([stuck]);
    await click(listeners, item);
    expect(opened).toEqual([item.url]);
  });

  test('a bad tab url is not the app', async () => {
    const odd = tab('not a url');
    const moved = worker([odd]);
    await click(moved.listeners, item);
    expect(odd.calls).toEqual([`navigate ${item.url}`, 'focus']);
  });

  test('a notification of another type keeps the old path', async () => {
    const app = tab('https://mail.example.test/');
    const { listeners, opened } = worker([app]);
    await click(listeners, { url: '/api/notifications/open?sig=x' });
    expect(app.calls).toEqual(['navigate /api/notifications/open?sig=x', 'focus']);
    const fresh = worker([]);
    await click(fresh.listeners, undefined);
    expect(fresh.opened).toEqual(['/']);
    expect(opened).toEqual([]);
  });
});

describe('the link in the tab', () => {
  test('the link names the page and the item, and the id survives encoding', () => {
    expect(needsYouItemLink('ob/1 2')).toBe('/?view=notifications&obligation=ob%2F1%202');
    expect(obligationIdFromSearch('?view=notifications&obligation=ob%2F1%202')).toBe('ob/1 2');
    expect(obligationIdFromSearch('?view=notifications')).toBeNull();
    expect(pushLinkTarget(`?${needsYouItemLink('ob_1').split('?')[1]}`)).toEqual({
      view: 'notifications',
      obligationId: 'ob_1',
    });
    expect(pushLinkTarget(NEEDS_YOU_LINK.slice(1))).toEqual({ view: 'notifications', obligationId: null });
  });

  test('only the message of the worker counts', () => {
    expect(pushMessageSearch({ type: NEEDS_YOU_PUSH_MESSAGE, url: needsYouItemLink('ob_1') })).toBe(
      '?view=notifications&obligation=ob_1',
    );
    expect(pushMessageSearch({ type: NEEDS_YOU_PUSH_MESSAGE, url: '/' })).toBe('');
    expect(pushMessageSearch({ type: 'other', url: '/x' })).toBeNull();
    expect(pushMessageSearch({ type: NEEDS_YOU_PUSH_MESSAGE })).toBeNull();
    expect(pushMessageSearch(null)).toBeNull();
  });
});

describe('the browser path of Settings', () => {
  let unsubscribed = 0;
  function browser(patch: Partial<BrowserPushEnvironment> = {}, current: any = null) {
    const calls: any[] = [];
    const subscription =
      current ??
      ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser',
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser', keys: {} }),
        unsubscribe: async () => {
          unsubscribed += 1;
          return true;
        },
      } as any);
    const registration: any = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (options: any) => {
          calls.push(['subscribe', options]);
          return subscription;
        },
      },
    };
    const env: BrowserPushEnvironment = {
      serviceWorker: {
        register: async (url: string) => {
          calls.push(['register', url]);
          return registration;
        },
        getRegistration: async () => registration,
      } as any,
      permission: () => 'default',
      requestPermission: async () => 'granted',
      publicKey: 'AQAB',
      fetch: (async (url: string, init: any) => {
        calls.push([init.method, url, JSON.parse(init.body)]);
        return new Response('{}', { status: 200 });
      }) as any,
      decode: (value) => atob(value),
      ...patch,
    };
    return { env, calls };
  }

  test('reads the state of this browser', async () => {
    expect(await readBrowserPush(browser({ serviceWorker: null }).env)).toBe('unsupported');
    expect(await readBrowserPush(browser({ permission: () => 'denied' }).env)).toBe('blocked');
    expect(await readBrowserPush(browser().env)).toBe('off');
    expect(await readBrowserPush(browser({}, { endpoint: 'x' }).env)).toBe('on');
    const broken = browser({
      serviceWorker: { getRegistration: async () => Promise.reject(new Error('no')) } as any,
    });
    expect(await readBrowserPush(broken.env)).toBe('off');
  });

  test('a test run has no browser, so the default path says unsupported', async () => {
    expect(browserPushEnvironment().serviceWorker).toBeNull();
    expect(await readBrowserPush()).toBe('unsupported');
  });

  test('enable asks, registers the worker, subscribes, and saves the subscription', async () => {
    const { env, calls } = browser();
    await enableBrowserPush(env);
    expect(calls[0]).toEqual(['register', '/albatross-sw.js']);
    expect(calls[1][0]).toBe('subscribe');
    expect(calls[1][1].userVisibleOnly).toBe(true);
    expect([...calls[1][1].applicationServerKey]).toEqual([1, 0, 1]);
    expect(calls[2]).toEqual([
      'POST',
      '/api/notifications/push',
      { endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser', keys: {} },
    ]);
  });

  test('enable says what stopped it', async () => {
    await expect(enableBrowserPush(browser({ serviceWorker: null }).env)).rejects.toThrow(
      'This browser does not support Web Push.',
    );
    await expect(enableBrowserPush(browser({ requestPermission: async () => 'denied' }).env)).rejects.toThrow(
      'Notification permission was not granted.',
    );
    await expect(enableBrowserPush(browser({ publicKey: undefined }).env)).rejects.toThrow(
      'Web Push is not configured on this deployment.',
    );
    unsubscribed = 0;
    const refused = (body: string) =>
      browser({ fetch: (async () => new Response(body, { status: 400 })) as any }).env;
    await expect(
      enableBrowserPush(refused('{"error":"complete push subscription required"}')),
    ).rejects.toThrow('complete push subscription required');
    await expect(enableBrowserPush(refused('not json'))).rejects.toThrow('Could not enable Web Push.');
    // The server refused it, so this browser does not stay subscribed.
    expect(unsubscribed).toBe(2);
  });

  test('a request that never reaches the server leaves no subscription', async () => {
    unsubscribed = 0;
    const offline = browser({
      fetch: (async () => {
        throw new Error('offline');
      }) as any,
    }).env;
    await expect(enableBrowserPush(offline)).rejects.toThrow('offline');
    expect(unsubscribed).toBe(1);
  });

  test('after a failed save, this browser leaves even when the server cannot hear it', async () => {
    let gone = 0;
    const current = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser',
      unsubscribe: async () => {
        gone += 1;
        return true;
      },
    };
    const { env } = browser(
      {
        fetch: (async () => {
          throw new Error('offline');
        }) as any,
      },
      current,
    );
    await abandonBrowserPush(env);
    expect(gone).toBe(1);
    await abandonBrowserPush(browser().env);
  });

  test('a server that does not answer cannot hold back the local removal', async () => {
    let gone = 0;
    const current = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser',
      unsubscribe: async () => {
        gone += 1;
        return true;
      },
    };
    const { env } = browser({ fetch: (() => new Promise(() => undefined)) as any }, current);
    void abandonBrowserPush(env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gone).toBe(1);
  });

  test('a failure keeps a subscription that this browser already had', async () => {
    let gone = 0;
    const had = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser', keys: {} }),
      unsubscribe: async () => {
        gone += 1;
        return true;
      },
    };
    const refused = browser({ fetch: (async () => new Response('{}', { status: 500 })) as any }, had).env;
    await expect(enableBrowserPush(refused)).rejects.toThrow('Could not enable Web Push.');
    expect(gone).toBe(0);
    expect(await enableBrowserPush(browser({}, had).env)).toEqual({ created: false });
  });

  test('disable tells the server first, then removes the subscription', async () => {
    const order: string[] = [];
    const current = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/this-browser',
      unsubscribe: async () => order.push('unsubscribe'),
    };
    const { env, calls } = browser(
      {
        fetch: (async (url: string, init: any) => {
          order.push('server');
          calls.push([init.method, url, JSON.parse(init.body)]);
          return new Response('{}', { status: 200 });
        }) as any,
      },
      current,
    );
    await disableBrowserPush(env);
    expect(order).toEqual(['server', 'unsubscribe']);
    expect(calls[0]).toEqual(['DELETE', '/api/notifications/push', { endpoint: current.endpoint }]);
  });

  test('a failed disable keeps the subscription, and a browser with none has nothing to do', async () => {
    let removed = false;
    const current = {
      endpoint: 'x',
      unsubscribe: async () => {
        removed = true;
      },
    };
    const refused = browser({ fetch: (async () => new Response('{}', { status: 500 })) as any }, current);
    await expect(disableBrowserPush(refused.env)).rejects.toThrow(
      'Could not turn off alerts in this browser.',
    );
    expect(removed).toBe(false);
    const none = browser();
    await disableBrowserPush(none.env);
    expect(none.calls).toEqual([]);
  });

  test('the key decodes from URL-safe base64', () => {
    expect([...urlBase64ToUint8Array('_-A')]).toEqual([255, 224]);
  });
});
