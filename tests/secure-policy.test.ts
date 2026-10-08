import { describe, expect, test } from 'bun:test';
import {
  ageYears,
  findReferences,
  formatSecureValue,
  kindMayAskForSite,
  looksLikeCardNumber,
  mentionsReference,
  normalizeSite,
  normalizeSites,
  parseSecureItem,
  referenceLabel,
  refuseSecureLabel,
  SecurePolicyError,
  scrubNeedles,
  secureHints,
  siteCovers,
  siteForHost,
} from '../lib/secure/policy';

// What Passwords and IDs keeps, how it shows an item, and where an item works
// (docs/albatross-secure-store.md). Sample values are invented and built from parts.

const join = (...parts: string[]) => parts.join('');
const ssn = join('123', '-45-', '6789');
const card = join('4242', '4242', '4242', '4242');
const key = join('sk-', 'abcdefghij', 'klmnopqrstuv', 'f3a2');
const NOW = Date.UTC(2026, 9, 8);

function policyError(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SecurePolicyError);
    return error as SecurePolicyError;
  }
  throw new Error('no error');
}

describe('parseSecureItem', () => {
  test('a sign-in keeps its two values and a default label', () => {
    expect(
      parseSecureItem({ kind: 'sign_in', values: { username: 'sam.rivera@example.com', password: 'pw-1' } }),
    ).toEqual({
      kind: 'sign_in',
      label: 'Sign-in',
      values: { username: 'sam.rivera@example.com', password: 'pw-1' },
      facts: {},
    });
    expect(policyError(() => parseSecureItem({ kind: 'sign_in', values: { username: 'sam' } })).field).toBe(
      'password',
    );
  });

  test('an ID keeps its number sealed and its type, region, country, and expiry month as facts', () => {
    const parsed = parseSecureItem({
      kind: 'id_number',
      values: {
        type: 'drivers_license',
        number: 'D123 4821',
        region: 'NY',
        country: 'us',
        expires: '2029-06-30',
      },
      now: NOW,
    });
    expect(parsed.label).toBe("Driver's license");
    expect(parsed.values).toEqual({ number: 'D123 4821', expires: '2029-06-30' });
    expect(parsed.facts).toEqual({
      type: 'drivers_license',
      region: 'NY',
      country: 'US',
      expires: '2029-06',
    });
  });

  test('a Social Security number is stored as nine digits and checked for real shapes', () => {
    expect(parseSecureItem({ kind: 'id_number', values: { type: 'ssn', number: ssn } }).values.number).toBe(
      '123456789',
    );
    expect(
      policyError(() => parseSecureItem({ kind: 'id_number', values: { type: 'ssn', number: '12345' } }))
        .message,
    ).toBe('A Social Security number has 9 digits.');
    for (const bad of [
      join('000', '-45-', '6789'),
      join('666', '-45-', '6789'),
      join('900', '-45-', '6789'),
      join('123', '-00-', '6789'),
    ])
      expect(
        policyError(() => parseSecureItem({ kind: 'id_number', values: { type: 'ssn', number: bad } }))
          .message,
      ).toBe('Check the Social Security number.');
  });

  test('cards, codes, and bank numbers are refused with a reason', () => {
    const asId = policyError(() =>
      parseSecureItem({ kind: 'id_number', values: { type: 'other', number: card } }),
    );
    expect(asId).toMatchObject({ code: 'refused', reason: 'card', field: 'number' });
    expect(asId.message).not.toContain('4242');
    expect(
      policyError(() =>
        parseSecureItem({
          kind: 'id_number',
          label: 'Recovery codes',
          values: { type: 'other', number: 'A1B2C3' },
        }),
      ),
    ).toMatchObject({ reason: 'code', field: 'label' });
    expect(
      policyError(() =>
        parseSecureItem({
          kind: 'sign_in',
          label: 'Routing number',
          values: { username: 'a', password: 'b' },
        }),
      ),
    ).toMatchObject({ reason: 'bank' });
    expect(policyError(() => parseSecureItem({ kind: 'api_key', values: { key: card } }))).toMatchObject({
      reason: 'card',
    });
    expect(refuseSecureLabel('Password')).toBeNull();
    expect(refuseSecureLabel("Driver's license")).toBeNull();
    expect(looksLikeCardNumber('4242 4242 4242 4241')).toBe(false);
  });

  test('dates must be real and a birth date must be past', () => {
    expect(parseSecureItem({ kind: 'date_of_birth', values: { date: '1990-04-12' }, now: NOW }).label).toBe(
      'Date of birth',
    );
    for (const date of ['1990-02-30', '2027-01-01', '04/12/1990'])
      expect(() => parseSecureItem({ kind: 'date_of_birth', values: { date }, now: NOW })).toThrow(
        SecurePolicyError,
      );
    expect(
      policyError(() =>
        parseSecureItem({
          kind: 'id_number',
          values: { type: 'passport', number: 'X1234567', expires: '2029-13-01' },
        }),
      ).field,
    ).toBe('expires');
  });

  test('an API key has no spaces; the header is a plain name', () => {
    expect(parseSecureItem({ kind: 'api_key', values: { key, header: 'x-api-key' } }).facts).toEqual({
      header: 'x-api-key',
    });
    expect(policyError(() => parseSecureItem({ kind: 'api_key', values: { key: 'ab cd' } })).message).toBe(
      'A key has no spaces.',
    );
    expect(
      policyError(() => parseSecureItem({ kind: 'api_key', values: { key, header: 'Bad: Header' } })).field,
    ).toBe('header');
    expect(
      policyError(() => parseSecureItem({ kind: 'api_key', label: 'x'.repeat(81), values: { key } })).field,
    ).toBe('label');
  });
});

describe('hints and age', () => {
  test('a hint holds at most four characters of a value', () => {
    expect(secureHints('sign_in', { username: 'sam.rivera@example.com', password: 'pw' })).toEqual({
      username: 's•••@example.com',
      password: '••••••••',
    });
    expect(secureHints('sign_in', { username: 'samr', password: 'pw' }).username).toBe('s•••');
    expect(secureHints('id_number', { number: 'D123 4821', name_on_id: 'Sam Rivera' })).toEqual({
      number: 'ends 4821',
      name_on_id: 'saved',
    });
    expect(secureHints('id_number', { number: 'A12' }).number).toBe('saved');
    expect(secureHints('api_key', { key }).key).toBe('sk-…f3a2');
    expect(secureHints('api_key', { key: 'short' }).key).toBe('saved');
    expect(secureHints('date_of_birth', { date: '1990-04-12' })).toEqual({ date: 'saved' });
  });

  test('age counts whole years and the birthday', () => {
    expect(ageYears('1990-10-08', NOW)).toBe(36);
    expect(ageYears('1990-10-09', NOW)).toBe(35);
    expect(ageYears('bad', NOW)).toBeNull();
    expect(ageYears('2030-01-01', NOW)).toBeNull();
  });
});

describe('sites', () => {
  test('a site is the registrable domain; private suffixes count; a key keeps its host', () => {
    expect(normalizeSite('https://secure.chase.com/login?x=1', 'sign_in')).toBe('chase.com');
    expect(normalizeSite('www.Chase.com', 'sign_in')).toBe('chase.com');
    expect(normalizeSite('dmv.ny.gov', 'id_number')).toBe('ny.gov');
    expect(normalizeSite('sam.github.io', 'sign_in')).toBe('sam.github.io');
    expect(normalizeSite('https://api.openai.com/v1', 'api_key')).toBe('api.openai.com');
    for (const bad of [
      '',
      'localhost',
      '127.0.0.1',
      'http://10.0.0.5',
      'printer.local',
      'ftp://chase.com',
      'co.uk',
    ])
      expect(() => normalizeSite(bad, 'sign_in')).toThrow(SecurePolicyError);
  });

  test('a site list is unique and capped', () => {
    expect(normalizeSites(['chase.com', 'secure.chase.com', 'https://chase.com'], 'sign_in')).toEqual([
      'chase.com',
    ]);
    expect(normalizeSites(undefined, 'id_number')).toEqual([]);
    const many = Array.from({ length: 21 }, (_, index) => `site${index}.com`);
    expect(policyError(() => normalizeSites(many, 'sign_in')).code).toBe('limit');
  });

  test('a site covers itself and its subdomains, never a look-alike', () => {
    expect(siteCovers('chase.com', 'secure.chase.com')).toBe(true);
    expect(siteCovers('chase.com', 'chase.com.')).toBe(true);
    expect(siteCovers('chase.com', 'notchase.com')).toBe(false);
    expect(siteCovers('chase.com', 'chase.com.evil.example')).toBe(false);
    expect(siteForHost('dmv.ny.gov')).toBe('ny.gov');
    expect(siteForHost('192.168.1.1')).toBeNull();
    expect(kindMayAskForSite('id_number')).toBe(true);
    expect(kindMayAskForSite('sign_in')).toBe(false);
  });
});

describe('references', () => {
  test('references parse with an optional format', () => {
    const text =
      '{{secure:si_abcdefghijklmnopqrstuv.password}} and {{secure:si_x1234567890123456.date|MM/DD/YYYY}}';
    expect(findReferences(text)).toEqual([
      {
        raw: '{{secure:si_abcdefghijklmnopqrstuv.password}}',
        itemId: 'si_abcdefghijklmnopqrstuv',
        field: 'password',
        format: null,
      },
      {
        raw: '{{secure:si_x1234567890123456.date|MM/DD/YYYY}}',
        itemId: 'si_x1234567890123456',
        field: 'date',
        format: 'MM/DD/YYYY',
      },
    ]);
    expect(findReferences('plain text')).toEqual([]);
    expect(mentionsReference('{{ secure: broken')).toBe(true);
    expect(mentionsReference('nothing here')).toBe(false);
  });

  test('dates and numbers format for split boxes', () => {
    const date = (format: string) =>
      formatSecureValue({ kind: 'date_of_birth', field: 'date', value: '1990-04-02', format });
    expect(
      ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'MM/YYYY', 'MM', 'DD', 'YYYY', 'M', 'D', 'MONTH'].map(date),
    ).toEqual(['1990-04-02', '04/02/1990', '02/04/1990', '04/1990', '04', '02', '1990', '4', '2', 'April']);
    const number = (format: string | null, idType = 'ssn', value = '123456789') =>
      formatSecureValue({ kind: 'id_number', field: 'number', value, format, idType });
    expect(
      [null, 'DIGITS', 'LAST4', 'DASHED', 'AREA', 'GROUP', 'SERIAL'].map((format) => number(format)),
    ).toEqual(['123456789', '123456789', '6789', '123-45-6789', '123', '45', '6789']);
    expect(number('LAST4', 'drivers_license', 'D123 4821')).toBe('4821');
    expect(() => number('AREA', 'drivers_license', 'D1234821')).toThrow(/Social Security/);
    expect(() => date('YY')).toThrow(/date format/);
    expect(() => number('BOXES')).toThrow(/number format/);
    expect(() =>
      formatSecureValue({ kind: 'sign_in', field: 'password', value: 'x', format: 'DIGITS' }),
    ).toThrow(/no format/);
  });

  test('labels name what was typed, never the value', () => {
    expect(referenceLabel('Chase', 'sign_in', 'password')).toBe('Chase password');
    expect(referenceLabel('Chase', 'sign_in', 'username')).toBe('Chase username');
    expect(referenceLabel("Driver's license", 'id_number', 'number')).toBe("Driver's license number");
    expect(referenceLabel("Driver's license", 'id_number', 'expires')).toBe("Driver's license expiry date");
    expect(referenceLabel('Date of birth', 'date_of_birth', 'date')).toBe('Date of birth');
    expect(referenceLabel('OpenAI', 'api_key', 'key')).toBe('OpenAI key');
  });
});

describe('scrub needles', () => {
  test('long secret values and their other forms; never usernames', () => {
    expect(scrubNeedles('sign_in', { username: 'sam.rivera@example.com', password: 'hunter22' })).toEqual([
      'hunter22',
    ]);
    expect(scrubNeedles('sign_in', { username: 'sam', password: 'abc' })).toEqual([]);
    expect(scrubNeedles('id_number', { number: '123456789' }, 'ssn').sort()).toEqual(
      ['123 45 6789', '123-45-6789', '123456789'].sort(),
    );
    expect(scrubNeedles('id_number', { number: 'D123 4821' })).toEqual(['D123 4821', 'D1234821']);
    expect(scrubNeedles('date_of_birth', { date: '1990-04-02' })).toEqual([
      '1990-04-02',
      '04/02/1990',
      '02/04/1990',
      'April 2, 1990',
      '4/2/1990',
    ]);
    expect(scrubNeedles('api_key', { key })).toEqual([key]);
  });
});
