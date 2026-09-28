import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createNylasStatusGet } from '../app/api/nylas/status/route';
import { ContactsStatusLine, contactStatusText } from '../components/settings/ContactsStatusLine';
import { AuthRequiredError } from '../lib/auth/current-user';
import type { ContactAccountStatus } from '../lib/contacts/lookup';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const status = (overrides: Partial<ContactAccountStatus> = {}): ContactAccountStatus => ({
  accountId: 'acct',
  email: 'me@acme.com',
  provider: 'google',
  state: 'ready',
  needsReconnect: false,
  contactCount: 1_204,
  lastSyncedAt: NOW - 3 * 3_600_000,
  sources: [],
  ...overrides,
});

describe('Settings contact line', () => {
  test('plain copy for each state', () => {
    expect(contactStatusText(status(), NOW)).toBe('1,204 contacts · synced 3 hours ago');
    expect(contactStatusText(status({ contactCount: 1, lastSyncedAt: NOW - 30_000 }), NOW)).toBe(
      '1 contact · synced just now',
    );
    expect(contactStatusText(status({ contactCount: 0, lastSyncedAt: NOW - 5 * 60_000 }), NOW)).toBe(
      'No contacts · synced 5 mins ago',
    );
    expect(contactStatusText(status({ lastSyncedAt: NOW - 60_000 }), NOW)).toBe(
      '1,204 contacts · synced 1 min ago',
    );
    expect(contactStatusText(status({ lastSyncedAt: NOW - 50 * 3_600_000 }), NOW)).toBe(
      '1,204 contacts · synced 2 days ago',
    );
    expect(contactStatusText(status({ lastSyncedAt: undefined }), NOW)).toBe('1,204 contacts');
    expect(contactStatusText(status({ state: 'needsReconnect' }), NOW)).toBe('Contacts need permission.');
    expect(contactStatusText(status({ state: 'syncing' }), NOW)).toBe('Contacts are syncing.');
    expect(contactStatusText(status({ state: 'pending' }), NOW)).toBe(
      'The first contact sync has not finished.',
    );
    expect(contactStatusText(status({ state: 'unsupported' }), NOW)).toBe(
      'This mailbox has no contacts to sync.',
    );
    expect(contactStatusText(status({ state: 'error' }), NOW)).toBe(
      'Contact sync failed. It will try again.',
    );
    expect(contactStatusText(status({ state: 'paused' }), NOW)).toBeNull();
  });

  test('the reconnect link shows only when a contact scope is missing', () => {
    const href = '/api/nylas/connect?provider=google&redirectTo=/settings';
    const needs = renderToStaticMarkup(
      <ContactsStatusLine
        status={status({ state: 'needsReconnect', needsReconnect: true })}
        reconnectHref={href}
        now={NOW}
      />,
    );
    expect(needs).toContain('Contacts need permission.');
    expect(needs).toContain('Reconnect to add contacts');
    expect(needs).toContain('href="/api/nylas/connect?provider=google&amp;redirectTo=/settings"');
    expect(needs).not.toMatch(/\bAI\b/);
    const ready = renderToStaticMarkup(
      <ContactsStatusLine status={status()} reconnectHref={href} now={NOW} />,
    );
    expect(ready).toContain('1,204 contacts');
    expect(ready).not.toContain('Reconnect');
    expect(renderToStaticMarkup(<ContactsStatusLine reconnectHref={href} />)).toBe('');
    expect(
      renderToStaticMarkup(<ContactsStatusLine status={status({ state: 'paused' })} reconnectHref={href} />),
    ).toBe('');
  });
});

describe('GET /api/nylas/status', () => {
  const user = { userId: 'u', email: 'me@x.io', name: 'Me', source: 'clerk' as const };
  test('adds the contact state of each mailbox and survives its failure', async () => {
    const get = createNylasStatusGet({
      requireCurrentUser: async () => user,
      listAccounts: async () => [{ accountId: 'acct' }],
      listSyncStates: async () => [],
      loadContactStatuses: async () => [status()],
    });
    const body: any = await (await get()).json();
    expect(body.contacts).toHaveLength(1);
    expect(body.accounts).toEqual([{ accountId: 'acct' }]);
    const failing = createNylasStatusGet({
      requireCurrentUser: async () => user,
      listAccounts: async () => [],
      listSyncStates: async () => [],
      loadContactStatuses: async () => {
        throw new Error('down');
      },
    });
    expect(((await (await failing()).json()) as any).contacts).toEqual([]);
    const signedOut = createNylasStatusGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
      listAccounts: async () => [],
      listSyncStates: async () => [],
      loadContactStatuses: async () => [],
    });
    expect((await signedOut()).status).toBe(401);
  });
});
