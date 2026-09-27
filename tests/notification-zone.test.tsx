import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAIL_PUSH_QUERY_KEY,
  MailAlertsSettings,
  saveMailPushSettings,
} from '../components/settings/MailAlertsSettings';
import type { MailPushSettings } from '../lib/notifications/mail-push';
import {
  initialNotificationForm,
  type NotificationPreferences,
  timeZoneLabel,
} from '../lib/notifications/preferences';

/*
 * Settings, Notifications shows one time zone: the saved notification zone.
 * With nothing saved, the device zone is saved on first load, and mail
 * alerts label quiet hours with that zone and send it with each save.
 */

const DEFAULTS: NotificationPreferences = {
  userId: 'user',
  timezone: 'UTC',
  eveningCheckinEnabled: true,
  eveningCheckinLocalTime: '19:00',
  inAppEnabled: true,
  webPushEnabled: false,
  emailFallbackEnabled: true,
  emailFallbackDelayMinutes: 90,
};

describe('the first load', () => {
  test('with no saved row, the device zone is the form zone and is saved at once', () => {
    const { form, seed } = initialNotificationForm(DEFAULTS, 'America/New_York');
    expect(form.timezone).toBe('America/New_York');
    expect(seed).toEqual({
      timezone: 'America/New_York',
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '19:00',
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: true,
      emailFallbackDelayMinutes: 90,
    });
  });

  test('a saved zone stays, and nothing is written', () => {
    const saved = { ...DEFAULTS, _id: 'row', timezone: 'Europe/Berlin' };
    expect(initialNotificationForm(saved, 'America/New_York')).toEqual({ form: saved, seed: null });
  });

  test('with no device zone, the default zone is saved so the page is still true', () => {
    expect(initialNotificationForm(DEFAULTS, '').seed?.timezone).toBe('UTC');
  });

  test('zones read with spaces', () => {
    expect(timeZoneLabel('America/New_York')).toBe('America/New York');
  });
});

describe('mail alerts', () => {
  const settings: MailPushSettings = {
    mode: 'all',
    quietHours: { enabled: false, start: 22, end: 7 },
    vipSenders: [],
    timezone: 'UTC',
  };
  const fetchSpy = spyOn(globalThis, 'fetch');
  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  test('quiet hours are labeled with the notification zone, not the default', () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    query.setQueryData(MAIL_PUSH_QUERY_KEY, settings);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={query}>
        <MailAlertsSettings timezone="America/New_York" />
      </QueryClientProvider>,
    );
    expect(html).toContain('Hours use your notification time zone (America/New York).');
    expect(html).not.toContain('(UTC)');
  });

  test('a save sends the notification zone', async () => {
    fetchSpy.mockResolvedValue(Response.json({ ok: true, settings }));
    await saveMailPushSettings({ mode: 'priority' }, 'America/New_York');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/mail/push-settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'priority', timezone: 'America/New_York' });
  });

  test('without a zone, a save sends the device zone', async () => {
    fetchSpy.mockResolvedValue(Response.json({ ok: true, settings }));
    await saveMailPushSettings({ addVipSenders: ['ann@example.com'] });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('the Notifications section', () => {
  const page = readFileSync(path.join(import.meta.dir, '..', 'app/settings/page.tsx'), 'utf8');
  const section = page.slice(page.indexOf('function NotificationsSection()'), page.indexOf('// Mailboxes'));

  test('it saves the first zone and hands the saved zone to mail alerts', () => {
    expect(section).toContain('initialNotificationForm(remote, deviceTimezone)');
    expect(section).toMatch(/savePreferences\(seed\)/);
    expect(section).toContain('<MailAlertsSettings timezone={baseline?.timezone ?? prefs.timezone} />');
    // Mail alerts are not a second, zone-less sibling on the tab.
    expect(page).not.toMatch(/<NotificationsSection \/>\s*<MailAlertsSettings \/>/);
  });
});
