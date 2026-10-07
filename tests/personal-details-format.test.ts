import { describe, expect, test } from 'bun:test';
import {
  addressLine,
  detailDisplay,
  detailLabel,
  fullName,
  nameFromAccount,
  phoneDisplay,
  phoneParts,
} from '../lib/personal-details/format';

describe('personal details formats', () => {
  test('a North American number splits into the three boxes forms use', () => {
    expect(phoneParts('(555) 555-0100')).toEqual({
      national: '5555550100',
      countryCode: '+1',
      area: '555',
      prefix: '555',
      line: '0100',
      e164: '+15555550100',
    });
    expect(phoneParts('+1 555 555 0100').e164).toBe('+15555550100');
    expect(phoneParts('1-555-555-0100').area).toBe('555');
  });

  test('other numbers keep their digits and get E.164 only with a plus', () => {
    const uk = phoneParts('+44 20 7946 0958');
    expect(uk.e164).toBe('+442079460958');
    expect(uk.area).toBeNull();
    expect(phoneParts('7946 0958').e164).toBeNull();
  });

  test('phone display', () => {
    expect(phoneDisplay('+15555550100')).toBe('(555) 555-0100');
    expect(phoneDisplay('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });

  test('names and addresses read as one line', () => {
    expect(fullName({ first: 'Sam', middle: 'J.', last: 'Rivera' })).toBe('Sam J. Rivera');
    expect(
      addressLine({
        line1: '12 Elm Street',
        line2: 'Apt 3',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62704',
        country: 'US',
      }),
    ).toBe('12 Elm Street, Apt 3, Springfield, IL 62704');
    expect(
      addressLine({
        line1: '1 High St',
        city: 'Leeds',
        region: 'West Yorkshire',
        postalCode: 'LS1 1AA',
        country: 'GB',
      }),
    ).toBe('1 High St, Leeds, West Yorkshire LS1 1AA, GB');
  });

  test('detail labels and display', () => {
    expect(detailLabel('home_address')).toBe('Home address');
    expect(detailLabel('custom:employer', { label: 'Employer', value: 'Acme' })).toBe('Employer');
    expect(detailLabel('custom:shoe-size')).toBe('shoe size');
    expect(detailDisplay('custom:employer', { label: 'Employer', value: 'Acme' })).toBe('Acme');
    expect(
      detailDisplay('emergency_contact', {
        name: 'Alex Rivera',
        phone: '+15555550111',
        relationship: 'Sister',
      }),
    ).toBe('Alex Rivera (Sister), (555) 555-0111');
  });

  test('an account name becomes a name value only with two or more words', () => {
    expect(nameFromAccount('Sam rivera')).toEqual({ first: 'Sam', last: 'rivera' });
    expect(nameFromAccount('Sam  Jo   Rivera')).toEqual({ first: 'Sam', middle: 'Jo', last: 'Rivera' });
    expect(nameFromAccount('Sam')).toBeNull();
    expect(nameFromAccount(null)).toBeNull();
  });
});
