import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { SecureDetailsList } from '../components/settings/SecureDetailsList';
import { SECURE_COPY, secureUseLine } from '../lib/albatross/secure-view';
import type { SecureItemView } from '../lib/secure/contract';

/* Passwords and IDs: the mail domains an item may fill a sealed file for
 * ("Always for mail to {domain}") show as rows with Remove, and the new use
 * lines of a send or a download read in the same list. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);

const taxId: SecureItemView = {
  id: 'secure_tax_id',
  kind: 'id_number',
  label: 'Tax ID',
  sites: [],
  mailDomains: ['bramble-press.example.com'],
  hints: { number: 'ends 4821' },
  facts: { idType: 'Social security number' },
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  lastUsedAt: NOW - 600_000,
};

function renderList(item: SecureItemView, onRemoveMailDomain?: () => void) {
  const html = renderToStaticMarkup(
    <SecureDetailsList
      items={[item]}
      now={NOW}
      timeZone="UTC"
      openId={item.id}
      onToggle={() => undefined}
      uses={{ [item.id]: { status: 'ready', uses: [] } }}
      busy={null}
      onReplace={async () => true}
      onRename={async () => true}
      onRemoveSite={() => undefined}
      onAddSite={async () => true}
      onRemoveMailDomain={onRemoveMailDomain}
      onDelete={() => undefined}
      onAdd={() => undefined}
    />,
  );
  return new JSDOM(html).window.document;
}

describe('the mail domain rows', () => {
  test('one row per domain, "Mail to {domain}", with Remove', () => {
    const doc = renderList(taxId, () => undefined);
    const rows = doc.querySelector('[data-slot="secure-mail-domains"]')!;
    expect(rows.textContent).toContain('Mail');
    expect(rows.textContent).toContain('Mail to bramble-press.example.com');
    expect(rows.textContent).toContain(SECURE_COPY.mailAlways);
    expect(rows.querySelector('button')?.textContent).toBe('Remove');
    expect(rows.querySelector('button')?.hasAttribute('disabled')).toBe(false);
  });

  test('no rows without domains', () => {
    const doc = renderList({ ...taxId, mailDomains: [] });
    expect(doc.querySelector('[data-slot="secure-mail-domains"]')).toBeNull();
    expect(
      renderList({ ...taxId, mailDomains: undefined }).querySelector('[data-slot="secure-mail-domains"]'),
    ).toBeNull();
  });
});

describe('the use lines of a send or a download', () => {
  test('read in the item history', () => {
    const use = { field: 'number', site: 'bramble-press.example.com' };
    expect(secureUseLine({ ...use, outcome: 'allowed_send_once' }, 'id_number')).toBe(
      'You allowed it in a file for one send to bramble-press.example.com',
    );
    expect(secureUseLine({ ...use, outcome: 'allowed_send_always' }, 'id_number')).toBe(
      'You allowed it in files for mail to bramble-press.example.com from now on',
    );
    expect(secureUseLine({ ...use, outcome: 'downloaded' }, 'id_number')).toBe(
      'You downloaded a file with it',
    );
    expect(secureUseLine({ ...use, outcome: 'allowed_once' }, 'id_number')).toBe(
      'You allowed it on bramble-press.example.com for one run',
    );
  });
});
