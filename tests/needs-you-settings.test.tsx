import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { postObligationAction, postObligationDraft, postObligationReply } from '../components/needs-you/data';
import { needsYouFlagsOf, saveCodesEnabled } from '../components/needs-you/NeedsYouAlertsSettings';
import {
  MAIL_PUSH_QUERY_KEY,
  MailAlertsSettings,
  type NeedsYouAlertsProps,
} from '../components/settings/MailAlertsSettings';
import type { MailPushSettings } from '../lib/notifications/mail-push';

/* Settings, Notifications for a Needs you user (docs/needs-you-phase-1.md, W4),
 * and the requests behind the page's actions. */

const settings: MailPushSettings = {
  mode: 'priority',
  quietHours: { enabled: true, start: 22, end: 7 },
  vipSenders: ['dana@northwindlegal.example.com'],
  timezone: 'America/Los_Angeles',
} as MailPushSettings;

const render = (needsYou?: NeedsYouAlertsProps) => {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  query.setQueryData(MAIL_PUSH_QUERY_KEY, settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={query}>
      <MailAlertsSettings timezone="America/Los_Angeles" needsYou={needsYou} />
    </QueryClientProvider>,
  );
};
const noop = () => {};

describe('the Needs you rows', () => {
  test('a flag user gets the push switch, quiet hours, VIP senders, and codes, and no per-mail select', () => {
    const html = render({
      pushEnabled: true,
      onPushEnabledChange: noop,
      codesEnabled: false,
      onCodesEnabledChange: noop,
    });
    expect(html).toContain('Needs you');
    expect(html).toContain('Push me when something needs me');
    expect(html).toContain('At most 4 pushes an hour, codes not included.');
    expect(html).toContain('Codes and time-sensitive changes do not wait.');
    expect(html).toContain('A VIP mail that needs nothing from you does not push.');
    expect(html).toContain('dana@northwindlegal.example.com');
    expect(html).toContain('Verification codes');
    expect(html).toContain('There is no setting for each new mail.');
    expect(html).not.toContain('Push for');
    expect(html).not.toContain('Every new email');
    expect(html).not.toContain('Priority only');
    const page = new JSDOM(html).window.document;
    expect(page.querySelector('#needs-you-push')?.getAttribute('aria-checked')).toBe('true');
    expect(page.querySelector('#needs-you-codes')?.getAttribute('aria-checked')).toBe('false');
  });

  test('everyone else keeps the mail alerts as they were', () => {
    const html = render();
    expect(html).toContain('Mail alerts');
    expect(html).toContain('Priority only');
    expect(html).not.toContain('Push me when something needs me');
    expect(html).not.toContain('Verification codes');
  });

  test('the flags read on when the row does not carry them', () => {
    expect(needsYouFlagsOf(undefined)).toEqual({ pushEnabled: true, codesEnabled: true });
    expect(needsYouFlagsOf({ obligationPushEnabled: false })).toEqual({
      pushEnabled: false,
      codesEnabled: true,
    });
    expect(needsYouFlagsOf({ oneTimeCodeAutofillEnabled: false })).toEqual({
      pushEnabled: true,
      codesEnabled: false,
    });
  });
});

describe('the requests', () => {
  const fetchSpy = spyOn(globalThis, 'fetch');
  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());
  const call = (index = 0) => {
    const [url, init] = fetchSpy.mock.calls[index] as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null };
  };

  test('an action posts to the obligation; the id is encoded', async () => {
    fetchSpy.mockResolvedValue(Response.json({ obligation: { id: 'a/b' }, undoUntil: 5 }));
    const response = await postObligationAction('a/b', { action: 'later', until: 9 });
    expect(call()).toEqual({
      url: '/api/obligations/a%2Fb',
      method: 'POST',
      body: { action: 'later', until: 9 },
    });
    expect(response.undoUntil).toBe(5);
  });

  test('the draft and the reply have their own routes', async () => {
    fetchSpy.mockResolvedValue(Response.json({ draft: { to: [], cc: [], subject: '', body: 'Hi' } }));
    expect((await postObligationDraft('ob')).draft.body).toBe('Hi');
    expect(call().url).toBe('/api/obligations/ob/draft');
    fetchSpy.mockResolvedValue(Response.json({ obligation: { id: 'ob' } }));
    await postObligationReply('ob', 'Thanks');
    expect(call(1)).toEqual({ url: '/api/obligations/ob/reply', method: 'POST', body: { body: 'Thanks' } });
  });

  test('a failed request throws the server message, or a plain one', async () => {
    fetchSpy.mockResolvedValue(Response.json({ error: 'Too late to undo.' }, { status: 409 }));
    await expect(postObligationAction('ob', { action: 'undo' })).rejects.toThrow('Too late to undo.');
    fetchSpy.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(postObligationDraft('ob')).rejects.toThrow('Could not prepare a draft.');
  });

  test('the codes switch reads the mobile preferences, changes one flag, and writes them back', async () => {
    const preferences = { nativePushEnabled: true, oneTimeCodeAutofillEnabled: true, timezone: 'UTC' };
    fetchSpy
      .mockResolvedValueOnce(Response.json({ ok: true, preferences }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await saveCodesEnabled(false);
    expect(call(0)).toMatchObject({ url: '/api/mobile/preferences', method: 'POST' });
    expect(call(1)).toEqual({
      url: '/api/mobile/preferences',
      method: 'PUT',
      body: { ...preferences, oneTimeCodeAutofillEnabled: false },
    });
    fetchSpy.mockResolvedValueOnce(Response.json({ ok: false }, { status: 500 }));
    await expect(saveCodesEnabled(true)).rejects.toThrow('Could not read the current settings.');
    fetchSpy
      .mockResolvedValueOnce(Response.json({ ok: true, preferences }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: 'Bad zone.' }, { status: 400 }));
    await expect(saveCodesEnabled(true)).rejects.toThrow('Bad zone.');
  });
});
