import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { classifyCorpusThread, savedContactFloor } from '../convex/smart';
import { normalizeNylasContact } from '../lib/contacts/model';
import {
  classifyThreadDeterministic,
  classifyThreadWithContext,
  isHumanLike,
  isSavedContactPerson,
  SMART_CLASSIFIER_VERSION,
} from '../lib/mail/smart-categories';

const person = {
  _id: 't1',
  fromAddress: 'Dana Reed <dana@acmeco.com>',
  subject: 'Quick question about the sale',
  snippet: 'We have an offer for the team, can you look?',
  bodyText: 'We have an offer for the team, can you look? Thanks, Dana',
  labels: ['INBOX', 'UNREAD'],
  unread: true,
};

describe('saved contacts in the deterministic sort', () => {
  test('a saved contact who writes sales words is a person, not bulk mail', () => {
    expect(classifyThreadDeterministic(person).primary).toBe('noise');
    const saved = classifyThreadDeterministic({ ...person, savedContact: true });
    expect(saved.primary).toBe('main');
    expect(saved.signals).toContain('saved_contact');
    const viaContext = classifyThreadWithContext(person, { savedContacts: new Set(['dana@acmeco.com']) });
    expect(viaContext.primary).toBe('main');
    expect(classifyThreadWithContext(person, { savedContacts: new Set(['other@x.io']) }).primary).toBe(
      'noise',
    );
  });

  test('list mail from a saved contact stays bulk', () => {
    for (const thread of [
      { ...person, listUnsubscribe: '<mailto:unsub@acmeco.com>' },
      { ...person, listId: 'team.acmeco.com' },
      { ...person, bodyText: `${person.bodyText}\nUnsubscribe from these emails` },
      { ...person, labels: ['INBOX', 'CATEGORY_PROMOTIONS'] },
    ]) {
      expect(isSavedContactPerson({ ...thread, savedContact: true })).toBe(false);
      expect(classifyThreadDeterministic({ ...thread, savedContact: true }).primary).toBe(
        classifyThreadDeterministic(thread).primary,
      );
    }
  });

  test('role, platform, and no-reply addresses stay automated', () => {
    for (const fromAddress of [
      'Acme <noreply@acmeco.com>',
      'Acme <info@acmeco.com>',
      'Acme Support <support@acmeco.com>',
      'Jobs <jobs@linkedin.com>',
    ]) {
      expect(isSavedContactPerson({ ...person, fromAddress, savedContact: true })).toBe(false);
    }
    expect(isSavedContactPerson({ ...person, fromAddress: '', savedContact: true })).toBe(false);
    expect(isSavedContactPerson(person)).toBe(false);
  });

  test('a saved contact filed under Gmail Updates is a person', () => {
    const updates = {
      ...person,
      subject: 'Notes',
      snippet: 'Notes',
      bodyText: 'Notes',
      labels: ['CATEGORY_UPDATES'],
    };
    expect(isHumanLike(updates)).toBe(false);
    expect(isHumanLike({ ...updates, savedContact: true })).toBe(true);
  });

  test('the classifier version stays the same: the signal applies to new sorts only', () => {
    expect(SMART_CLASSIFIER_VERSION).toBe(3);
  });
});

describe('the saved-contact floor over model verdicts', () => {
  const det = classifyThreadDeterministic({ ...person, savedContact: true });
  const model = (primary: string, extra: Record<string, unknown> = {}) =>
    ({ ...det, primary, signals: ['jev'], model: 'jev-model', ...extra }) as any;

  test('Review and Noise from the model move to Main', () => {
    expect(savedContactFloor(model('review'), det, { purpose: 'conversation' })).toMatchObject({
      primary: 'main',
      reason: 'Direct mail from a saved contact.',
      signals: ['jev', 'saved_contact'],
    });
    expect(savedContactFloor(model('noise'), det, null).primary).toBe('main');
  });

  test('bulk purposes, other places, user rules, and non-contacts keep the verdict', () => {
    for (const purpose of ['promotion', 'newsletter', 'transaction']) {
      expect(savedContactFloor(model('noise'), det, { purpose }).primary).toBe('noise');
    }
    expect(savedContactFloor(model('orders'), det, null).primary).toBe('orders');
    expect(savedContactFloor(model('noise', { model: 'user_rule' }), det, null).primary).toBe('noise');
    const plain = classifyThreadDeterministic(person);
    expect(savedContactFloor(model('review'), plain, null).primary).toBe('review');
    expect(savedContactFloor(det, det, null)).toBe(det);
  });

  test('classifyCorpusThread applies the floor to a current Jev verdict', () => {
    const row = {
      providerThreadId: 't1',
      subject: person.subject,
      fromAddress: person.fromAddress,
      snippet: person.snippet,
      labels: person.labels,
      unread: true,
      latestMessageId: 'm1',
      jev: {
        version: 1,
        questionVersion: 'mail-1',
        sourceMessageId: 'm1',
        sourceRevision: 'r1',
        evaluatedAt: 1,
        model: 'jev-model',
        status: 'uncertain',
        purpose: 'conversation',
        subjectKind: 'general',
        confidence: 0.4,
        obligations: [],
        meaningfulChange: false,
        probabilities: {},
        contextComplete: true,
      },
    };
    const context = { rules: [], customLabels: [], savedContacts: new Set(['dana@acmeco.com']) };
    expect(classifyCorpusThread(row, context, person.bodyText).smartCategory.primary).toBe('main');
    expect(
      classifyCorpusThread(row, { rules: [], customLabels: [], savedContacts: new Set() }, person.bodyText)
        .smartCategory.primary,
    ).toBe('review');
  });
});

describe('the corpus writer reads the saved-contact signal', () => {
  const SECRET = 'saved-contact-secret';
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });
  const modules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/accounts.ts': () => import('../convex/accounts'),
    '../convex/contacts.ts': () => import('../convex/contacts'),
    '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  };

  test('a new thread from a saved contact lands in Main; the same mail from a stranger does not', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.accounts.upsertConnectedAccount, {
      internalSecret: SECRET,
      userId: 'u',
      email: 'me@lab86.io',
      provider: 'google',
      grantId: 'g',
      scopes: [],
    });
    await t.mutation(api.contacts.upsertContactBatch, {
      internalSecret: SECRET,
      userId: 'u',
      accountId: 'g',
      provider: 'google',
      contacts: [
        normalizeNylasContact(
          { id: 'c1', displayName: 'Dana Reed', emails: [{ email: 'dana@acmeco.com' }] },
          'address_book',
        )!,
      ],
    });
    const message = (id: string, from: string) => ({
      providerMessageId: id,
      providerThreadId: `t_${id}`,
      subject: person.subject,
      from,
      to: 'me@lab86.io',
      receivedAt: Date.now(),
      snippet: person.snippet,
      textBody: person.bodyText,
      searchText: 'x',
      labels: ['INBOX', 'UNREAD'],
      unread: true,
    });
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      internalSecret: SECRET,
      userId: 'u',
      accountId: 'g',
      grantId: 'g',
      provider: 'google',
      threads: [],
      messages: [message('m1', 'Dana Reed <dana@acmeco.com>'), message('m2', 'Sam Stone <sam@acmeco.com>')],
    });
    const threads = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
    const byId = Object.fromEntries(threads.map((row) => [row.providerThreadId, row]));
    expect(byId.t_m1.smartPrimary).toBe('main');
    expect(byId.t_m1.smartCategory.signals).toContain('saved_contact');
    expect(byId.t_m2.smartPrimary).toBe('noise');
  });
});
