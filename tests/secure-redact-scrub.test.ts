import { describe, expect, test } from 'bun:test';
import {
  detectSecretShapes,
  redactDeep,
  redactedMarker,
  redactSecretShapes,
  redactUserMessages,
} from '../lib/secure/redact';
import { SecureScrubber, scrubTypedFields } from '../lib/secure/scrub';

// The chat backstop (V9) and the page scrubber (docs/albatross-secure-store.md).
// Sample values are invented and built from parts, so secret scanners stay quiet.

const join = (...parts: string[]) => parts.join('');
const ssn = join('123', '-45-', '6789');
const visa = join('4242', ' 4242 ', '4242', ' 4242');
const amex = join('3782', '822463', '10005');
const openAiKey = join('sk-', 'abcdefghijklmnop', 'qrstuvwxyz123456');

describe('detectSecretShapes', () => {
  test('grouped and named Social Security numbers', () => {
    expect(redactSecretShapes(`My SSN is ${ssn}.`).text).toBe(
      'My SSN is [removed: looks like a Social Security number].',
    );
    expect(redactSecretShapes(`social security number: ${join('123', '45', '6789')}`).kinds).toEqual(['ssn']);
    expect(detectSecretShapes(join('123', ' 45 ', '6789'))).toHaveLength(1);
    // Mixed separators, impossible areas, and bare nine digits without a name stay.
    for (const text of [
      join('123', '-45 ', '6789'),
      join('000', '-45-', '6789'),
      join('900', '-45-', '6789'),
      join('order ', '123456789'),
    ])
      expect(detectSecretShapes(text)).toEqual([]);
  });

  test('card numbers need a network prefix, a network length, and Luhn', () => {
    expect(redactSecretShapes(`card ${visa} thanks`).text).toBe(`card ${redactedMarker('card')} thanks`);
    expect(redactSecretShapes(amex).kinds).toEqual(['card']);
    for (const text of [
      join('4242', '4242', '4242', '4241'), // Luhn fails
      join('9400', '1000', '0000', '0000', '0000', '00'), // a USPS tracking number
      join('1Z', '999AA1', '0123456784'), // a UPS tracking number
      '(555) 555-0100',
      join('7489', '2345', '6712', '3456'), // no network prefix
    ])
      expect(detectSecretShapes(text)).toEqual([]);
  });

  test('API keys and private keys', () => {
    expect(redactSecretShapes(`use ${openAiKey} please`).text).toBe(
      `use ${redactedMarker('api_key')} please`,
    );
    expect(detectSecretShapes(join('AKIA', 'ABCDEFGHIJKLMNOP'))).toHaveLength(1);
    expect(
      detectSecretShapes(join('-----BEGIN ', 'PRIVATE KEY-----\nabc\n-----END ', 'PRIVATE KEY-----')),
    ).toHaveLength(1);
  });

  test('several values in one text; the result is stable on a second pass', () => {
    const once = redactSecretShapes(`${ssn} and ${visa}`);
    expect(once.kinds.sort()).toEqual(['card', 'ssn']);
    expect(redactSecretShapes(once.text)).toEqual({ text: once.text, kinds: [] });
    expect(redactSecretShapes('')).toEqual({ text: '', kinds: [] });
  });
});

describe('redactUserMessages and redactDeep', () => {
  test('user text and form answers are redacted; assistant text and other tools stay', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: `SSN ${ssn}` }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'I will not repeat it.' }] },
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_form',
            toolCallId: 't1',
            output: { values: { note: ssn, phone: '+15555550100' } },
          },
          { type: 'tool-search_threads', toolCallId: 't2', output: { query: ssn } },
        ],
      },
    ];
    const out = redactUserMessages(messages) as any[];
    expect(out[0].parts[0].text).toBe(`SSN ${redactedMarker('ssn')}`);
    expect(out[1]).toBe(messages[1]);
    expect(out[2].parts[0].output.values).toEqual({ note: redactedMarker('ssn'), phone: '+15555550100' });
    expect(out[2].parts[1]).toBe(messages[2].parts[1]);
  });

  test('nothing to remove returns the same array', () => {
    const messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Renew my registration.' }] }];
    expect(redactUserMessages(messages)).toBe(messages);
    const value = { a: ['x', { b: 'y' }], n: 4 };
    expect(redactDeep(value)).toBe(value);
    expect(redactDeep({ a: [{ b: ssn }] })).toEqual({ a: [{ b: redactedMarker('ssn') }] });
  });
});

describe('SecureScrubber', () => {
  test('removes every form of a value, case-insensitive, longest first', () => {
    const scrubber = new SecureScrubber();
    scrubber.add(['123-45-6789', '123456789', 'short'], 'Social Security number');
    scrubber.add(['D1234821'], "Driver's license");
    expect(scrubber.size).toBe(3);
    expect(scrubber.scrub('SSN 123-45-6789, again 123456789, license d1234821.')).toBe(
      "SSN [secure: Social Security number], again [secure: Social Security number], license [secure: Driver's license].",
    );
    expect(new SecureScrubber().scrub('unchanged')).toBe('unchanged');
    expect(scrubber.scrub('')).toBe('');
  });

  test('regex characters in a value are matched as text', () => {
    const scrubber = new SecureScrubber();
    scrubber.add(['p@ss.w(rd)+'], 'Chase password');
    expect(scrubber.scrub('typed p@ss.w(rd)+ and pXssXwXrd')).toBe(
      'typed [secure: Chase password] and pXssXwXrd',
    );
  });
});

describe('scrubTypedFields', () => {
  test('the value of a typed field and the selected marks under it go', () => {
    const snapshot = [
      '- textbox "Driver license ID" [ref=e5]: D1234821',
      '- textbox "Plate number" [ref=e6]: ABC 1234',
      '- combobox "Birth month" [ref=e7]:',
      '  - option "March"',
      '  - option "April" [selected]',
      '- button "Continue" [ref=e9]',
    ].join('\n');
    const fields = new Map([
      ['e5', "Driver's license number"],
      ['e7', 'Date of birth'],
    ]);
    expect(scrubTypedFields(snapshot, fields)).toBe(
      [
        '- textbox "Driver license ID" [ref=e5]: [secure: Driver\'s license number]',
        '- textbox "Plate number" [ref=e6]: ABC 1234',
        '- combobox "Birth month" [ref=e7]:',
        '  - option "March"',
        '  - option "April"',
        '- button "Continue" [ref=e9]',
      ].join('\n'),
    );
    expect(scrubTypedFields(snapshot, new Map())).toBe(snapshot);
  });
});
