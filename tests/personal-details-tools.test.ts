import { afterEach, describe, expect, test } from 'bun:test';
import {
  personalDetailsGet,
  personalDetailsSave,
  personalDetailsToolDeps,
} from '../lib/tools/personal-details';

// The personal details tools (docs/albatross-thread.md): the model reads
// values on the turns that need them, and saves only what the user stated.

const original = { ...personalDetailsToolDeps };
afterEach(() => Object.assign(personalDetailsToolDeps, original));

const details = [
  {
    key: 'name',
    label: 'Name',
    value: { first: 'Sam', last: 'Rivera' },
    display: 'Sam Rivera',
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
] as any[];

const ctx = {
  agent: 'ai' as const,
  userId: 'user-1',
  userName: 'Sam Rivera',
  userEmail: 'sam.rivera@example.com',
};

describe('personal_details_get', () => {
  test('it returns values, confirmation, phone parts, and the missing keys', async () => {
    const calls: unknown[] = [];
    personalDetailsToolDeps.list = (async (user: unknown) => {
      calls.push(user);
      return details;
    }) as any;
    const result = await personalDetailsGet.handler(undefined, ctx);
    expect(result.details[0]).toMatchObject({ key: 'name', confirmed: false, display: 'Sam Rivera' });
    expect(result.details[1]).toMatchObject({
      key: 'phone',
      confirmed: true,
      phone: { e164: '+15555550100', area: '555', prefix: '555', line: '0100' },
    });
    expect(result.missing).toEqual(['email', 'home_address', 'emergency_contact']);
    expect(calls).toEqual([{ userId: 'user-1', name: 'Sam Rivera', email: 'sam.rivera@example.com' }]);
  });

  test('keys filter the details but not the missing list', async () => {
    personalDetailsToolDeps.list = (async () => details) as any;
    const result = await personalDetailsGet.handler({ keys: ['phone'] }, ctx);
    expect(result.details.map((entry: any) => entry.key)).toEqual(['phone']);
    expect(result.missing).toContain('email');
  });

  test('it needs a signed-in user', async () => {
    await expect(personalDetailsGet.handler(undefined, { agent: 'ai' })).rejects.toThrow(/signed-in/);
  });
});

describe('personal_details_save', () => {
  test('a chat save names what it saved and what it refused', async () => {
    const calls: unknown[][] = [];
    personalDetailsToolDeps.saveMany = (async (...args: unknown[]) => {
      calls.push(args);
      return {
        saved: [details[1]],
        rejected: [
          {
            key: 'custom:passport',
            code: 'refused',
            message: 'Albatross does not keep ID numbers in Personal details.',
          },
        ],
      };
    }) as any;
    const result = await personalDetailsSave.handler(
      {
        details: [
          { key: 'phone', value: '555 555 0100' },
          { key: 'custom', label: 'Passport', value: 'X1' },
        ],
      },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      saved: [{ key: 'phone', label: 'Phone', display: '(555) 555-0100' }],
      rejected: [
        { key: 'custom:passport', message: 'Albatross does not keep ID numbers in Personal details.' },
      ],
    });
    expect(calls[0]?.[2]).toBe('chat');
  });

  test('nothing saved is ok:false with the reasons as the message', async () => {
    personalDetailsToolDeps.saveMany = (async () => ({
      saved: [],
      rejected: [{ key: 'phone', code: 'invalid', message: 'Check Phone.' }],
    })) as any;
    const result = await personalDetailsSave.handler({ details: [{ key: 'phone', value: 'x' }] }, ctx);
    expect(result).toMatchObject({ ok: false, message: 'Check Phone.' });
  });

  test('an empty refusal list still explains', async () => {
    personalDetailsToolDeps.saveMany = (async () => ({ saved: [], rejected: [] })) as any;
    const result = await personalDetailsSave.handler({ details: [{ key: 'phone', value: 'x' }] }, ctx);
    expect(result.message).toBe('Nothing was saved.');
  });
});
