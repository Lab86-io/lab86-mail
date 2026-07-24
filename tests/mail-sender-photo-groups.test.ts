import { describe, expect, test } from 'bun:test';
import { groupSenderEmailsByAccount } from '../lib/mail/sender-photo-groups';

// Stage 1 iOS 0.8 parity / desktop Inbox fix: photo resolution must group
// visible rows by their REAL account rather than resolving every row against
// one shared account, otherwise the unified ALL_ACCOUNTS view returns wrong
// or missing photos for any row from a different mailbox.
describe('groupSenderEmailsByAccount', () => {
  test("groups by each row's own account, falling back when a row has none", () => {
    const groups = groupSenderEmailsByAccount(
      [
        { account: 'acct_1', from: 'Ann <ann@example.com>' },
        { account: 'acct_2', from: 'Bob <bob@example.com>' },
        { from: 'Cara <cara@example.com>' }, // no account on the row itself
      ],
      'acct_1',
    );
    expect(groups).toEqual({
      acct_1: ['ann@example.com', 'cara@example.com'],
      acct_2: ['bob@example.com'],
    });
  });

  test('dedupes and lowercases emails within an account, sorted', () => {
    const groups = groupSenderEmailsByAccount(
      [
        { account: 'acct_1', from: 'Ann <Ann@Example.com>' },
        { account: 'acct_1', fromAddress: 'ann@example.com' },
        { account: 'acct_1', from: 'Zed <zed@example.com>' },
      ],
      'acct_1',
    );
    expect(groups).toEqual({ acct_1: ['ann@example.com', 'zed@example.com'] });
  });

  test('drops rows with no parseable email and rows without any account', () => {
    const groups = groupSenderEmailsByAccount(
      [{ account: 'acct_1', from: 'No email here' }, { from: 'Cara <cara@example.com>' }],
      '',
    );
    expect(groups).toEqual({});
  });

  test('caps at the first `limit` rows', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      account: 'acct_1',
      from: `Person${i} <person${i}@example.com>`,
    }));
    const groups = groupSenderEmailsByAccount(rows, 'acct_1', 2);
    expect(groups.acct_1).toEqual(['person0@example.com', 'person1@example.com']);
  });
});
