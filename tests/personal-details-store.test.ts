import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  aboutUserBlock,
  customKeyFor,
  deletePersonalDetail,
  listPersonalDetails,
  missingDetailKeys,
  openDetail,
  PersonalDetailError,
  type PersonalDetailsDependencies,
  parseDetailValue,
  saveAnsweredDetails,
  savePersonalDetail,
  savePersonalDetails,
  sealDetail,
  undoPersonalDetailSave,
} from '../lib/personal-details/store';

// The store seals each value with its owner and key, keeps only ciphertext in
// Convex, and never logs a value (docs/albatross-thread.md).

const encrypt = (plaintext: string) => `v2.test.${Buffer.from(plaintext).toString('base64url')}`;
const decrypt = (payload: string) => {
  const [version, kid, body] = payload.split('.');
  if (version !== 'v2' || kid !== 'test' || !body) throw new Error('bad payload');
  return Buffer.from(body, 'base64url').toString('utf8');
};

type Row = { key: string; valueEncrypted: string; source: string; createdAt: number; updatedAt: number };

function fakeConvex(initial: Row[] = []) {
  const rows = new Map<string, Row>(initial.map((row) => [row.key, row]));
  const calls: Array<{ fn: string; args: any }> = [];
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const deps: Partial<PersonalDetailsDependencies> = {
    encrypt,
    decrypt,
    warn: (message, meta) => warnings.push({ message, meta }),
    convexQuery: (async (fn: any, args: any) => {
      calls.push({ fn: 'query', args });
      if (getFunctionName(fn) !== 'personalDetails:listForUser') throw new Error('unexpected query');
      return [...rows.values()];
    }) as any,
    convexMutation: (async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      calls.push({ fn: name === 'personalDetails:upsert' ? 'upsert' : name, args });
      if (name === 'personalDetails:upsert') {
        if (!rows.has(args.key) && rows.size >= 3)
          throw new Error('You keep the most personal details allowed.');
        rows.set(args.key, {
          key: args.key,
          valueEncrypted: args.valueEncrypted,
          source: args.source,
          createdAt: 1,
          updatedAt: 2,
        });
        return { created: true };
      }
      if (name === 'personalDetails:remove') return { removed: rows.delete(args.key) };
      if (name === 'personalDetails:undoSave') return { undone: 'restored' };
      throw new Error('unexpected mutation');
    }) as any,
  };
  return { rows, calls, warnings, deps };
}

const user = { userId: 'user_a', name: 'Sam rivera', email: 'sam.rivera@example.com' };

describe('sealing', () => {
  test('a sealed value opens only for its own user and key', () => {
    const sealed = sealDetail('user_a', 'phone', '+15555550100', encrypt);
    expect(openDetail('user_a', 'phone', sealed, decrypt)).toBe('+15555550100');
    expect(openDetail('user_b', 'phone', sealed, decrypt)).toBeNull();
    expect(openDetail('user_a', 'email', sealed, decrypt)).toBeNull();
    expect(openDetail('user_a', 'phone', 'garbage', decrypt)).toBeNull();
  });
});

describe('parseDetailValue', () => {
  test('a phone is stored as E.164 when it parses', () => {
    expect(parseDetailValue('phone', '(555) 555-0100')).toBe('+15555550100');
    expect(parseDetailValue('phone', '+44 20 7946 0958')).toBe('+442079460958');
  });

  test('an address with a US state and no country gets US', () => {
    expect(
      parseDetailValue('home_address', {
        line1: '12 Elm Street',
        city: 'Springfield',
        region: 'il',
        postalCode: '62704',
      }),
    ).toEqual({
      line1: '12 Elm Street',
      city: 'Springfield',
      region: 'IL',
      postalCode: '62704',
      country: 'US',
    });
  });

  test('an incomplete value names what to check, not the value', () => {
    try {
      parseDetailValue('home_address', { line1: '12 Elm Street', city: 'Springfield' });
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PersonalDetailError);
      expect((error as PersonalDetailError).code).toBe('invalid');
      expect((error as Error).message).not.toContain('Elm');
    }
  });

  test('a custom detail takes a plain string with a label and refuses secret labels', () => {
    expect(parseDetailValue('custom:employer', 'Acme', 'Employer')).toEqual({
      label: 'Employer',
      value: 'Acme',
    });
    expect(() => parseDetailValue('custom:ssn', '123456789', 'SSN')).toThrow(PersonalDetailError);
  });

  test('a card number is refused even in an emergency contact', () => {
    try {
      parseDetailValue('emergency_contact', { name: 'Alex', phone: '4242424242424242' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as PersonalDetailError).code).toBe('refused');
    }
  });

  test('custom keys are slugs of the label', () => {
    expect(customKeyFor('Preferred Airport')).toBe('custom:preferred-airport');
    expect(customKeyFor('   ')).toBeNull();
  });
});

describe('listPersonalDetails', () => {
  test('saved rows come first in catalog order, with account defaults for name and email', async () => {
    const { deps } = fakeConvex([
      {
        key: 'phone',
        valueEncrypted: sealDetail('user_a', 'phone', '+15555550100', encrypt),
        source: 'chat',
        createdAt: 1,
        updatedAt: 5,
      },
    ]);
    const details = await listPersonalDetails(user, deps);
    expect(details.map((entry) => [entry.key, entry.source, entry.saved])).toEqual([
      ['name', 'account', false],
      ['email', 'account', false],
      ['phone', 'chat', true],
    ]);
    expect(details[2].display).toBe('(555) 555-0100');
    expect(missingDetailKeys(details)).toEqual(['home_address', 'emergency_contact']);
  });

  test('a saved name replaces the account name', async () => {
    const { deps } = fakeConvex([
      {
        key: 'name',
        valueEncrypted: sealDetail('user_a', 'name', { first: 'Sam', last: 'Rivera' }, encrypt),
        source: 'settings',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const details = await listPersonalDetails(user, deps);
    expect(details.filter((entry) => entry.key === 'name')).toHaveLength(1);
    expect(details[0].display).toBe('Sam Rivera');
  });

  test('a row that does not open is left out and logged without its value', async () => {
    const { deps, warnings } = fakeConvex([
      {
        key: 'phone',
        valueEncrypted: sealDetail('user_b', 'phone', '+15555550100', encrypt),
        source: 'chat',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const details = await listPersonalDetails(user, deps);
    expect(details.some((entry) => entry.key === 'phone')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('555');
  });
});

describe('saving', () => {
  test('a save seals the normalized value and returns the view', async () => {
    const { deps, rows } = fakeConvex();
    const view = await savePersonalDetail(user, { key: 'phone', value: '555 555 0100' }, 'settings', deps);
    expect(view).toMatchObject({
      key: 'phone',
      label: 'Phone',
      display: '(555) 555-0100',
      source: 'settings',
      saved: true,
    });
    const row = rows.get('phone');
    expect(row?.valueEncrypted.startsWith('v2.test.')).toBe(true);
    expect(row?.valueEncrypted).not.toContain('555');
    expect(openDetail('user_a', 'phone', row?.valueEncrypted || '', decrypt)).toBe('+15555550100');
  });

  test('custom details resolve their key from the label', async () => {
    const { deps, rows } = fakeConvex();
    const view = await savePersonalDetail(
      user,
      { key: 'custom', label: 'Employer', value: 'Acme' },
      'chat',
      deps,
    );
    expect(view.key).toBe('custom:employer');
    expect(rows.has('custom:employer')).toBe(true);
  });

  test('an unknown key and the limit are typed errors', async () => {
    const { deps } = fakeConvex([
      { key: 'custom:a', valueEncrypted: 'x', source: 'chat', createdAt: 1, updatedAt: 1 },
      { key: 'custom:b', valueEncrypted: 'x', source: 'chat', createdAt: 1, updatedAt: 1 },
      { key: 'custom:c', valueEncrypted: 'x', source: 'chat', createdAt: 1, updatedAt: 1 },
    ]);
    await expect(savePersonalDetail(user, { key: 'ssn', value: '1' }, 'chat', deps)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      savePersonalDetail(user, { key: 'phone', value: '555 555 0100' }, 'chat', deps),
    ).rejects.toMatchObject({
      code: 'limit',
    });
  });

  test('saving several keeps going past a refusal', async () => {
    const { deps } = fakeConvex();
    const result = await savePersonalDetails(
      user,
      [
        { key: 'phone', value: '555 555 0100' },
        { key: 'custom', label: 'Passport', value: 'X1' },
        { key: 'email', value: 'sam.rivera@example.com' },
      ],
      'chat',
      deps,
    );
    expect(result.saved.map((entry) => entry.key)).toEqual(['phone', 'email']);
    expect(result.rejected).toEqual([
      { key: 'custom:passport', code: 'refused', message: expect.any(String) },
    ]);
  });

  test('a form answer skips values equal to the saved ones', async () => {
    const { deps, calls } = fakeConvex([
      {
        key: 'phone',
        valueEncrypted: sealDetail('user_a', 'phone', '+15555550100', encrypt),
        source: 'form',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const result = await saveAnsweredDetails(
      user,
      [
        { key: 'phone', value: '(555) 555-0100' },
        { key: 'email', value: 'sam.rivera@example.com' },
      ],
      deps,
    );
    expect(result.saved.map((entry) => entry.key)).toEqual(['email']);
    expect(calls.filter((call) => call.fn === 'upsert').map((call) => call.args.source)).toEqual(['form']);
  });

  test('delete and undo check the key first', async () => {
    const { deps } = fakeConvex([
      { key: 'phone', valueEncrypted: 'x', source: 'chat', createdAt: 1, updatedAt: 1 },
    ]);
    expect(await deletePersonalDetail(user, 'phone', deps)).toBe(true);
    expect(await undoPersonalDetailSave(user, 'phone', deps)).toBe('restored');
    await expect(deletePersonalDetail(user, 'password', deps)).rejects.toBeInstanceOf(PersonalDetailError);
  });
});

describe('aboutUserBlock', () => {
  test('it names saved details but carries no phone or address value', () => {
    const block = aboutUserBlock([
      {
        key: 'name',
        label: 'Name',
        value: { first: 'Sam', last: 'Rivera' },
        display: 'Sam Rivera',
        source: 'settings',
        saved: true,
        updatedAt: 1,
      },
      {
        key: 'email',
        label: 'Email',
        value: 'sam.rivera@example.com',
        display: 'sam.rivera@example.com',
        source: 'account',
        saved: false,
        updatedAt: null,
      },
      {
        key: 'phone',
        label: 'Phone',
        value: '+15555550100',
        display: '(555) 555-0100',
        source: 'chat',
        saved: true,
        updatedAt: 1,
      },
    ]);
    expect(block).toContain('Name: Sam Rivera');
    expect(block).toContain('Email: sam.rivera@example.com');
    expect(block).toContain('Phone');
    expect(block).not.toContain('555');
    expect(block).toContain('Not saved yet: Home address, Emergency contact.');
  });

  test('an account-only name is marked as not confirmed', () => {
    const block = aboutUserBlock([
      {
        key: 'name',
        label: 'Name',
        value: { first: 'Sam', last: 'rivera' },
        display: 'Sam rivera',
        source: 'account',
        saved: false,
        updatedAt: null,
      },
    ]);
    expect(block).toContain('not confirmed for forms');
  });
});
