import { describe, expect, test } from 'bun:test';
import { classifyCorpusThread } from '../convex/smart';
import {
  classifyThreadWithContext,
  DEVOPS_LABEL_ID,
  includeInSmartCategory,
  smartIndexKey,
  smartRuleMatches,
} from '../lib/mail/smart-categories';
import { mailThreadSummaryFromCorpus } from '../lib/mobile/v1/mail-reads';
import type { SmartLabelDefinition, SmartRule } from '../lib/shared/types';
import { assessment } from './fixtures/jev';

// The production failure: the user moved Xcode Cloud mail to Dev/Ops, but Jev
// judged each build email as Main-worthy and the label move only added a tag.

const devOps: SmartLabelDefinition = {
  _id: DEVOPS_LABEL_ID,
  name: 'Dev/Ops',
  slug: 'dev-ops',
  description: 'Build and deploy mail',
  enabled: true,
  sidebarVisible: true,
  gmailLabelName: 'MailOS/Dev Ops',
  aiMode: 'metadata_snippet',
  positiveExamples: [],
  negativeExamples: [],
  createdBy: 'system',
  createdAt: 0,
  updatedAt: 0,
};

const rule = (over: Partial<SmartRule>): SmartRule => ({
  _id: 'rule-1',
  name: 'move to',
  enabled: true,
  scope: 'sender',
  match: 'noreply@apple.com',
  effect: 'always_custom_label',
  customLabelId: DEVOPS_LABEL_ID,
  source: 'quick_fix',
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

const xcodeRow = (overrides: Record<string, unknown> = {}) => ({
  providerThreadId: 'thread-xcode',
  subject: 'Fix editorial reading order — Build succeeded',
  fromAddress: 'Xcode Cloud <noreply@apple.com>',
  snippet: 'Latest commit on staging. Build, archive, and TestFlight passed.',
  labels: ['INBOX', 'UNREAD'],
  unread: true,
  latestMessageId: 'm1',
  // A current Jev verdict with an obligation lands in Main on its own.
  jev: assessment(),
  ...overrides,
});

describe('a label move files mail out of its category for good', () => {
  test('a Main verdict from Jev is filed under the label and keyed off Main', () => {
    const plain = classifyCorpusThread(xcodeRow(), { rules: [], customLabels: [devOps] });
    expect(plain.smartPrimary).toBe('main');

    const result = classifyCorpusThread(xcodeRow(), { rules: [rule({})], customLabels: [devOps] });
    expect(result.smartPrimary).toBe(`custom:${DEVOPS_LABEL_ID}`);
    expect(result.smartCategory.filedUnder).toBe(DEVOPS_LABEL_ID);
    expect(result.smartCategory.ruleHits).toContain('rule-1');

    const thread = { smartCategory: result.smartCategory } as any;
    expect(includeInSmartCategory(thread, 'main')).toBe(false);
    expect(includeInSmartCategory(thread, 'orders')).toBe(false);
    expect(includeInSmartCategory(thread, `custom:${DEVOPS_LABEL_ID}`)).toBe(true);
  });

  test('a Main verdict from the lightweight model is filed too', () => {
    const result = classifyCorpusThread(
      xcodeRow({
        jev: undefined,
        llmClassifiedMessageId: 'm1',
        llmCategory: { primary: 'main', secondary: [], confidence: 0.9, needsAttention: true, signals: [] },
      }),
      { rules: [rule({})], customLabels: [devOps] },
    );
    expect(result.smartPrimary).toBe(`custom:${DEVOPS_LABEL_ID}`);
  });

  test('a disabled or missing label never hides mail', () => {
    for (const customLabels of [[{ ...devOps, enabled: false }], []]) {
      const result = classifyCorpusThread(xcodeRow(), { rules: [rule({})], customLabels });
      expect(result.smartPrimary).toBe('main');
      expect(result.smartCategory.filedUnder).toBeUndefined();
    }
  });

  test('a newer move to a disabled label does not block an older valid move', () => {
    const verdict = classifyThreadWithContext(xcodeRow() as any, {
      rules: [
        rule({ createdAt: 100 }),
        rule({ _id: 'rule-dead', customLabelId: 'label-gone', createdAt: 200 }),
      ],
      customLabels: [devOps, { ...devOps, _id: 'label-gone', enabled: false }],
    });
    expect(verdict.filedUnder).toBe(DEVOPS_LABEL_ID);
    expect(verdict.ruleHits).toContain('rule-1');
  });

  test('a newer never_custom_label rule for the same label unfiles the mail', () => {
    const result = classifyCorpusThread(xcodeRow(), {
      rules: [rule({}), rule({ _id: 'rule-2', effect: 'never_custom_label', createdAt: 200 })],
      customLabels: [devOps],
    });
    expect(result.smartCategory.filedUnder).toBeUndefined();
    expect(result.smartPrimary).toBe('main');
  });

  test('the mobile summary reports filed mail as its label', () => {
    const { smartCategory } = classifyCorpusThread(xcodeRow(), {
      rules: [rule({})],
      customLabels: [devOps],
    });
    const summary = mailThreadSummaryFromCorpus({
      _id: 'thread-xcode',
      account: 'account-a',
      subject: 'Build succeeded',
      fromAddress: 'Xcode Cloud <noreply@apple.com>',
      lastDate: 1,
      smartCategory,
    });
    expect(summary.smartCategory).toBe(`custom:${DEVOPS_LABEL_ID}`);
    expect(
      mailThreadSummaryFromCorpus({ _id: 't', account: 'a', smartCategory: { primary: 'orders' } })
        .smartCategory,
    ).toBe('orders');
  });

  test('the mobile summary carries secondary categories and label ids', () => {
    const summary = mailThreadSummaryFromCorpus({
      _id: 't',
      account: 'a',
      smartCategory: { primary: 'main', secondary: ['orders', 7, ''], customLabels: [DEVOPS_LABEL_ID] },
    });
    expect(summary.smartSecondary).toEqual(['orders']);
    expect(summary.smartLabels).toEqual([DEVOPS_LABEL_ID]);
    const bare = mailThreadSummaryFromCorpus({ _id: 't', account: 'a', smartCategory: { primary: 'main' } });
    expect(bare.smartSecondary).toBeUndefined();
    expect(bare.smartLabels).toBeUndefined();
  });
});

describe('never_main holds over model verdicts', () => {
  test('a Jev Main verdict leaves Main when the sender has a Never Main rule', () => {
    const result = classifyCorpusThread(
      xcodeRow({ fromAddress: 'Jack <jack@banjoskills.com>', subject: 'Checking in' }),
      { rules: [rule({ match: 'jack@banjoskills.com', effect: 'never_main', customLabelId: undefined })] },
    );
    expect(result.smartPrimary).not.toBe('main');
    expect(result.smartCategory.needsAttention).toBe(false);
    expect(result.smartCategory.signals).toContain('user_rule');
  });

  test('a deterministic Main verdict for a person also leaves Main', () => {
    const verdict = classifyThreadWithContext(
      { fromAddress: 'Jack <jack@banjoskills.com>', subject: 'Re: lunch', labels: [], unread: false } as any,
      { rules: [rule({ match: 'jack@banjoskills.com', effect: 'never_main', customLabelId: undefined })] },
    );
    expect(verdict.primary).not.toBe('main');
  });
});

describe('the newest placement rule wins', () => {
  const orders = rule({ _id: 'rule-orders', effect: 'always_category', category: 'orders', createdAt: 50 });

  test('a label move made after a category move files the mail', () => {
    const verdict = classifyThreadWithContext(xcodeRow() as any, {
      rules: [orders, rule({ createdAt: 100 })],
      customLabels: [devOps],
    });
    expect(verdict.filedUnder).toBe(DEVOPS_LABEL_ID);
  });

  test('a category move made after a label move wins back the mail', () => {
    const verdict = classifyThreadWithContext(xcodeRow() as any, {
      rules: [{ ...orders, createdAt: 200 }, rule({ createdAt: 100 })],
      customLabels: [devOps],
    });
    expect(verdict.primary).toBe('orders');
    expect(verdict.model).toBe('user_rule');
    expect(verdict.filedUnder).toBeUndefined();
  });

  test('a later Move to Main overrides an earlier Always Noise', () => {
    const verdict = classifyThreadWithContext(xcodeRow() as any, {
      rules: [
        rule({ _id: 'noise', effect: 'always_noise', customLabelId: undefined, createdAt: 10 }),
        rule({
          _id: 'main',
          effect: 'always_category',
          category: 'main',
          customLabelId: undefined,
          createdAt: 20,
        }),
      ],
    });
    expect(verdict.primary).toBe('main');
    expect(smartIndexKey(verdict)).toBe('main');
  });
});

describe('smartRuleMatches', () => {
  test('uses the classifier matcher, including subdomains for domain rules', () => {
    const row = { fromAddress: 'App Store Connect <no_reply@email.apple.com>', subject: 'Build ready' };
    expect(smartRuleMatches({ enabled: true, scope: 'domain', match: 'apple.com' }, row)).toBe(true);
    expect(smartRuleMatches({ enabled: true, scope: 'sender', match: 'no_reply@email.apple.com' }, row)).toBe(
      true,
    );
    expect(smartRuleMatches({ enabled: true, scope: 'sender', match: 'noreply@apple.com' }, row)).toBe(false);
    expect(smartRuleMatches({ enabled: false, scope: 'domain', match: 'apple.com' }, row)).toBe(false);
  });
});

describe('baseline classifier branches', () => {
  test('trash and spam labels are noise', () => {
    const verdict = classifyThreadWithContext({
      fromAddress: 'Alex <alex@example.test>',
      subject: 'hello',
      labels: ['TRASH'],
    } as any);
    expect(verdict.primary).toBe('noise');
    expect(verdict.reason).toBe('Trash or spam label.');
  });

  test('LinkedIn mail is platform noise', () => {
    const verdict = classifyThreadWithContext({
      fromAddress: 'LinkedIn <messages@linkedin.com>',
      subject: 'You appeared in 4 searches',
      labels: [],
    } as any);
    expect(verdict.primary).toBe('noise');
    expect(verdict.signals).toContain('platform_noise');
  });

  test('an urgent triage verdict from a person lands in Main', () => {
    const verdict = classifyThreadWithContext({
      fromAddress: 'Alex <alex@example.test>',
      subject: 'Quick question',
      labels: [],
      unread: false,
      triage: { priority: 1, action: 'wait', reason: 'waiting on Alex' },
    } as any);
    expect(verdict.primary).toBe('main');
    expect(verdict.suggestedAction).toBe('wait');
    expect(verdict.signals).toContain('triage_attention');
  });

  test('unclear mail is Review when unread and Noise when read', () => {
    const unclear = { fromAddress: 'Help <support@vendor.test>', subject: 'Following up', labels: [] };
    const unread = classifyThreadWithContext({ ...unclear, unread: true } as any);
    expect(unread.primary).toBe('review');
    expect(unread.needsAttention).toBe(true);
    const read = classifyThreadWithContext({ ...unclear, unread: false } as any);
    expect(read.primary).toBe('noise');
    expect(read.signals).toContain('uncertain');
  });
});
