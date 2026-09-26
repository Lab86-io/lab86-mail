import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { railSmartLabels } from '../components/inbox/MailNav';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  classifierContent,
  classifyCorpusThread,
  computeCategoryUnreadCounts,
  RECLASSIFY_STALE_MS,
  requestSmartReclassify,
} from '../convex/smart';
import { assessmentFromResponse, smartCategoryFromJev } from '../lib/jev/mail';
import {
  classifyThreadWithContext,
  clipClassifierBody,
  currentGmailLabelName,
  DEVOPS_LABEL_ID,
  includeInSmartCategory,
  isHeaderCodeLike,
  isHumanLike,
  labelsForSmartCategory,
  labelTerms,
  SMART_CLASSIFIER_VERSION,
} from '../lib/mail/smart-categories';
import type { SmartLabelDefinition, SmartRule } from '../lib/shared/types';
import { assessment, mailInput, NOW, responseFor, thread } from './fixtures/jev';

// A realistic long marketing mail: real content first, a long product grid,
// and the unsubscribe footer far past the first 4000 characters.
const PRODUCT_GRID = Array.from(
  { length: 60 },
  (_, i) =>
    `Item ${i + 1}: Linen shirt in sand, relaxed fit, machine washable. Now $${40 + i}. Free shipping on this style.`,
).join('\n');
const LONG_PROMO_BODY = `Hi there,\n\nOur autumn collection is here. Pick your favourites before they sell out.\n\n${PRODUCT_GRID}\n\nYou receive this email because you signed up at shop.example.test.\nUnsubscribe | Manage preferences | View in browser\n© 2026 Example Shop, 1 Market St.`;

const label = (over: Partial<SmartLabelDefinition>): SmartLabelDefinition => ({
  _id: 'label-1',
  name: 'Label',
  slug: 'label',
  description: '',
  enabled: true,
  sidebarVisible: true,
  gmailLabelName: 'Albatross/Label',
  aiMode: 'metadata_snippet',
  positiveExamples: [],
  negativeExamples: [],
  createdBy: 'user',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const rule = (over: Partial<SmartRule>): SmartRule => ({
  _id: 'rule-1',
  name: 'rule',
  enabled: true,
  scope: 'sender',
  match: 'friend@example.test',
  effect: 'always_category',
  source: 'quick_fix',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('CLS-1 long mail keeps its Jev category', () => {
  const local = classifyThreadWithContext(thread(), {});
  const quiet = {
    obligations: [],
    meaningfulChange: false,
    probabilities: { reply: 0.02, action: 0.02, waiting: 0.02, change: 0.02 },
  };

  test('a stored verdict made uncertain only by a long body goes to its real place', () => {
    // Before the fix, every body over 2400 characters set contextComplete=false.
    const stored = { ...quiet, status: 'uncertain' as const, contextComplete: false };
    expect(smartCategoryFromJev(assessment({ ...stored, purpose: 'promotion' }), local, true)).toMatchObject({
      primary: 'noise',
      needsAttention: false,
    });
    expect(smartCategoryFromJev(assessment({ ...stored, purpose: 'newsletter' }), local, true).primary).toBe(
      'noise',
    );
    expect(smartCategoryFromJev(assessment({ ...stored, subjectKind: 'code' }), local, true).primary).toBe(
      'codes',
    );
    expect(
      smartCategoryFromJev(assessment({ ...stored, purpose: 'conversation' }), local, true),
    ).toMatchObject({
      primary: 'main',
      needsAttention: false,
    });
  });

  test('a clear promotion goes to Noise even when an obligation answer is unclear', () => {
    const unclear = assessment({
      ...quiet,
      status: 'uncertain',
      purpose: 'promotion',
      probabilities: { reply: 0.5, action: 0.02, waiting: 0.02, change: 0.02 },
    });
    expect(smartCategoryFromJev(unclear, local, true).primary).toBe('noise');
  });

  test('a really unclear verdict still goes to Review and asks for attention', () => {
    const unclear = assessment({
      ...quiet,
      status: 'uncertain',
      contextComplete: false,
      probabilities: { reply: 0.5, action: 0.02, waiting: 0.02, change: 0.02 },
    });
    expect(smartCategoryFromJev(unclear, local, true)).toMatchObject({
      primary: 'review',
      needsAttention: true,
    });
    const unknown = assessment({ ...quiet, status: 'uncertain', purpose: 'unknown', confidence: 0.4 });
    expect(smartCategoryFromJev(unknown, local, true).primary).toBe('review');
  });

  test('a fresh Jev pass over a long promotion with a full window is accepted and filed in Noise', () => {
    const input = mailInput(LONG_PROMO_BODY.slice(0, 2400));
    const result = assessmentFromResponse(
      input,
      responseFor(input, { purpose: 'promotion', reply: 0.01, reply_evidence: 'none' }),
      NOW,
    );
    expect(result.status).toBe('accepted');
    expect(smartCategoryFromJev(result, local, true).primary).toBe('noise');
  });
});

describe('CLS-8 routine transactions leave Main', () => {
  const local = classifyThreadWithContext(thread(), {});
  const quiet = { obligations: [], meaningfulChange: false, purpose: 'transaction' as const };
  test('account and general updates with nothing to do go to Noise', () => {
    for (const subjectKind of ['account', 'general'] as const) {
      const verdict = smartCategoryFromJev(assessment({ ...quiet, subjectKind }), local, true);
      expect(verdict.primary).toBe('noise');
      expect(verdict.reason).toContain('routine');
    }
  });
  test('a transaction with a change or an action stays in Main', () => {
    expect(
      smartCategoryFromJev(
        assessment({ ...quiet, subjectKind: 'account', meaningfulChange: true }),
        local,
        true,
      ).primary,
    ).toBe('main');
    expect(smartCategoryFromJev(assessment({ ...quiet, subjectKind: 'order' }), local, true).primary).toBe(
      'orders',
    );
  });
});

describe('CLS-3 the rule-based classifier reads Gmail tabs, the footer, and list headers', () => {
  test('Promotions and Updates mail is not a person unless Gmail also calls it personal', () => {
    const base = { fromAddress: 'Dana Lee <dana@shop.example.test>', subject: 'Quick note', unread: true };
    for (const tab of ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'])
      expect(isHumanLike({ ...base, labels: ['INBOX', tab] })).toBe(false);
    expect(isHumanLike({ ...base, labels: ['INBOX', 'CATEGORY_UPDATES', 'CATEGORY_PERSONAL'] })).toBe(true);
    expect(isHumanLike({ ...base, labels: ['INBOX'] })).toBe(true);
  });

  test('a long promotion with the unsubscribe footer at the end is Noise, not a person in Main', () => {
    expect(LONG_PROMO_BODY.length).toBeGreaterThan(4500);
    const promo = {
      fromAddress: 'Example Shop <hello.dana@shop.example.test>',
      subject: 'Autumn is here',
      snippet: 'Our autumn collection is here.',
      labels: ['INBOX'],
      unread: true,
      bodyText: LONG_PROMO_BODY,
    };
    expect(clipClassifierBody(LONG_PROMO_BODY)).toContain('Unsubscribe');
    const verdict = classifyThreadWithContext(promo, {});
    expect(verdict.primary).toBe('noise');
    expect(verdict.bulkSignals).toContain('unsubscribe');
  });

  test('list headers from the latest message reach the classifier', () => {
    const row = {
      providerThreadId: 'list-thread',
      subject: 'Weekly notes',
      fromAddress: 'Club <club@groups.example.test>',
      snippet: 'Hello members',
      labels: ['INBOX'],
      unread: true,
    };
    const content = classifierContent({
      textBody: 'Hello members, see you soon.',
      headers: { 'List-Id': '<club.groups.example.test>', 'list-unsubscribe': '<mailto:leave@example.test>' },
    });
    expect(content.listId).toBe('<club.groups.example.test>');
    const withHeaders = classifyCorpusThread(row, {}, content);
    expect(withHeaders.smartCategory.isHumanLike).toBe(false);
    expect(withHeaders.smartCategory.bulkSignals).toEqual(
      expect.arrayContaining(['bulk_or_list', 'unsubscribe']),
    );
    expect(withHeaders.smartPrimary).toBe('noise');
    expect(classifyCorpusThread(row, {}, content.bodyText).smartPrimary).toBe('main');
  });
});

describe('CLS-4 keyword order', () => {
  const unread = { labels: ['INBOX'], unread: true };
  test('a promo code is not a sign-in code', () => {
    expect(isHeaderCodeLike('extra 30% off with code save30')).toBe(false);
    expect(isHeaderCodeLike('your promo code for the sale')).toBe(false);
    expect(isHeaderCodeLike('your verification code is 123456')).toBe(true);
    expect(isHeaderCodeLike('sign in to your account')).toBe(true);
    const promo = classifyThreadWithContext(
      {
        ...unread,
        labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
        fromAddress: 'Shop <deals@shop.example.test>',
        subject: 'Extra 30% off with code SAVE30',
        snippet: 'This weekend only.',
      },
      {},
    );
    expect(promo.primary).toBe('noise');
    expect(promo.signals).not.toContain('code_or_security');
  });

  test('a returns footer does not make a shipping notice an order problem', () => {
    const shipped = classifyThreadWithContext(
      {
        ...unread,
        fromAddress: 'Shop <orders@shop.example.test>',
        subject: 'Your order has shipped',
        snippet: 'Tracking number inside.',
        bodyText:
          'Your order is on the way. Need to return an item? Start a return or refund here. Problem? Contact us.',
      },
      {},
    );
    expect(shipped.primary).toBe('orders');
    expect(shipped.reason).not.toContain('problem');
  });

  test('an ordinary bill is not urgent', () => {
    const bill = classifyThreadWithContext(
      {
        ...unread,
        fromAddress: 'Power Co <billing@power.example.test>',
        subject: 'Amount due $54',
        snippet: 'Your statement is ready.',
      },
      {},
    );
    expect(bill.primary).toBe('finance_admin');
  });

  test('a person with a LinkedIn link, a person named Betsy, and a Support display name are people', () => {
    const linkedIn = classifyThreadWithContext(
      {
        ...unread,
        fromAddress: 'Sam Park <sam@startup.example.test>',
        subject: 'Coffee next week?',
        snippet: 'Are you free Tuesday?',
        bodyText: 'Are you free Tuesday? Sam — linkedin.com/in/sampark',
      },
      {},
    );
    expect(linkedIn.primary).toBe('main');
    expect(isHumanLike({ fromAddress: 'Betsy Ross <betsy.ross@example.test>', labels: [] })).toBe(true);
    expect(isHumanLike({ fromAddress: 'Support Team Lead <maria@example.test>', labels: [] })).toBe(true);
    expect(isHumanLike({ fromAddress: 'Etsy <transaction@etsy.com>', labels: [] })).toBe(false);
    expect(isHumanLike({ fromAddress: 'Help <support@vendor.example.test>', labels: [] })).toBe(false);
    const fromLinkedIn = classifyThreadWithContext(
      { ...unread, fromAddress: 'LinkedIn <messages-noreply@linkedin.com>', subject: 'New message' },
      {},
    );
    expect(fromLinkedIn.signals).toContain('platform_noise');
  });
});

describe('CLS-5 a move to Needs Reply keeps the mail visible', () => {
  test('the rule files the mail in Main with a needs_reply secondary', () => {
    const mail = thread({ fromAddress: 'friend@example.test', labels: ['INBOX'], unread: false });
    const verdict = classifyThreadWithContext(mail, {
      rules: [rule({ effect: 'always_category', category: 'needs_reply' })],
    });
    expect(verdict).toMatchObject({ primary: 'main', secondary: ['needs_reply'], model: 'user_rule' });
    expect(verdict.suggestedAction).toBe('reply');
    expect(includeInSmartCategory({ ...mail, smartCategory: verdict }, 'main')).toBe(true);
    const moved = classifyCorpusThread(
      {
        providerThreadId: 't',
        subject: 'Hi',
        fromAddress: 'friend@example.test',
        latestMessageId: 'm1',
        jev: assessment({ obligations: [] }),
      },
      { rules: [rule({ effect: 'always_category', category: 'needs_reply' })] },
    );
    expect(moved.smartPrimary).toBe('main');
  });
});

describe('CLS-6 and CLS-7 custom labels match whole words', () => {
  const words = (text: string) => ({ fromAddress: 'a@example.test', subject: text, labels: [] });
  test('short names do not match inside other words, and the description is not matched', () => {
    const hr = label({ _id: 'hr', name: 'HR', description: 'Human resources mail' });
    const car = label({ _id: 'car', name: 'Car' });
    const ctx = { customLabels: [hr, car] };
    expect(
      classifyThreadWithContext(words('see https://example.test for your card'), ctx).customLabels,
    ).toEqual([]);
    expect(classifyThreadWithContext(words('HR update: car park moves'), ctx).customLabels).toEqual([
      'hr',
      'car',
    ]);
    expect(classifyThreadWithContext(words('Human resources mail'), ctx).customLabels).toEqual([]);
  });

  test('the default example from "Create label from this" matches that sender and subject', () => {
    const fromThis = label({
      _id: 'club',
      name: 'Book club notes',
      positiveExamples: ['Maya <maya@club.example.test>: Chapter 4 discussion'],
    });
    const hit = classifyThreadWithContext(
      { fromAddress: 'Maya <maya@club.example.test>', subject: 'Re: Chapter 4 discussion', labels: [] },
      { customLabels: [fromThis] },
    );
    expect(hit.customLabels).toEqual(['club']);
    expect(labelTerms('The HR, and the Car!')).toEqual(['hr', 'car']);
  });

  test('negative examples win, and a generic body word is not Dev/Ops', () => {
    const devOps = label({
      _id: DEVOPS_LABEL_ID,
      name: 'Dev/Ops',
      positiveExamples: ['deploy failed'],
      negativeExamples: ['railway newsletter'],
    });
    const ctx = { customLabels: [devOps] };
    const shop = classifyThreadWithContext(
      {
        fromAddress: 'Shop <news@shop.example.test>',
        subject: 'New arrivals',
        labels: [],
        bodyText: 'Read our docs. Build your look. Our api for partners. Report an issue.',
      },
      ctx,
    );
    expect(shop.customLabels).toEqual([]);
    const github = classifyThreadWithContext(
      { fromAddress: 'GitHub <notifications@github.com>', subject: '[repo] New issue', labels: [] },
      ctx,
    );
    expect(github.customLabels).toEqual([DEVOPS_LABEL_ID]);
    const muted = classifyThreadWithContext(
      { fromAddress: 'Railway <team@railway.app>', subject: 'Railway newsletter: September', labels: [] },
      ctx,
    );
    expect(muted.customLabels).toEqual([]);
    const example = classifyThreadWithContext(
      { fromAddress: 'CI <ci@example.test>', subject: 'Deploy failed on main', labels: [] },
      ctx,
    );
    expect(example.customLabels).toEqual([DEVOPS_LABEL_ID]);
  });
});

describe('CLS-15 and CLS-16 names', () => {
  test('filed mail gets no primary Gmail label, and old label names use the new prefix', () => {
    const verdict = classifyThreadWithContext(thread(), {});
    expect(labelsForSmartCategory({ ...verdict, primary: 'main', secondary: [] })).toEqual([
      'Albatross/Main',
    ]);
    const filed = labelsForSmartCategory(
      { ...verdict, primary: 'main', secondary: [], customLabels: ['x'], filedUnder: 'x' },
      [label({ _id: 'x', gmailLabelName: 'MailOS/Receipts' })],
    );
    expect(filed).toEqual(['Albatross/Receipts']);
    expect(currentGmailLabelName('Other/Name')).toBe('Other/Name');
  });

  test('the triage reason does not say AI', () => {
    const verdict = classifyThreadWithContext(
      thread({
        fromAddress: 'Maya <maya@university.test>',
        labels: ['INBOX'],
        unread: true,
        triage: { priority: 1, action: 'reply', reason: 'She asked a question.' } as any,
      }),
      {},
    );
    expect(verdict.reason).toBe('Triage marked this to reply: She asked a question.');
    expect(verdict.reason).not.toMatch(/\bAI\b/);
  });
});

describe('CLS-10 rail labels', () => {
  test('the rail shows enabled, visible labels; the dialog gets every label', () => {
    const labels = [
      { _id: 'a', enabled: true, sidebarVisible: true },
      { _id: 'b', enabled: false, sidebarVisible: true },
      { _id: 'c', enabled: true, sidebarVisible: false },
    ];
    expect(railSmartLabels(labels).map((item) => item._id)).toEqual(['a']);
  });
});

// Convex runtime: badge, resort job, classifier version, and Jev writes.
const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/smart.ts': () => import('../convex/smart'),
  '../convex/userData.ts': () => import('../convex/userData'),
  '../convex/jev.ts': () => import('../convex/jev'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};
const SECRET = 'classification-audit-secret';
const USER = 'cls_user';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;
let seq = 0;
async function seedRow(t: Harness, over: Record<string, unknown> = {}) {
  seq += 1;
  return t.run((ctx) =>
    ctx.db.insert('mailCorpusThreads', {
      userId: USER,
      accountId: 'acct',
      grantId: 'grant',
      provider: 'google' as const,
      providerThreadId: `row_${seq}`,
      subject: 'Hello',
      fromAddress: 'Alice <alice@example.test>',
      lastDate: NOW + seq,
      snippet: 'Hi',
      labels: ['INBOX'],
      unread: true,
      yearMonth: '2026-09',
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    }),
  );
}
const scheduled = (t: Harness) =>
  t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()) as Promise<any[]>;

describe('CLS-2 the Needs reply badge counts what the list shows', () => {
  test('counts unread current Jev reply obligations only', async () => {
    const t = harness();
    // Rule-based needs_reply secondary with no Jev obligation: not counted.
    await seedRow(t, {
      smartPrimary: 'main',
      smartCategory: { primary: 'main', secondary: ['needs_reply'], needsAttention: true },
    });
    await seedRow(t, { latestMessageId: 'm1', jev: assessment(), jevNeedsReply: true });
    await seedRow(t, { latestMessageId: 'm1', jev: assessment(), jevNeedsReply: true, unread: false });
    await seedRow(t, { latestMessageId: 'm1', jev: assessment(), jevNeedsReply: true, labels: ['TRASH'] });
    await seedRow(t, { latestMessageId: 'm2', jev: assessment(), jevNeedsReply: true });
    await seedRow(t, {
      latestMessageId: 'm1',
      jev: assessment(),
      jevNeedsReply: true,
      smartCategory: { primary: 'noise', model: 'user_rule' },
    });
    await seedRow(t, { latestMessageId: 'm1', jev: assessment(), jevNeedsReply: true, accountId: 'other' });
    const counts = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER));
    expect(counts.needs_reply).toEqual({ unread: 2, attention: true });
    const scoped = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER, ['acct']));
    expect(scoped.needs_reply).toEqual({ unread: 1, attention: true });
    const list = await t.run((ctx) =>
      (ctx as any).db
        .query('mailCorpusThreads')
        .withIndex('by_user_jev_reply', (q: any) => q.eq('userId', USER).eq('jevNeedsReply', true))
        .collect(),
    );
    expect(list.length).toBe(6);
  });
});

describe('CLS-11 one resort chain for each user, and version-driven convergence', () => {
  test('quick rule edits start one chain; later edits only raise the generation', async () => {
    const t = harness();
    for (let i = 0; i < 4; i++)
      await t.mutation(api.userData.upsertDoc, {
        internalSecret: SECRET,
        userId: USER,
        kind: 'smartRule',
        key: `rule_${i}`,
        doc: {
          _id: `rule_${i}`,
          enabled: true,
          scope: 'sender',
          match: 'x@example.test',
          effect: 'always_noise',
        },
      });
    const jobs = (await scheduled(t)).filter((job) => job.name.includes('reclassifyUserThreads'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toMatchObject({ userId: USER, chain: 1, generation: 1 });
    const job = await t.run((ctx) =>
      ctx.db
        .query('userDocs')
        .withIndex('by_user_kind_key', (q) =>
          q.eq('userId', USER).eq('kind', 'smartReclassifyJob').eq('key', 'default'),
        )
        .unique(),
    );
    expect(job?.doc).toMatchObject({ generation: 4, chain: 1, running: true });
  });

  test('a chain restarts with new rules, stops when superseded, and closes the job', async () => {
    const t = harness();
    await seedRow(t);
    await seedRow(t);
    await t.run((ctx) => requestSmartReclassify(ctx, USER, 0));
    await t.run((ctx) => requestSmartReclassify(ctx, USER, 0));
    // Chain 1 started with generation 1; the rules are now at generation 2.
    const first = await t.mutation(internal.smart.reclassifyUserThreads, {
      userId: USER,
      chain: 1,
      generation: 1,
      cursor: 'stale-cursor-is-dropped',
    });
    expect(first).toEqual({ reclassified: 2, done: true });
    const job = await t.run((ctx) =>
      ctx.db
        .query('userDocs')
        .withIndex('by_user_kind_key', (q) =>
          q.eq('userId', USER).eq('kind', 'smartReclassifyJob').eq('key', 'default'),
        )
        .unique(),
    );
    expect(job?.doc).toMatchObject({ generation: 2, running: false });
    // The next edit starts a new chain; the old chain id is now superseded.
    const next = await t.run((ctx) => requestSmartReclassify(ctx, USER, 0));
    expect(next).toEqual({ scheduled: true, generation: 3 });
    expect(
      await t.mutation(internal.smart.reclassifyUserThreads, { userId: USER, chain: 1, generation: 2 }),
    ).toEqual({ reclassified: 0, done: true, superseded: true });
    // A manual run with no chain still works.
    expect(await t.mutation(internal.smart.reclassifyUserThreads, { userId: USER })).toEqual({
      reclassified: 2,
      done: true,
    });
  });

  test('a chain with no heartbeat for the stale period is replaced by the next edit', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'smartReclassifyJob',
        key: 'default',
        doc: { generation: 5, chain: 5, running: true, heartbeatAt: Date.now() - RECLASSIFY_STALE_MS - 1 },
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    expect(await t.run((ctx) => requestSmartReclassify(ctx, USER))).toEqual({
      scheduled: true,
      generation: 6,
    });
  });

  test('the backlog cron sorts rows with no version or an older version, then stops', async () => {
    const t = harness();
    const none = await seedRow(t, { smartPrimary: 'review', smartCategory: { primary: 'review' } });
    const old = await seedRow(t, {
      smartPrimary: 'review',
      smartCategory: { primary: 'review' },
      smartClassifierVersion: SMART_CLASSIFIER_VERSION - 1,
    });
    const current = await seedRow(t, {
      smartPrimary: 'review',
      smartCategory: { primary: 'review', reason: 'kept' },
      smartClassifierVersion: SMART_CLASSIFIER_VERSION,
    });
    expect(await t.mutation(internal.smart.classifyBacklog, {})).toEqual({ classified: 2, done: true });
    const rows = await t.run(async (ctx) => Promise.all([none, old, current].map((id) => ctx.db.get(id))));
    expect(rows[0]?.smartClassifierVersion).toBe(SMART_CLASSIFIER_VERSION);
    expect(rows[1]?.smartClassifierVersion).toBe(SMART_CLASSIFIER_VERSION);
    expect(rows[0]?.smartPrimary).toBe('main');
    expect(rows[2]?.smartCategory?.reason).toBe('kept');
    expect(await t.mutation(internal.smart.classifyBacklog, {})).toEqual({ classified: 0, done: true });
  });
});

describe('CLS-1 and CLS-12 Jev input and Jev writes', () => {
  async function seedMail(t: Harness, body: string) {
    await t.run(async (ctx) => {
      await ctx.db.insert('connectedAccounts', {
        userId: USER,
        accountId: 'acct',
        email: 'owner@example.test',
        provider: 'google',
        grantId: 'grant',
        status: 'connected',
        scopes: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'smartLabel',
        key: 'linen',
        doc: label({ _id: 'linen', name: 'Linen', positiveExamples: ['linen shirt'] }),
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'acct',
      grantId: 'grant',
      provider: 'google',
      threads: [],
      messages: [
        {
          providerMessageId: 'm-long',
          providerThreadId: 't-long',
          subject: 'Autumn is here',
          from: 'Example Shop <hello@shop.example.test>',
          to: 'owner@example.test',
          receivedAt: NOW,
          snippet: 'Our autumn collection is here.',
          textBody: body,
          searchText: body,
          labels: ['INBOX'],
        },
      ],
    });
  }

  test('a long body keeps contextComplete true, and the Jev write keeps body-based labels', async () => {
    const t = harness();
    await seedMail(t, LONG_PROMO_BODY);
    const claimed = await t.mutation((api as any).jev.claimPending, {
      internalSecret: SECRET,
      userId: USER,
      limit: 5,
    });
    expect(claimed.items).toHaveLength(1);
    const input = claimed.items[0];
    expect(input.contextComplete).toBe(true);
    expect(input.messages[0].body.length).toBe(2400);
    const result = assessmentFromResponse(
      input,
      responseFor(input, { purpose: 'promotion', reply: 0.01, reply_evidence: 'none' }),
      NOW,
    );
    expect(result.status).toBe('accepted');
    await t.mutation((api as any).jev.storeAssessments, {
      internalSecret: SECRET,
      userId: USER,
      items: [
        {
          accountId: input.accountId,
          threadId: input.threadId,
          messageId: input.messageId,
          sourceRevision: input.sourceRevision,
          leaseId: input.leaseId,
          assessment: result,
        },
      ],
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q.eq('userId', USER).eq('accountId', 'acct').eq('providerThreadId', 't-long'),
        )
        .unique(),
    );
    expect(row?.smartPrimary).toBe('noise');
    // "linen shirt" is only in the body; the Jev write read the body too.
    expect(row?.smartCustomKeys).toEqual(['linen']);
    expect(row?.smartClassifierVersion).toBe(SMART_CLASSIFIER_VERSION);
  });
});
