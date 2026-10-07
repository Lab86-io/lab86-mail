import { describe, expect, test } from 'bun:test';
import { luhnValid, refuseDetail, refuseLabel, refuseValue } from '../lib/personal-details/policy';

// Personal details keep plain facts that the model may read. Secrets and ID
// numbers are refused by label and by value (docs/albatross-thread.md).

describe('personal details policy', () => {
  test('Luhn accepts real card shapes and rejects near misses', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('')).toBe(false);
    expect(luhnValid('42a2')).toBe(false);
  });

  test('labels that name secrets or ID numbers are refused', () => {
    expect(refuseLabel('Password')?.kind).toBe('password');
    expect(refuseLabel('One-time code')?.kind).toBe('code');
    expect(refuseLabel('PIN')?.kind).toBe('code');
    expect(refuseLabel('Credit card')?.kind).toBe('card');
    expect(refuseLabel('Routing number')?.kind).toBe('bank');
    expect(refuseLabel('Social Security number')?.kind).toBe('id_number');
    expect(refuseLabel("Driver's license")?.kind).toBe('id_number');
    expect(refuseLabel('Passport')?.kind).toBe('id_number');
    expect(refuseLabel('OpenAI API key')?.kind).toBe('api_key');
  });

  test('plain labels are allowed', () => {
    for (const label of ['Employer', 'T-shirt size', 'Preferred airport', 'Pronouns', 'Job title']) {
      expect(refuseLabel(label)).toBeNull();
    }
  });

  // Fake keys are joined from parts, so secret scanners do not report the test file.
  const fake = (...parts: string[]) => parts.join('');

  test('values shaped like secrets are refused even under a plain label', () => {
    expect(refuseValue('4242 4242 4242 4242')?.kind).toBe('card');
    expect(refuseValue('4242-4242-4242-4242')?.kind).toBe('card');
    expect(refuseValue('123-45-6789')?.kind).toBe('id_number');
    expect(refuseValue(fake('sk-', 'abcdefghijklmnop', 'qrstuvwxyz123456'))?.kind).toBe('api_key');
    expect(refuseValue(fake('AKIA', 'ABCDEFGHIJKLMNOP'))?.kind).toBe('api_key');
    expect(refuseValue(fake('ghp_', 'abcdefghijklmnopqrst', 'uvwxyz0123456789'))?.kind).toBe('api_key');
  });

  test('phones, postal codes, dates, and addresses are not refused', () => {
    for (const value of [
      '(555) 555-0100',
      '+1 555 555 0100',
      '+44 20 7946 0958',
      '62704',
      '62704-1234',
      '2026-10-19',
      '12 Elm Street, Apt 3',
      'Sam Rivera',
    ]) {
      expect(refuseValue(value)).toBeNull();
    }
  });

  test('refuseDetail reads the label first, then every string in a structured value', () => {
    expect(refuseDetail({ label: 'Passport', value: 'X1234567' })?.kind).toBe('id_number');
    expect(refuseDetail({ value: { line1: '12 Elm Street', city: 'Springfield' } })).toBeNull();
    expect(refuseDetail({ value: { name: 'Pat', phone: '4242424242424242' } })?.kind).toBe('card');
    expect(refuseDetail({ value: ['ok', '123-45-6789'] })?.kind).toBe('id_number');
  });

  test('refusal messages are user copy without the value', () => {
    const refusal = refuseValue('4242424242424242');
    expect(refusal?.message).toBe('Albatross does not keep card numbers.');
    expect(refusal?.message).not.toContain('4242');
  });
});
