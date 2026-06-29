import { describe, expect, test } from 'bun:test';
import {
  bodyExcerpt,
  bulkSignals,
  classifyThreadDeterministic,
  classifyThreadWithContext,
  includeInSmartCategory,
  isBulkLike,
  isCodeLike,
  isFinanceAdminLike,
  isHumanLike,
  isNewsletterLike,
  isNoReplyLike,
  isOrderLike,
  isStrongCodeLike,
  labelsForSmartCategory,
  SMART_CATEGORY_IDS,
} from '../lib/mail/smart-categories';
import type { SmartRule } from '../lib/shared/types';

const isValidCategory = (c: unknown) => (SMART_CATEGORY_IDS as readonly string[]).includes(c as string);

describe('smart-category predicates', () => {
  test('isNoReplyLike flags automated senders only', () => {
    expect(isNoReplyLike('no-reply@example.test')).toBe(true);
    expect(isNoReplyLike('notifications@example.test')).toBe(true);
    expect(isNoReplyLike('alex@example.test')).toBe(false);
    expect(isNoReplyLike(null)).toBe(false);
  });

  test('isCodeLike is loose; isStrongCodeLike is strict', () => {
    expect(isCodeLike('Your verification code is 123456')).toBe(true);
    expect(isCodeLike('please sign in to continue')).toBe(true);
    expect(isStrongCodeLike('please sign in to continue')).toBe(false);
    expect(isStrongCodeLike('Your one-time passcode is 9999')).toBe(true);
  });

  test('order / finance / newsletter predicates', () => {
    expect(isOrderLike('Your order has shipped — tracking inside')).toBe(true);
    expect(isFinanceAdminLike('Your invoice is past due')).toBe(true);
    expect(isNewsletterLike('Weekly digest — unsubscribe anytime')).toBe(true);
    expect(isOrderLike('lunch tomorrow?')).toBe(false);
  });

  test('bulk detection via list signals', () => {
    const thread = { subject: 'Sale', snippet: 'Unsubscribe at any time', from: 'deals@shop.test' } as any;
    expect(bulkSignals(thread)).toContain('unsubscribe');
    expect(isBulkLike(thread)).toBe(true);
    expect(isBulkLike({ subject: 'Re: lunch', from: 'alex@example.test' } as any)).toBe(false);
  });

  test('isHumanLike needs a real address and rejects no-reply', () => {
    expect(isHumanLike({ from: 'Alex <alex@example.test>', subject: 'Re: lunch' } as any)).toBe(true);
    expect(isHumanLike({ from: 'no-reply@example.test' } as any)).toBe(false);
    expect(isHumanLike({ from: '' } as any)).toBe(false);
  });

  test('bodyExcerpt always returns a string', () => {
    expect(bodyExcerpt({ bodyText: '  hello   world  ' })).toContain('hello world');
    expect(typeof bodyExcerpt({})).toBe('string');
  });
});

describe('classifyThreadDeterministic routes diverse mail', () => {
  // Each case asserts the EXPECTED routing, so a regression that collapses
  // everything into one bucket fails here.
  const cases: Array<{ name: string; expected: string; t: any }> = [
    {
      name: 'verification code',
      expected: 'codes',
      t: {
        fromAddress: 'security@bank.test',
        subject: 'Your verification code',
        bodyText: 'Your one-time passcode is 123456',
        labels: [],
      },
    },
    {
      name: 'order',
      expected: 'orders',
      t: {
        fromAddress: 'ship@shop.test',
        subject: 'Your order shipped',
        bodyText: 'Tracking 1Z999',
        labels: [],
      },
    },
    {
      name: 'invoice',
      expected: 'finance_admin',
      t: {
        fromAddress: 'billing@vendor.test',
        subject: 'Invoice #42 past due',
        bodyText: 'Payment failed',
        labels: [],
      },
    },
    {
      name: 'newsletter',
      expected: 'noise',
      t: {
        fromAddress: 'news@list.test',
        subject: 'Weekly digest',
        bodyText: 'unsubscribe here',
        labels: [],
      },
    },
  ];

  for (const c of cases) {
    test(`${c.name} → ${c.expected}`, () => {
      const verdict = classifyThreadDeterministic(c.t);
      expect(verdict.primary).toBe(c.expected);
      expect(Array.isArray(verdict.secondary)).toBe(true);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0);
      expect(verdict.confidence).toBeLessThanOrEqual(1);
      expect(typeof verdict.reason).toBe('string');
    });
  }

  test('a human, personal, unread thread lands in main or needs_reply', () => {
    const verdict = classifyThreadDeterministic({
      fromAddress: 'Alex <alex@example.test>',
      subject: 'Re: can we meet?',
      bodyText: 'Are you free at 2pm?',
      labels: ['CATEGORY_PERSONAL', 'UNREAD'],
      unread: true,
    } as any);
    expect(['main', 'needs_reply']).toContain(verdict.primary);
  });
});

describe('classifyThreadWithContext honors user rules', () => {
  const rule = (over: Partial<SmartRule>): SmartRule => ({
    _id: 'r1',
    name: 'rule',
    enabled: true,
    scope: 'sender',
    match: 'alex@example.test',
    effect: 'always_noise',
    source: 'settings',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  test('always_noise forces noise via the user rule', () => {
    const verdict = classifyThreadWithContext(
      { fromAddress: 'alex@example.test', subject: 'hi', labels: [], unread: true } as any,
      { rules: [rule({ effect: 'always_noise', reason: 'muted' })] },
    );
    expect(verdict.primary).toBe('noise');
    expect(verdict.model).toBe('user_rule');
  });

  test('always_category pins the requested category', () => {
    const verdict = classifyThreadWithContext(
      { fromAddress: 'alex@example.test', subject: 'hi', labels: [], unread: true } as any,
      { rules: [rule({ effect: 'always_category', category: 'finance_admin' })] },
    );
    expect(verdict.primary).toBe('finance_admin');
  });

  test('a never_main rule is evaluated and yields a valid verdict', () => {
    const verdict = classifyThreadWithContext(
      { fromAddress: 'alex@example.test', subject: 'promo offer', labels: [] } as any,
      { rules: [rule({ effect: 'never_main' })] },
    );
    expect(isValidCategory(verdict.primary)).toBe(true);
    expect(typeof verdict.reason).toBe('string');
  });

  test('a disabled rule is ignored', () => {
    const verdict = classifyThreadWithContext(
      { fromAddress: 'alex@example.test', subject: 'hi', labels: [], unread: true } as any,
      { rules: [rule({ enabled: false, effect: 'always_noise' })] },
    );
    expect(verdict.model).not.toBe('user_rule');
  });

  test('a domain-scoped rule matches the sender domain', () => {
    const verdict = classifyThreadWithContext(
      { fromAddress: 'someone@spam.test', subject: 'promo', labels: [] } as any,
      { rules: [rule({ scope: 'domain', match: 'spam.test', effect: 'always_noise' })] },
    );
    expect(verdict.primary).toBe('noise');
  });
});

describe('smart-category helpers', () => {
  test('includeInSmartCategory matches the verdict primary', () => {
    const thread = {
      fromAddress: 'Alex <alex@example.test>',
      subject: 'Re: lunch',
      labels: ['CATEGORY_PERSONAL'],
      unread: true,
    } as any;
    const verdict = classifyThreadDeterministic(thread);
    expect(includeInSmartCategory({ ...thread, smartCategory: verdict }, verdict.primary)).toBe(true);
  });

  test('labelsForSmartCategory maps a verdict to gmail labels', () => {
    const verdict = classifyThreadDeterministic({
      fromAddress: 'billing@vendor.test',
      subject: 'Invoice past due',
      bodyText: 'payment failed',
      labels: [],
    } as any);
    const labels = labelsForSmartCategory(verdict);
    expect(Array.isArray(labels)).toBe(true);
    expect(labels.length).toBeGreaterThan(0);
  });

  test('labelsForSmartCategory returns [] for a null verdict', () => {
    expect(labelsForSmartCategory(null)).toEqual([]);
  });
});
