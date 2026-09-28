import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import { REPAIR_FINGERPRINT_LIMIT } from '../convex/mailRepair';
import schema from '../convex/schema';
import { changedRepairMessages, repairFingerprint } from '../lib/mail/repair-fingerprint';

const SECRET = 'mail-repair-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const message = {
  providerMessageId: 'm1',
  providerThreadId: 't1',
  subject: 'Invoice',
  from: 'a@example.com',
  to: 'me@example.com',
  receivedAt: 1_700_000_000_000,
  snippet: 'Your invoice',
  labels: ['INBOX', 'UNREAD'],
  unread: true,
  starred: false,
  attachments: [{ id: 'x' }],
};

describe('repair fingerprint', () => {
  test('label order and duplicates, bodies, and headers do not change it', () => {
    const base = repairFingerprint(message);
    expect(repairFingerprint({ ...message, labels: ['UNREAD', 'INBOX', 'INBOX'] })).toBe(base);
    expect(repairFingerprint({ ...message, textBody: 'body', headers: { a: 1 } } as never)).toBe(base);
  });

  test('read, star, folder, and attachment changes change it', () => {
    const base = repairFingerprint(message);
    expect(repairFingerprint({ ...message, unread: false })).not.toBe(base);
    expect(repairFingerprint({ ...message, starred: true })).not.toBe(base);
    expect(repairFingerprint({ ...message, labels: ['TRASH'] })).not.toBe(base);
    expect(repairFingerprint({ ...message, attachments: [] })).not.toBe(base);
    expect(repairFingerprint({})).toBe(repairFingerprint({ labels: [], unread: false }));
  });

  test('changedRepairMessages keeps new and changed messages only', () => {
    const same = { ...message, providerMessageId: 'same' };
    const changed = { ...message, providerMessageId: 'changed', unread: false };
    const fresh = { ...message, providerMessageId: 'fresh' };
    const stored = {
      same: repairFingerprint(same),
      changed: repairFingerprint(message),
      fresh: null,
    };
    expect(changedRepairMessages([same, changed, fresh], stored).map((m) => m.providerMessageId)).toEqual([
      'changed',
      'fresh',
    ]);
  });
});

describe('mailRepair.messageFingerprints', () => {
  test('returns stored fingerprints for the user and null for missing or foreign rows', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/mailRepair.ts': () => import('../convex/mailRepair'),
    });
    await t.run(async (ctx) => {
      for (const [id, userId] of [
        ['m1', 'user_1'],
        ['m2', 'user_2'],
      ] as const)
        await ctx.db.insert('mailCorpusMessages', {
          ...message,
          providerMessageId: id,
          userId,
          accountId: 'acct_1',
          grantId: 'grant_1',
          provider: 'google',
          searchText: 'x',
          yearMonth: '2023-11',
          createdAt: 1,
          updatedAt: 1,
        });
    });
    const result = await t.query(api.mailRepair.messageFingerprints, {
      internalSecret: SECRET,
      userId: 'user_1',
      accountId: 'acct_1',
      providerMessageIds: ['m1', 'm2', 'm3', 'm1'],
    });
    expect(result).toEqual({
      m1: repairFingerprint({ ...message, providerMessageId: 'm1' }),
      m2: null,
      m3: null,
    });
    await expect(
      t.query(api.mailRepair.messageFingerprints, {
        internalSecret: SECRET,
        userId: 'user_1',
        accountId: 'acct_1',
        providerMessageIds: Array.from({ length: REPAIR_FINGERPRINT_LIMIT + 1 }, (_, i) => `m${i}`),
      }),
    ).rejects.toThrow('Too many message ids');
  });
});
