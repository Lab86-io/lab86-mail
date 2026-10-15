import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkSavedFileSend,
  type MaterializePurpose,
  materializeDeps,
  materializeSavedFile,
  SealedFileError,
  SealedFileNeedsAllow,
  SealedFileNeedsCheck,
} from '../lib/files/materialize';
import { fillPdfForm, readPdfFormFields } from '../lib/files/pdf-forms';
import {
  __setSavedFileReadDepsForTest,
  getSavedFileRow,
  isPdfFile,
  readSavedFileBytes,
  SavedFileError,
  type SavedFileRow,
} from '../lib/files/saved-files';
import {
  checkSealedReference,
  recipientDomains,
  sealedValueLength,
  wholeReference,
} from '../lib/files/sealed-fields';
import type { SecureItemView } from '../lib/secure/contract';
import type { OpenedItem } from '../lib/secure/store';

// Invented data only: a placeholder Social Security number and example domains.
const SSN = '000123456';
const W9 = new Uint8Array(readFileSync(path.join(import.meta.dir, 'fixtures/irs-fw9-2024-03.pdf')));
const P = 'topmostSubform[0].Page1[0].';
const SSN_ITEM = 'si_ssn_000000000000000001';
const DOB_ITEM = 'si_dob_000000000000000001';
const KEY_ITEM = 'si_key_000000000000000001';

function view(id: string, overrides: Partial<SecureItemView>): SecureItemView {
  return {
    id,
    kind: 'id_number',
    label: 'Social Security number',
    sites: [],
    hints: { number: 'ends 3456' },
    facts: { type: 'ssn' },
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

// "Always for mail to example.com" is a send grant; `sites` is for pages and never allows a send.
const ssnView = (mailDomains: string[] = ['example.com'], sites: string[] = []) =>
  view(SSN_ITEM, { mailDomains, sites });
const SEND_KEY = 'outbox:00000000-0000-4000-8000-000000000001';
const dobView = view(DOB_ITEM, {
  kind: 'date_of_birth',
  label: 'Date of birth',
  hints: { date: 'saved' },
  facts: {},
});
const keyView = view(KEY_ITEM, { kind: 'api_key', label: 'OpenAI', hints: { key: 'sk-…0000' }, facts: {} });

const sealedFields = [
  { field: `${P}f1_11[0]`, ref: `{{secure:${SSN_ITEM}.number|AREA}}` },
  { field: `${P}f1_12[0]`, ref: `{{secure:${SSN_ITEM}.number|GROUP}}` },
  { field: `${P}f1_13[0]`, ref: `{{secure:${SSN_ITEM}.number|SERIAL}}` },
];

async function sealedW9() {
  return (
    await fillPdfForm(W9, {
      values: { [`${P}f1_01[0]`]: 'Sam Rivera' },
      sealed: sealedFields.map(({ field }) => ({ field })),
    })
  ).bytes;
}

function row(overrides: Partial<SavedFileRow> = {}): SavedFileRow {
  return {
    _id: 'upload_1',
    userId: 'u1',
    storageId: 'storage_1',
    name: 'fw9 (filled).pdf',
    contentType: 'application/pdf',
    size: 100,
    createdAt: 1,
    origin: 'filled',
    url: 'https://storage.example.test/1',
    ...overrides,
  };
}

function deps(
  options: {
    row?: SavedFileRow | null;
    bytes?: Uint8Array;
    items?: OpenedItem[];
    enabled?: boolean;
    grants?: Array<{ itemId: string; domain: string; sendKey: string }>;
  } = {},
) {
  const uses: Array<Record<string, unknown>> = [];
  const items = options.items ?? [{ item: ssnView(), values: { number: SSN } }];
  return {
    uses,
    deps: {
      ...materializeDeps,
      getFile: async () => (options.row === undefined ? row({ sealedFields }) : options.row),
      readBytes: async () => options.bytes ?? new Uint8Array([1, 2, 3]),
      enabled: () => options.enabled ?? true,
      listItems: async () => items.map((entry) => entry.item),
      openItems: async () => items,
      recordUse: async (use: Record<string, unknown>) => {
        uses.push(use);
      },
      sendGrantCovers: async (input: { itemId: string; domain: string; sendKey: string }) =>
        (options.grants ?? []).some(
          (grant) =>
            grant.itemId === input.itemId && grant.domain === input.domain && grant.sendKey === input.sendKey,
        ),
    } as unknown as typeof materializeDeps,
  };
}

afterEach(() => __setSavedFileReadDepsForTest());

describe('sealed references', () => {
  test('a reference is the whole value, or there is none', () => {
    expect(wholeReference('Sam Rivera')).toBeNull();
    expect(wholeReference(` {{secure:${SSN_ITEM}.number|AREA}} `)).toMatchObject({
      itemId: SSN_ITEM,
      field: 'number',
      format: 'AREA',
    });
    expect(() => wholeReference(`SSN {{secure:${SSN_ITEM}.number}}`)).toThrow('one whole reference');
    expect(() => wholeReference('{{ secure: broken }}')).toThrow('one whole reference');
  });

  test('the item, its kind, its saved field, and the format are checked without a value', () => {
    const items = [
      ssnView(),
      dobView,
      keyView,
      view('si_dl_00000000000000000001', {
        label: "Driver's license",
        facts: { type: 'drivers_license' },
        hints: { number: 'ends 1234', expires: 'saved' },
      }),
    ];
    const check = (raw: string) => checkSealedReference(wholeReference(raw)!, items);
    expect(check(`{{secure:${SSN_ITEM}.number|AREA}}`)).toEqual({
      ok: true,
      label: 'Social Security number number',
      length: 3,
    });
    expect(check(`{{secure:${SSN_ITEM}.number}}`)).toMatchObject({ ok: true, length: 9 });
    expect(check(`{{secure:${DOB_ITEM}.date|MM/DD/YYYY}}`)).toMatchObject({ ok: true, length: 10 });
    expect(check('{{secure:si_missing_0000000000001.number}}')).toMatchObject({ ok: false });
    expect(check(`{{secure:${KEY_ITEM}.key}}`)).toEqual({
      ok: false,
      message: 'A saved password or key never goes into a PDF. Leave the field for the user.',
    });
    expect(check(`{{secure:${SSN_ITEM}.expires}}`)).toMatchObject({ ok: false });
    expect(check(`{{secure:${SSN_ITEM}.number|MONTH}}`)).toMatchObject({ ok: false });
    expect(check(`{{secure:${DOB_ITEM}.date|DIGITS}}`)).toMatchObject({ ok: false });
    expect(check('{{secure:si_dl_00000000000000000001.number|AREA}}')).toEqual({
      ok: false,
      message: 'AREA works only for a Social Security number.',
    });
    expect(check('{{secure:si_dl_00000000000000000001.number|LAST4}}')).toMatchObject({
      ok: true,
      length: 4,
    });
    expect(check('{{secure:si_dl_00000000000000000001.expires|MM/YYYY}}')).toMatchObject({
      ok: true,
      length: 7,
    });
  });

  test('lengths and recipient domains', () => {
    expect(sealedValueLength('date_of_birth', 'date', 'MM', null)).toBe(2);
    expect(sealedValueLength('date_of_birth', 'date', 'YYYY', null)).toBe(4);
    expect(sealedValueLength('date_of_birth', 'date', 'MONTH', null)).toBeNull();
    expect(sealedValueLength('id_number', 'number', 'DASHED', 'ssn')).toBe(11);
    expect(sealedValueLength('id_number', 'number', 'GROUP', 'ssn')).toBe(2);
    expect(sealedValueLength('id_number', 'number', null, 'passport')).toBeNull();
    expect(
      recipientDomains(['Billing <billing@Example.com>, ap@pay.example.org', undefined, 'x@example.com']),
    ).toEqual(['example.com', 'pay.example.org']);
    // Fail closed: one recipient that the check cannot read stops the whole send.
    expect(recipientDomains(['ap@example.com, "a b"@attacker.example'])).toBeNull();
    expect(recipientDomains(['ap@example.com; b@attacker.example'])).toBeNull();
    expect(recipientDomains(['x <ap@example.com> <b@attacker.example>'])).toBeNull();
    expect(recipientDomains(['x@example.com.'])).toBeNull();
    expect(recipientDomains(['not an address'])).toBeNull();
    expect(recipientDomains([undefined, ''])).toEqual([]);
  });
});

describe('saved file reads', () => {
  test('the row belongs to the user, and a bad id is no file', async () => {
    __setSavedFileReadDepsForTest({
      convexQuery: (async (_fn: unknown, args: Record<string, unknown>) => {
        if (args.uploadId === 'bad') throw new Error('ArgumentValidationError');
        return args.uploadId === 'theirs' ? row({ userId: 'u2' }) : row({ _id: args.uploadId as string });
      }) as any,
    });
    expect((await getSavedFileRow('u1', 'upload_9'))?._id).toBe('upload_9');
    expect(await getSavedFileRow('u1', 'theirs')).toBeNull();
    expect(await getSavedFileRow('u1', 'bad')).toBeNull();
    expect(await getSavedFileRow('u1', '')).toBeNull();
    expect(await getSavedFileRow('', 'x')).toBeNull();
  });

  test('bytes come from storage, at most 25 MB, without redirects', async () => {
    const calls: RequestInit[] = [];
    __setSavedFileReadDepsForTest({
      fetch: async (_url, init) => {
        calls.push(init);
        return new Response(new Uint8Array([7, 8, 9]));
      },
    });
    expect([...(await readSavedFileBytes(row()))]).toEqual([7, 8, 9]);
    expect(calls[0].redirect).toBe('error');
    await expect(readSavedFileBytes(row({ url: null }))).rejects.toBeInstanceOf(SavedFileError);
    await expect(readSavedFileBytes(row({ size: 26 * 1024 * 1024 }))).rejects.toThrow('larger than 25 MB');
    __setSavedFileReadDepsForTest({ fetch: async () => new Response('no', { status: 404 }) });
    await expect(readSavedFileBytes(row())).rejects.toThrow('could not be read');
    __setSavedFileReadDepsForTest({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(13 * 1024 * 1024));
            },
          }),
        ),
    });
    await expect(readSavedFileBytes(row())).rejects.toThrow('larger than 25 MB');
    expect(isPdfFile({ name: 'a.PDF' })).toBe(true);
    expect(isPdfFile({ name: 'a', contentType: 'application/pdf' })).toBe(true);
    expect(isPdfFile({ name: 'a.docx' })).toBe(false);
  });
});

describe('materializeSavedFile', () => {
  test('a plain file comes back as it is stored, for any purpose', async () => {
    const { deps: d, uses } = deps({ row: row({ name: 'notes.txt', contentType: undefined }) });
    const file = await materializeSavedFile('u1', 'upload_1', { kind: 'download', checked: false }, d);
    expect(file).toMatchObject({ name: 'notes.txt', contentType: 'application/octet-stream', sealed: false });
    expect(uses).toEqual([]);
  });

  test('a send fills the sealed fields in memory for allowed recipients, and records each use', async () => {
    const log = spyOn(console, 'log');
    const warn = spyOn(console, 'warn');
    const error = spyOn(console, 'error');
    try {
      const { deps: d, uses } = deps({ bytes: await sealedW9() });
      const purpose: MaterializePurpose = {
        kind: 'send',
        recipients: ['Pay <ap@example.com>', 'cc@mail.example.com'],
        workId: 'w1',
      };
      const file = await materializeSavedFile('u1', 'upload_1', purpose, d);
      expect(file).toMatchObject({ name: 'fw9 (filled).pdf', contentType: 'application/pdf', sealed: true });
      const fields = new Map(
        (await readPdfFormFields(file.bytes, { pageText: async () => new Map() })).map((field) => [
          field.name.replace(P, ''),
          field.value,
        ]),
      );
      expect([fields.get('f1_11[0]'), fields.get('f1_12[0]'), fields.get('f1_13[0]')]).toEqual([
        '000',
        '12',
        '3456',
      ]);
      expect(fields.get('f1_01[0]')).toBe('Sam Rivera');
      expect(uses).toEqual([
        {
          userId: 'u1',
          itemId: SSN_ITEM,
          field: 'number',
          outcome: 'sent',
          site: 'example.com',
          host: 'example.com',
          workId: 'w1',
        },
        {
          userId: 'u1',
          itemId: SSN_ITEM,
          field: 'number',
          outcome: 'sent',
          site: 'example.com',
          host: 'mail.example.com',
          workId: 'w1',
        },
      ]);
      // Nothing logged a value.
      const logged = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
      expect(logged).not.toContain(SSN);
      expect(logged).not.toContain('3456');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('a send to a mail domain with no send grant is blocked before any fill', async () => {
    const { deps: d, uses } = deps({ items: [{ item: ssnView(['example.com']), values: { number: SSN } }] });
    const error = (await materializeSavedFile(
      'u1',
      'upload_1',
      { kind: 'send', recipients: ['ap@example.com, someone@other.example.org'] },
      d,
    ).catch((caught) => caught)) as SealedFileNeedsAllow;
    expect(error).toBeInstanceOf(SealedFileNeedsAllow);
    expect(error.code).toBe('needs_allow');
    expect(error.grant).toBe('send');
    expect(error.domains).toEqual(['example.org']);
    expect(error.needs).toEqual([
      {
        itemId: SSN_ITEM,
        itemLabel: 'Social Security number',
        fieldLabels: ['Number'],
        domains: ['example.org'],
      },
    ]);
    expect(error.message).toBe(
      'This file has your saved Social Security number. Before it goes in mail to example.org, allow it for this send or for all mail to that domain.',
    );
    expect(error.message).not.toContain(SSN);
    expect(uses).toEqual([]);
    // The same check without a fill, for a held send.
    await expect(
      checkSavedFileSend('u1', 'upload_1', ['someone@other.example.org'], undefined, d),
    ).rejects.toBeInstanceOf(SealedFileNeedsAllow);
    expect(await checkSavedFileSend('u1', 'upload_1', ['ap@example.com'], undefined, d)).toBe(true);
    const plain = deps({ row: row() });
    expect(await checkSavedFileSend('u1', 'upload_1', ['x@y.example'], undefined, plain.deps)).toBe(false);
    await expect(checkSavedFileSend('u1', 'upload_1', [], undefined, d)).rejects.toMatchObject({
      code: 'invalid',
    });
    // A recipient the check cannot read stops the send before any value is opened.
    await expect(
      checkSavedFileSend('u1', 'upload_1', ['ap@example.com, "a b"@attacker.example'], undefined, d),
    ).rejects.toMatchObject({ code: 'invalid', message: 'Check the recipient addresses.' });
  });

  test('a site grant never allows a send: the item is saved for example.org pages, not mail', async () => {
    const { deps: d } = deps({
      bytes: await sealedW9(),
      items: [{ item: ssnView([], ['example.org']), values: { number: SSN } }],
    });
    await expect(
      materializeSavedFile('u1', 'upload_1', { kind: 'send', recipients: ['ap@example.org'] }, d),
    ).rejects.toBeInstanceOf(SealedFileNeedsAllow);
  });

  test('"Allow for this send" covers its send key only', async () => {
    const options = {
      bytes: await sealedW9(),
      items: [{ item: ssnView([]), values: { number: SSN } }],
      grants: [{ itemId: SSN_ITEM, domain: 'example.org', sendKey: SEND_KEY }],
    };
    const send = (sendKey?: string) =>
      materializeSavedFile(
        'u1',
        'upload_1',
        { kind: 'send', recipients: ['ap@billing.example.org'], ...(sendKey ? { sendKey } : {}) },
        deps(options).deps,
      );
    expect((await send(SEND_KEY)).sealed).toBe(true);
    await expect(send()).rejects.toBeInstanceOf(SealedFileNeedsAllow);
    await expect(send('outbox:00000000-0000-4000-8000-000000000002')).rejects.toBeInstanceOf(
      SealedFileNeedsAllow,
    );
    expect(await checkSavedFileSend('u1', 'upload_1', ['ap@example.org'], SEND_KEY, deps(options).deps)).toBe(
      true,
    );
  });

  test('a download needs the check, then fills and records the download', async () => {
    const { deps: d, uses } = deps({ bytes: await sealedW9() });
    await expect(
      materializeSavedFile('u1', 'upload_1', { kind: 'download', checked: false }, d),
    ).rejects.toBeInstanceOf(SealedFileNeedsCheck);
    expect(uses).toEqual([]);
    const file = await materializeSavedFile('u1', 'upload_1', { kind: 'download', checked: true }, d);
    expect(file.sealed).toBe(true);
    expect(uses).toEqual([{ userId: 'u1', itemId: SSN_ITEM, field: 'number', outcome: 'downloaded' }]);
  });

  test('a missing file, a store that is off, and a gone item stop with plain copy', async () => {
    await expect(
      materializeSavedFile('u1', 'x', { kind: 'download', checked: true }, deps({ row: null }).deps),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      materializeSavedFile('u1', 'x', { kind: 'download', checked: true }, deps({ enabled: false }).deps),
    ).rejects.toMatchObject({ code: 'off' });
    await expect(
      materializeSavedFile('u1', 'x', { kind: 'download', checked: true }, deps({ items: [] }).deps),
    ).rejects.toMatchObject({ code: 'gone' });
    await expect(
      materializeSavedFile(
        'u1',
        'x',
        { kind: 'send', recipients: ['a@example.com'] },
        deps({ items: [] }).deps,
      ),
    ).rejects.toMatchObject({ code: 'gone' });
    await expect(
      checkSavedFileSend('u1', 'x', ['a@example.com'], undefined, deps({ items: [] }).deps),
    ).rejects.toMatchObject({
      code: 'gone',
    });
    // An item without the saved field, a broken reference, and a value that does not fit the form.
    const noValue = deps({ items: [{ item: ssnView(), values: {} }] });
    await expect(
      materializeSavedFile('u1', 'x', { kind: 'download', checked: true }, noValue.deps),
    ).rejects.toMatchObject({ code: 'gone' });
    const broken = deps({ row: row({ sealedFields: [{ field: 'a', ref: 'not a ref' }] }) });
    await expect(
      materializeSavedFile('u1', 'x', { kind: 'download', checked: true }, broken.deps),
    ).rejects.toMatchObject({ code: 'gone' });
    const badFormat = deps({
      row: row({ sealedFields: [{ field: `${P}f1_11[0]`, ref: `{{secure:${SSN_ITEM}.number|AREA}}` }] }),
      items: [
        {
          item: view(SSN_ITEM, { sites: ['example.com'], facts: { type: 'passport' } }),
          values: { number: SSN },
        },
      ],
    });
    await expect(
      materializeSavedFile('u1', 'x', { kind: 'download', checked: true }, badFormat.deps),
    ).rejects.toMatchObject({ code: 'gone' });
    const tooLong = deps({
      row: row({ sealedFields: [{ field: `${P}f1_11[0]`, ref: `{{secure:${SSN_ITEM}.number}}` }] }),
      bytes: W9,
    });
    const error = (await materializeSavedFile(
      'u1',
      'x',
      { kind: 'download', checked: true },
      tooLong.deps,
    ).catch((caught) => caught)) as SealedFileError;
    expect(error).toBeInstanceOf(SealedFileError);
    expect(error.message).toBe('A saved detail does not fit this form any more. Fill the form again.');
    expect(tooLong.uses).toEqual([]);
  });
});
