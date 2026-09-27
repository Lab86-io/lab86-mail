import { describe, expect, test } from 'bun:test';
import { classifyThreadWithContext, isHumanLike } from '../lib/mail/smart-categories';

// Real staging shapes from the 2026-09-26 re-sort: mail from relatives went to
// Noise after round 1, because Gmail filed it in Updates, or because a
// forwarded newsletter's footer made the sender look like a mailing list.
const promoFooter = `${'Pick from our six most popular tours. '.repeat(90)} Unsubscribe from these emails.`;

describe('people stay people', () => {
  test('a relative sharing a Google Doc is a person even in the Updates tab', () => {
    const thread = {
      fromAddress: 'Josh Langtry <joshlangtry@gmail.com>',
      subject: 'trendspotting final - Invitation to comment',
      snippet: 'Josh Langtry has invited you to comment on the following document',
      labels: ['CATEGORY_UPDATES', 'INBOX'],
      unread: false,
    };
    expect(isHumanLike(thread)).toBe(true);
    expect(classifyThreadWithContext(thread).primary).toBe('main');
  });

  test('a forwarded newsletter from a relative stays in Main', () => {
    const thread = {
      fromAddress: 'Langtry Family <langtryfamily@gmail.com>',
      subject: 'Fwd: Cancun: 6 popular tours & activities',
      snippet: 'Thought you would like this',
      labels: ['CATEGORY_PERSONAL', 'INBOX'],
      bodyText: promoFooter,
      unread: false,
    };
    expect(isHumanLike(thread)).toBe(true);
    expect(classifyThreadWithContext(thread).primary).toBe('main');
  });

  test('a forward from a work address is judged on its headers, not the forwarded footer', () => {
    const thread = {
      fromAddress: 'Dana Reyes <dana@acme-industries.com>',
      subject: 'Fwd: Q3 industry digest',
      snippet: 'See the section on pricing',
      labels: ['CATEGORY_PERSONAL', 'INBOX'],
      bodyText: promoFooter,
      listUnsubscribe: '<mailto:unsubscribe@digest.example>',
      unread: true,
    };
    expect(isHumanLike(thread)).toBe(true);
  });

  test('brands stay out of Main', () => {
    expect(
      isHumanLike({
        fromAddress: 'Brand <hi@brand.com>',
        subject: 'New arrivals',
        labels: ['CATEGORY_PROMOTIONS'],
      }),
    ).toBe(false);
    // iCloud Hide My Email relays a brand from an icloud.com address.
    expect(
      isHumanLike({
        fromAddress: 'LIFX <cloud_at_lifx_com_txx9168f8nzqf3_57692912@icloud.com>',
        subject: 'Your account',
        labels: ['CATEGORY_UPDATES'],
      }),
    ).toBe(false);
    expect(isHumanLike({ fromAddress: 'Support <support@gmail.com>', subject: 'Hi', labels: [] })).toBe(
      false,
    );
    expect(isHumanLike({ fromAddress: 'No Reply <no-reply@gmail.com>', subject: 'Hi', labels: [] })).toBe(
      false,
    );
  });
});
