import { describe, expect, test } from 'bun:test';
import { AgentBrowser, type AgentPage, secureFieldKind } from '../lib/albatross/browser-agent';
import type { SecureItemView } from '../lib/secure/contract';
import { findReferences } from '../lib/secure/policy';
import {
  createSecureRunAccess,
  SecureLeak,
  SecureNeedsAllow,
  SecureRefused,
} from '../lib/secure/runner-access';
import type { OpenedItem } from '../lib/secure/store';

// A run uses a saved value without the model seeing it (docs/albatross-secure-store.md).

const join = (...parts: string[]) => parts.join('');
const password = join('hunter', '-22-', 'sam');
const license = 'D1234821';

function item(
  id: string,
  kind: SecureItemView['kind'],
  label: string,
  sites: string[],
  facts = {},
): SecureItemView {
  return { id, kind, label, sites, hints: {}, facts, createdAt: 1, updatedAt: 1, lastUsedAt: null };
}

const CHASE = item('si_chase00000000000000000', 'sign_in', 'Chase', ['chase.com']);
const LICENSE = item('si_licen00000000000000000', 'id_number', "Driver's license", [], {
  type: 'drivers_license',
});
const SSN = item('si_ssn0000000000000000000', 'id_number', 'Social Security number', ['irs.gov'], {
  type: 'ssn',
});
const DOB = item('si_dob0000000000000000000', 'date_of_birth', 'Date of birth', []);
const KEY = item('si_key0000000000000000000', 'api_key', 'OpenAI', ['api.openai.com']);

function access(options: { granted?: boolean } = {}) {
  const uses: any[] = [];
  const log: string[] = [];
  const grants: any[] = [];
  const run = createSecureRunAccess({
    userId: 'user_1',
    runId: 'run_1',
    workId: 'work_1',
    stepKey: 'step_2',
    log: async (line) => {
      log.push(line);
    },
    deps: {
      openItems: async () =>
        [
          { item: CHASE, values: { username: 'sam.rivera@example.com', password } },
          { item: LICENSE, values: { number: license, expires: '2029-06-30' } },
          { item: SSN, values: { number: join('123', '45', '6789') } },
          { item: DOB, values: { date: '1990-04-02' } },
          { item: KEY, values: { key: join('sk-', 'abcdefghijklmnop', 'f3a2') } },
        ] as OpenedItem[],
      recordUse: async (use: any) => {
        uses.push(use);
      },
      hasGrant: async (input: any) => {
        grants.push(input);
        return Boolean(options.granted) && (input.site === 'ny.gov' || input.site === 'irs.gov');
      },
    },
  });
  return { run, uses, log, grants };
}

const ref = (text: string) => findReferences(text)[0];

describe('resolveForField', () => {
  test('a sign-in types on its own site and logs one line for the pair', async () => {
    const { run, uses, log } = access();
    const user = await run.resolveForField({
      reference: ref(`{{secure:${CHASE.id}.username}}`),
      fieldUrl: 'https://secure.chase.com/login',
      fieldKind: 'plain',
    });
    const pass = await run.resolveForField({
      reference: ref(`{{secure:${CHASE.id}.password}}`),
      fieldUrl: 'https://secure.chase.com/login',
      fieldKind: 'password',
    });
    expect(user).toEqual({ value: 'sam.rivera@example.com', label: 'Chase username' });
    expect(pass).toEqual({ value: password, label: 'Chase password' });
    expect(uses.map((use) => [use.outcome, use.field, use.site, use.host])).toEqual([
      ['typed', 'username', 'chase.com', 'secure.chase.com'],
      ['typed', 'password', 'chase.com', 'secure.chase.com'],
    ]);
    expect(log).toEqual(['Typed your saved Chase sign-in on secure.chase.com.']);
    expect(JSON.stringify(log)).not.toContain(password);
  });

  test('a sign-in on a look-alike site is refused, recorded, and logged without the value', async () => {
    const { run, uses, log } = access();
    const attempt = run.resolveForField({
      reference: ref(`{{secure:${CHASE.id}.password}}`),
      fieldUrl: 'https://chase.com.secure-login.example/',
      fieldKind: 'password',
    });
    await expect(attempt).rejects.toBeInstanceOf(SecureRefused);
    await expect(attempt).rejects.toThrow(/saved for chase.com, not chase.com.secure-login.example/);
    expect(uses[0]).toMatchObject({ outcome: 'refused_site', host: 'chase.com.secure-login.example' });
    expect(log[0]).toContain('Did not use your saved Chase');
  });

  test('field rules: passwords only into password fields; codes, cards, and new passwords never', async () => {
    const { run } = access();
    const cases: Array<[string, Parameters<typeof run.resolveForField>[0]['fieldKind'], RegExp]> = [
      [`{{secure:${CHASE.id}.password}}`, 'plain', /only into a password field/],
      [`{{secure:${LICENSE.id}.number}}`, 'password', /Only a saved sign-in password/],
      [`{{secure:${CHASE.id}.password}}`, 'code', /sign-in codes and card data/],
      [`{{secure:${CHASE.id}.password}}`, 'card', /sign-in codes and card data/],
      [`{{secure:${CHASE.id}.password}}`, 'new_password', /sets a new password/],
      [`{{secure:${LICENSE.id}.number}}`, 'ssn', /Social Security number/],
      [`{{secure:${KEY.id}.key}}`, 'plain', /never typed on a page/],
      [`{{secure:si_missing00000000000000.number}}`, 'plain', /No saved item/],
      [`{{secure:${CHASE.id}.number}}`, 'plain', /has no field "number"/],
      [`{{secure:${LICENSE.id}.name_on_id}}`, 'plain', /has no saved name on the id/],
    ];
    for (const [text, fieldKind, message] of cases)
      await expect(
        run.resolveForField({ reference: ref(text), fieldUrl: 'https://secure.chase.com/', fieldKind }),
      ).rejects.toThrow(message);
  });

  test('only https public pages', async () => {
    const { run } = access();
    for (const [url, message] of [
      ['http://secure.chase.com/', /https/],
      ['https://192.168.1.5/', /public sites/],
      ['not a url', /no address/],
    ] as const)
      await expect(
        run.resolveForField({
          reference: ref(`{{secure:${CHASE.id}.username}}`),
          fieldUrl: url,
          fieldKind: 'plain',
        }),
      ).rejects.toThrow(message);
  });

  test('an ID on a new site asks once and builds the allow request; a grant lets it type', async () => {
    const { run, uses, log, grants } = access();
    const number = run.resolveForField({
      reference: ref(`{{secure:${LICENSE.id}.number}}`),
      fieldUrl: 'https://dmv.ny.gov/renew',
      fieldKind: 'plain',
    });
    await expect(number).rejects.toBeInstanceOf(SecureNeedsAllow);
    await expect(
      run.resolveForField({
        reference: ref(`{{secure:${LICENSE.id}.expires|MM/YYYY}}`),
        fieldUrl: 'https://dmv.ny.gov/renew',
        fieldKind: 'plain',
      }),
    ).rejects.toThrow(/not allowed on ny.gov yet/);
    expect(run.pendingAllow()).toEqual({
      itemId: LICENSE.id,
      kind: 'id_number',
      itemLabel: "Driver's license",
      fieldLabels: ['Number', 'Expiry date'],
      site: 'ny.gov',
      host: 'dmv.ny.gov',
    });
    expect(uses.filter((use) => use.outcome === 'asked')).toHaveLength(1);
    expect(log).toEqual(["Asked you to allow your saved Driver's license on ny.gov."]);
    expect(grants[0]).toEqual({
      userId: 'user_1',
      itemId: LICENSE.id,
      site: 'ny.gov',
      workId: 'work_1',
      stepKey: 'step_2',
    });

    const granted = access({ granted: true });
    expect(
      await granted.run.resolveForField({
        reference: ref(`{{secure:${LICENSE.id}.expires|MM/YYYY}}`),
        fieldUrl: 'https://dmv.ny.gov/renew',
        fieldKind: 'plain',
      }),
    ).toEqual({ value: '06/2029', label: "Driver's license expiry date" });
    expect(granted.run.pendingAllow()).toBeNull();
  });

  test('an SSN goes into an SSN field on its site, in split parts; a bad format is refused', async () => {
    const { run } = access();
    const area = await run.resolveForField({
      reference: ref(`{{secure:${SSN.id}.number|AREA}}`),
      fieldUrl: 'https://sa.www4.irs.gov/x',
      fieldKind: 'ssn',
    });
    expect(area.value).toBe('123');
    await expect(
      run.resolveForField({
        reference: ref(`{{secure:${DOB.id}.date|YY}}`),
        fieldUrl: 'https://irs.gov',
        fieldKind: 'plain',
      }),
    ).rejects.toBeInstanceOf(SecureNeedsAllow);
    const granted = access({ granted: true });
    await expect(
      granted.run.resolveForField({
        reference: ref(`{{secure:${DOB.id}.date|QQ}}`),
        fieldUrl: 'https://irs.gov',
        fieldKind: 'plain',
      }),
    ).rejects.toThrow(/date format/);
  });

  test('a page shows the values saved for its own site removed; usernames stay', async () => {
    const { run } = access();
    const [chase] = await run.cleanPage('https://secure.chase.com/account', [
      `pw ${password} user sam.rivera@example.com`,
    ]);
    expect(chase).toBe('pw [secure: Chase] user sam.rivera@example.com');
    const [irs] = await run.cleanPage('https://www.irs.gov/x', ['SSN 123-45-6789 on file']);
    expect(irs).toBe('SSN [secure: Social Security number] on file');
  });

  test('no oracle: a page outside the sites of an item never learns which guess is right', async () => {
    const { run } = access();
    // A hostile page lists candidate birth dates; none of them is replaced, so nothing tells.
    const candidates = ['1990-04-01', '1990-04-02', '1990-04-03'].join(' ');
    expect(await run.cleanPage('https://quiz.example.net/', [candidates])).toEqual([candidates]);
    expect(await run.cleanPage('https://quiz.example.net/', [`pw ${password}`])).toEqual([`pw ${password}`]);
  });

  test('a value this run typed shows only on its sites; elsewhere the run stops', async () => {
    const { run, uses, log } = access({ granted: true });
    await run.resolveForField({
      reference: ref(`{{secure:${LICENSE.id}.number}}`),
      fieldUrl: 'https://dmv.ny.gov/renew',
      fieldKind: 'plain',
    });
    // On the site where it was allowed and typed, it is removed.
    expect(await run.cleanPage('https://dmv.ny.gov/review', [`License ${license}`])).toEqual([
      "License [secure: Driver's license]",
    ]);
    // On another site, it stops the run, records the refusal, and logs it.
    const leak = run.cleanPage('https://pay.example.net/', [`Account ${license.toLowerCase()}`]);
    await expect(leak).rejects.toBeInstanceOf(SecureLeak);
    expect(uses.at(-1)).toMatchObject({ outcome: 'refused_site', host: 'pay.example.net' });
    expect(log.at(-1)).toBe(
      "Stopped: pay.example.net showed your saved Driver's license. You have the page.",
    );
    expect(run.cleanText(`echo ${license}`)).toBe("echo [secure: Driver's license]");
  });

  test('a short typed value is masked in its field line, whatever the ref', async () => {
    const { run } = access({ granted: true });
    await run.resolveForField({
      reference: ref(`{{secure:${LICENSE.id}.expires|MM/YYYY}}`),
      fieldUrl: 'https://dmv.ny.gov/renew',
      fieldKind: 'plain',
    });
    const [snapshot] = await run.cleanPage('https://dmv.ny.gov/renew', [
      [
        '- textbox "Expiry, 7 characters" [ref=e9]: 06/2029',
        '- textbox "Plate" [ref=e3]: ABC 1234',
        '- combobox "Month":',
        '  - option "06/2029" [selected]',
      ].join('\n'),
    ]);
    expect(snapshot).toBe(
      [
        '- textbox "Expiry, 7 characters" [ref=e9]: [secure: Driver\'s license]',
        '- textbox "Plate" [ref=e3]: ABC 1234',
        '- combobox "Month":',
        '  - option "06/2029"',
      ].join('\n'),
    );
  });

  test('a form that sends to another site is refused, even on a saved site', async () => {
    const { run, uses } = access();
    await expect(
      run.resolveForField({
        reference: ref(`{{secure:${CHASE.id}.password}}`),
        fieldUrl: 'https://community.chase.com/post/1',
        fieldKind: 'password',
        formUrl: 'https://collect.example.net/steal',
      }),
    ).rejects.toThrow(/sends to collect.example.net/);
    expect(uses.at(-1)).toMatchObject({ outcome: 'refused_site', host: 'collect.example.net' });
    expect(
      await run.resolveForField({
        reference: ref(`{{secure:${CHASE.id}.password}}`),
        fieldUrl: 'https://secure.chase.com/login',
        fieldKind: 'password',
        formUrl: 'https://auth.chase.com/session',
      }),
    ).toMatchObject({ label: 'Chase password' });
  });

  test('a key goes only to its API host; the sign-in offer appears only when no sign-in covers the page', async () => {
    const { run, uses, log } = access();
    expect(
      (
        await run.resolveForFetch({
          reference: ref(`{{secure:${KEY.id}.key}}`),
          url: 'https://api.openai.com/v1/models',
        })
      ).label,
    ).toBe('OpenAI key');
    await expect(
      run.resolveForFetch({ reference: ref(`{{secure:${KEY.id}.key}}`), url: 'https://openai.com/' }),
    ).rejects.toThrow(/not openai.com/);
    await expect(
      run.resolveForFetch({ reference: ref(`{{secure:${CHASE.id}.password}}`), url: 'https://chase.com/' }),
    ).rejects.toThrow(/only a saved API key/);
    expect(uses.map((use) => use.outcome)).toEqual(['sent', 'refused_site']);
    expect(log[0]).toBe('Called api.openai.com with your saved OpenAI key.');
    expect(await run.signInOffer('https://secure.chase.com/login')).toBeNull();
    expect(await run.signInOffer('https://pay.springfieldwater.gov/login')).toEqual({
      site: 'springfieldwater.gov',
    });
    expect(await run.signInOffer('nope')).toBeNull();
  });
});

describe('secureFieldKind', () => {
  test('reads type, autocomplete, and the accessible name', () => {
    expect(secureFieldKind({ role: 'textbox', name: 'Password' }, { type: 'password' })).toBe('password');
    expect(
      secureFieldKind(
        { role: 'textbox', name: 'New password' },
        { type: 'password', autocomplete: 'new-password' },
      ),
    ).toBe('new_password');
    expect(secureFieldKind({ role: 'textbox', name: 'Confirm password' }, { type: 'password' })).toBe(
      'new_password',
    );
    expect(secureFieldKind({ role: 'textbox', name: 'Code' }, { autocomplete: 'one-time-code' })).toBe(
      'code',
    );
    expect(secureFieldKind({ role: 'textbox', name: 'Verification code' }, {})).toBe('code');
    expect(secureFieldKind({ role: 'textbox', name: 'Card number' }, {})).toBe('card');
    expect(secureFieldKind({ role: 'textbox', name: 'Name' }, { autocomplete: 'cc-name' })).toBe('card');
    expect(secureFieldKind({ role: 'textbox', name: 'SSN (last 4)' }, {})).toBe('ssn');
    expect(secureFieldKind({ role: 'textbox', name: 'Driver license ID' }, { type: 'text' })).toBe('plain');
    expect(secureFieldKind(null, null)).toBe('plain');
  });
});

/** A fake page: the snapshot shows each field's value, as Playwright does. */
function fakePage(url = 'https://dmv.ny.gov/renew', frames: Record<string, string> = {}) {
  const values: Record<string, string> = {};
  const fields: Record<string, { name: string; type?: string; role?: string }> = {
    e1: { name: 'Driver license ID' },
    e2: { name: 'Password', type: 'password' },
    e3: { name: 'Birth month', role: 'combobox' },
    e4: { name: 'Search', role: 'searchbox' },
  };
  const calls: string[] = [];
  const page: AgentPage = {
    goto: async () => undefined,
    url: () => url,
    title: async () => `Renew ${values.e1 ?? ''}`.trim(),
    snapshot: async () =>
      `${Object.entries(fields)
        .map(
          ([ref, field]) =>
            `- ${field.role ?? 'textbox'} "${field.name}" [ref=${ref}]${values[ref] ? `: ${values[ref]}` : ''}`,
        )
        .join('\n')}\n- paragraph: Your license ${license} is on file.`,
    click: async () => undefined,
    fill: async (ref, text) => {
      calls.push(`fill ${ref}`);
      values[ref] = text;
    },
    select: async (ref, picked) => {
      calls.push(`select ${ref}`);
      values[ref] = picked[0];
    },
    press: async (key) => {
      calls.push(`press ${key}`);
    },
    back: async () => undefined,
    wait: async () => undefined,
    inputKind: async (ref) =>
      ref === 'e9'
        ? null
        : { type: fields[ref]?.type ?? 'text', autocomplete: '', documentUrl: frames[ref] ?? url },
    text: async () => `License ${license} on file.`,
  };
  return { page, values, calls };
}

describe('AgentBrowser with saved values', () => {
  const browserFor = (granted = true, url?: string, frames?: Record<string, string>) => {
    const { run } = access({ granted });
    const fake = fakePage(url, frames);
    const browser = new AgentBrowser(fake.page, run);
    return { browser, ...fake };
  };

  test('a reference is typed and the model sees only labels', async () => {
    const { browser, values } = browserFor();
    await browser.snapshot();
    const view = await browser.type('e1', `{{secure:${LICENSE.id}.number}}`);
    expect(values.e1).toBe(license);
    expect(view.secure).toBe("Typed the saved Driver's license number.");
    expect(view.snapshot).toContain(`[ref=e1]: [secure: Driver's license number]`);
    expect(view.snapshot).not.toContain(license);
    expect(view.title).not.toContain(license);
    const text = await browser.readText();
    expect(text.text).not.toContain(license);
    expect(text.text).not.toContain(password);
  });

  test('a mix of text and a reference, Enter, and an unchecked field are refused', async () => {
    const { browser, calls } = browserFor();
    await browser.snapshot();
    await expect(browser.type('e1', `DL {{secure:${LICENSE.id}.number}}`)).rejects.toThrow(/goes in alone/);
    await expect(browser.type('e4', `{{secure:${LICENSE.id}.number}}`, true)).rejects.toThrow(
      /never submits/,
    );
    expect(calls).toEqual([]);
  });

  test('a field inside a frame is checked by its own address', async () => {
    const { browser, calls } = browserFor(true, 'https://dmv.ny.gov/renew', {
      e1: 'https://ads.example.net/frame',
    });
    await browser.snapshot();
    await expect(browser.type('e1', `{{secure:${LICENSE.id}.number}}`)).rejects.toBeInstanceOf(
      SecureNeedsAllow,
    );
    expect(calls).toEqual([]);
  });

  test('a select takes one reference', async () => {
    const { browser, values } = browserFor();
    await browser.snapshot();
    const view = await browser.select('e3', [`{{secure:${DOB.id}.date|MONTH}}`]);
    expect(values.e3).toBe('April');
    expect(view.snapshot).toContain('[ref=e3]: [secure: Date of birth]');
    await expect(browser.select('e3', [`{{secure:${DOB.id}.date|MM}}`, '05'])).rejects.toThrow(/alone/);
  });

  test('without the store, a reference is an error and secret fields keep the old rule', async () => {
    const fake = fakePage();
    const browser = new AgentBrowser(fake.page);
    await browser.snapshot();
    await expect(browser.type('e1', `{{secure:${LICENSE.id}.number}}`)).rejects.toThrow(/not available/);
    await expect(browser.type('e2', 'guess')).rejects.toThrow(/Only the user types it/);
    expect(await browser.cleanMessage('x')).toBe('x');
  });

  test('with the store, plain text into a password field points to a reference', async () => {
    const { browser } = browserFor();
    await browser.snapshot();
    await expect(browser.type('e2', 'guess')).rejects.toThrow(/\{\{secure:<id>\.<field>\}\}/);
  });
});

describe('field kinds and browser errors', () => {
  test('a text field named "Password" is not a password field', () => {
    expect(secureFieldKind({ role: 'textbox', name: 'Password' }, { type: 'text' })).toBe('plain');
    expect(
      secureFieldKind(
        { role: 'textbox', name: 'Password' },
        { type: 'text', autocomplete: 'current-password' },
      ),
    ).toBe('plain');
  });

  test('a fill that fails never passes the Playwright text, which quotes the value', async () => {
    const { run } = access({ granted: true });
    const fake = fakePage();
    fake.page.fill = async (_ref, text) => {
      throw new Error(`locator.fill: Timeout 12000ms exceeded. Call log: - fill("${text}")`);
    };
    const browser = new AgentBrowser(fake.page, run);
    await browser.snapshot();
    const attempt = browser.type('e1', `{{secure:${LICENSE.id}.expires|MM/YYYY}}`);
    await expect(attempt).rejects.toThrow(
      'The field did not take the saved value. Hand this field to the user.',
    );
    await expect(attempt).rejects.not.toThrow(/06\/2029/);
  });
});
