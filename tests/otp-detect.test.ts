import { describe, expect, test } from 'bun:test';
import { extractOneTimeCode, registrableDomain, stripHtmlForScan } from '../lib/mail/otp-detect';

const RECEIVED_AT = Date.UTC(2026, 6, 29, 12, 0, 0);

function message(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Your verification code',
    from: 'Google <no-reply@accounts.google.com>',
    receivedAt: RECEIVED_AT,
    snippet: '',
    textBody: 'Your verification code is 284917. It expires in 10 minutes.',
    ...overrides,
  } as any;
}

describe('extractOneTimeCode', () => {
  test('reads a labelled code and folds the sending subdomain onto the service', () => {
    const found = extractOneTimeCode(message());
    expect(found?.code).toBe('284917');
    expect(found?.serviceIdentifiers).toEqual(['google.com']);
    expect(found?.issuer).toBe('Google');
    expect(found?.expiresAt).toBe(RECEIVED_AT + 10 * 60_000);
  });

  test('reads the trailing phrasing', () => {
    const found = extractOneTimeCode(
      message({
        textBody: '918273 is your Stripe verification code. Do not share it.',
        from: 'Stripe <support@stripe.com>',
      }),
    );
    expect(found?.code).toBe('918273');
  });

  test('reads the imperative phrasing', () => {
    const found = extractOneTimeCode(
      message({
        subject: 'Sign in to Figma',
        textBody: 'Enter 402913 to sign in to your account.',
        from: 'Figma <hello@figma.com>',
      }),
    );
    expect(found?.code).toBe('402913');
  });

  test('reads alphanumeric codes', () => {
    const found = extractOneTimeCode(
      message({ textBody: 'Your login code is 7HG2KP. It expires in 5 minutes.' }),
    );
    expect(found?.code).toBe('7HG2KP');
    expect(found?.expiresAt).toBe(RECEIVED_AT + 5 * 60_000);
  });

  test('falls back to a ten minute window when no expiry is stated', () => {
    const found = extractOneTimeCode(message({ textBody: 'Your verification code is 284917.' }));
    expect(found?.expiresAt).toBe(RECEIVED_AT + 10 * 60_000);
  });

  test('clamps an implausibly long stated expiry', () => {
    const found = extractOneTimeCode(
      message({ textBody: 'Your verification code is 284917. It expires in 240 minutes.' }),
    );
    expect(found?.expiresAt).toBe(RECEIVED_AT + 30 * 60_000);
  });

  test('reads a code out of HTML when there is no text part', () => {
    const found = extractOneTimeCode(
      message({
        textBody: undefined,
        htmlBody: '<html><body><p>Your security code is</p><h1>553201</h1></body></html>',
      }),
    );
    expect(found?.code).toBe('553201');
  });

  test('takes the service domain from body links when the sender is an ESP', () => {
    const found = extractOneTimeCode(
      message({
        from: 'Notion <bounces@sendgrid.net>',
        textBody: 'Your verification code is 665412. Sign in at https://www.notion.so/login',
      }),
    );
    expect(found?.serviceIdentifiers).toContain('notion.so');
    expect(found?.serviceIdentifiers).not.toContain('sendgrid.net');
  });

  test('keeps a genuine product subdomain as the more specific option', () => {
    const found = extractOneTimeCode(message({ from: 'Console <noreply@console.aws.amazon.com>' }));
    expect(found?.serviceIdentifiers[0]).toBe('console.aws.amazon.com');
    expect(found?.serviceIdentifiers).toContain('amazon.com');
  });
});

describe('extractOneTimeCode rejections', () => {
  test('ignores a message with no verification framing', () => {
    expect(
      extractOneTimeCode(
        message({
          subject: 'Your order shipped',
          textBody: 'Tracking number 284917 is on its way.',
        }),
      ),
    ).toBeNull();
  });

  test('ignores an unlabelled number even in a verification message', () => {
    expect(
      extractOneTimeCode(
        message({ textBody: 'We could not verify your account. Reference 284917 when you call.' }),
      ),
    ).toBeNull();
  });

  test('ignores order and invoice numbers next to confirmation language', () => {
    expect(
      extractOneTimeCode(
        message({
          subject: 'Order confirmation',
          textBody: 'Please confirm your order. Order number: 3391208. Sign in to view it.',
        }),
      ),
    ).toBeNull();
  });

  test('ignores a year', () => {
    expect(extractOneTimeCode(message({ textBody: 'Your verification code is 2026 something.' }))).toBeNull();
  });

  test('ignores repeated and sequential digits', () => {
    expect(extractOneTimeCode(message({ textBody: 'Your verification code is 000000.' }))).toBeNull();
    expect(extractOneTimeCode(message({ textBody: 'Your verification code is 123456.' }))).toBeNull();
  });

  test('ignores a code embedded in a URL', () => {
    expect(
      extractOneTimeCode(
        message({
          textBody: 'Verify your email: https://example.com/verify?code=284917 to continue.',
        }),
      ),
    ).toBeNull();
  });

  test('ignores a digit run that a code pattern only partially matched', () => {
    expect(
      extractOneTimeCode(
        message({ textBody: 'Your verification code is 2849170923847 for this login attempt.' }),
      ),
    ).toBeNull();
  });

  test('offers nothing when two equally-labelled codes are present', () => {
    expect(
      extractOneTimeCode(
        message({
          textBody: 'Your verification code is 284917. Your backup verification code is 771203.',
        }),
      ),
    ).toBeNull();
  });

  test('ignores a message with no resolvable service domain', () => {
    expect(
      extractOneTimeCode(message({ from: 'localhost', textBody: 'Your verification code is 284917.' })),
    ).toBeNull();
  });
});

describe('registrableDomain', () => {
  test('folds subdomains onto the registrable domain', () => {
    expect(registrableDomain('accounts.google.com')).toBe('google.com');
    expect(registrableDomain('google.com')).toBe('google.com');
  });

  test('respects multi-label public suffixes', () => {
    expect(registrableDomain('mail.marksandspencer.co.uk')).toBe('marksandspencer.co.uk');
    expect(registrableDomain('example.com.au')).toBe('example.com.au');
  });

  test('returns nothing for a bare host', () => {
    expect(registrableDomain('localhost')).toBe('');
  });
});

describe('stripHtmlForScan', () => {
  test('drops markup and script content but keeps block boundaries', () => {
    const text = stripHtmlForScan(
      '<style>p{color:red}</style><p>Your code</p><script>var x=99;</script><div>551204</div>',
    );
    expect(text).toContain('Your code');
    expect(text).toContain('551204');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('var x');
  });

  test('decodes the entities that appear around codes', () => {
    expect(stripHtmlForScan('a&nbsp;b &amp; c &#53;')).toContain('a b & c 5');
  });
});
