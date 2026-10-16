import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { liftToolsForAgent } from '../lib/ai/loop';
import { TOOL_GROUPS } from '../lib/ai/tool-groups';
import type { PersonalDetailView } from '../lib/albatross/thread-contract';
import { readPdfFormFields } from '../lib/files/pdf-forms';
import type { SavedFileRow, SaveFileInput } from '../lib/files/saved-files';
import type { SecureItemView } from '../lib/secure/contract';
import { TOOLS } from '../lib/tools';
import { pdfFormFields, pdfFormFill, pdfFormToolDeps, personalDetailText } from '../lib/tools/pdf-forms';
import { toolContext } from './tools/harness';

// Invented data only. The W-9 is the public-domain IRS form (test data).
const W9 = new Uint8Array(readFileSync(path.join(import.meta.dir, 'fixtures/irs-fw9-2024-03.pdf')));
const P = 'topmostSubform[0].Page1[0].';
const SSN_ITEM = 'si_ssn_000000000000000001';
const original = { ...pdfFormToolDeps };
afterEach(() => Object.assign(pdfFormToolDeps, original));

const details: PersonalDetailView[] = [
  {
    key: 'name',
    label: 'Name',
    value: { first: 'Sam', middle: 'J', last: 'Rivera' },
    display: 'Sam J Rivera',
    source: 'chat',
    saved: true,
    updatedAt: 1,
  },
  {
    key: 'home_address',
    label: 'Home address',
    value: {
      line1: '100 Example Street',
      line2: 'Apt 4',
      city: 'Springfield',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    },
    display: '100 Example Street, Apt 4, Springfield, NY 10001',
    source: 'chat',
    saved: true,
    updatedAt: 1,
  },
  {
    key: 'phone',
    label: 'Phone',
    value: '+16075550100',
    display: '(607) 555-0100',
    source: 'chat',
    saved: true,
    updatedAt: 1,
  },
  {
    key: 'emergency_contact',
    label: 'Emergency contact',
    value: { name: 'Alex Rivera', phone: '+16075550101', relationship: 'Sibling' },
    display: 'Alex Rivera (Sibling), (607) 555-0101',
    source: 'chat',
    saved: true,
    updatedAt: 1,
  },
  {
    key: 'email',
    label: 'Email',
    value: 'sam@example.com',
    display: 'sam@example.com',
    source: 'account',
    saved: false,
    updatedAt: null,
  },
  {
    key: 'custom:employer',
    label: 'Employer',
    value: { label: 'Employer', value: 'Example Co' },
    display: 'Example Co',
    source: 'chat',
    saved: true,
    updatedAt: 1,
  },
];

const ssnItem: SecureItemView = {
  id: SSN_ITEM,
  kind: 'id_number',
  label: 'Social Security number',
  sites: [],
  hints: { number: 'ends 3456' },
  facts: { type: 'ssn' },
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
};

function row(overrides: Partial<SavedFileRow> = {}): SavedFileRow {
  return {
    _id: 'upload_w9',
    userId: 'test_user_tools',
    storageId: 's1',
    name: 'fw9.pdf',
    contentType: 'application/pdf',
    size: W9.byteLength,
    createdAt: 1,
    origin: 'web',
    sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
    workId: 'w1',
    url: 'https://storage.example.test/w9',
    ...overrides,
  };
}

function harness(options: { row?: SavedFileRow | null; secure?: boolean; items?: SecureItemView[] } = {}) {
  const saved: SaveFileInput[] = [];
  Object.assign(pdfFormToolDeps, {
    getFile: async (_userId: string, fileId: string) =>
      options.row === undefined ? row({ _id: fileId }) : options.row,
    readBytes: async () => W9,
    saveFile: async (input: SaveFileInput) => {
      saved.push(input);
      return {
        fileId: 'upload_filled',
        title: input.name,
        openPath: '/?view=files&file=upload_filled',
        size: input.bytes.byteLength,
        contentType: input.contentType,
        sha256: 'abc',
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      };
    },
    listDetails: async () => details,
    secureEnabled: () => options.secure ?? true,
    secureItems: async () => options.items ?? [ssnItem],
  });
  return { saved };
}

const ctx = toolContext();

describe('pdf_form_fields', () => {
  test('lists the W-9 fields with the shared result shape', async () => {
    harness();
    const result = await pdfFormFields.handler({ fileId: 'upload_w9' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.fileId).toBe('upload_w9');
    expect(result.fields).toHaveLength(23);
    expect(result.fields[0]).toEqual({
      name: `${P}f1_01[0]`,
      label: '1 Name of entity/individual.',
      type: 'text',
      page: 1,
    });
    expect(result.fields.find((field) => field.type === 'check')).toMatchObject({ value: false });
    for (const field of result.fields) expect(Object.keys(field).sort()).not.toContain('maxLength');
  });

  test('refuses a file that is not there, not a PDF, or has no form', async () => {
    harness({ row: null });
    await expect(pdfFormFields.handler({ fileId: 'nope' }, ctx)).rejects.toThrow('No saved file has this id');
    harness({ row: row({ name: 'notes.docx', contentType: 'application/vnd.openxmlformats' }) });
    await expect(pdfFormFields.handler({ fileId: 'x' }, ctx)).rejects.toThrow('This file is not a PDF.');
    harness();
    pdfFormToolDeps.readBytes = async () => new TextEncoder().encode('not a pdf');
    await expect(pdfFormFields.handler({ fileId: 'x' }, ctx)).rejects.toThrow('This file is not a PDF.');
    const { PDFDocument } = await import('pdf-lib');
    const empty = await PDFDocument.create();
    empty.addPage();
    const emptyBytes = await empty.save();
    pdfFormToolDeps.readBytes = async () => emptyBytes;
    await expect(pdfFormFields.handler({ fileId: 'x' }, ctx)).rejects.toThrow('no fillable fields');
    await expect(pdfFormFields.handler({ fileId: 'x' }, { ...ctx, userId: null })).rejects.toThrow(
      'signed-in',
    );
  });

  test('a read-only field says so in its label', async () => {
    harness();
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const field = doc.getForm().createTextField('total');
    field.setText('42');
    field.enableReadOnly();
    field.addToPage(page, { x: 10, y: 10, width: 50, height: 18 });
    const bytes = await doc.save();
    pdfFormToolDeps.readBytes = async () => bytes;
    const result = await pdfFormFields.handler({ fileId: 'x' }, ctx);
    expect(result.fields[0]).toMatchObject({ label: 'total (read only)', value: '42' });
  });
});

describe('pdf_form_fill', () => {
  test('fills plain text, checks, and personal details; secure references stay sealed', async () => {
    const { saved } = harness();
    const result = await pdfFormFill.handler(
      {
        fileId: 'upload_w9',
        values: [
          { field: `${P}f1_01[0]`, value: { detail: 'name' } },
          { field: `${P}Boxes3a-b_ReadOrder[0].c1_1[0]`, value: true },
          { field: `${P}Address_ReadOrder[0].f1_07[0]`, value: { detail: 'home_address.street' } },
          { field: `${P}Address_ReadOrder[0].f1_08[0]`, value: { detail: 'home_address.cityLine' } },
          { field: `${P}f1_11[0]`, value: `{{secure:${SSN_ITEM}.number|AREA}}` },
          { field: `${P}f1_12[0]`, value: `{{secure:${SSN_ITEM}.number|GROUP}}` },
          { field: `${P}f1_13[0]`, value: `{{secure:${SSN_ITEM}.number|SERIAL}}` },
        ],
      },
      ctx,
    );
    const sealedFields = [
      { field: `${P}f1_11[0]`, ref: `{{secure:${SSN_ITEM}.number|AREA}}` },
      { field: `${P}f1_12[0]`, ref: `{{secure:${SSN_ITEM}.number|GROUP}}` },
      { field: `${P}f1_13[0]`, ref: `{{secure:${SSN_ITEM}.number|SERIAL}}` },
    ];
    expect(result).toEqual({
      ok: true,
      fileId: 'upload_filled',
      title: 'fw9 (filled).pdf',
      openPath: '/?view=files&file=upload_filled',
      size: saved[0].bytes.byteLength,
      contentType: 'application/pdf',
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      sha256: 'abc',
      sealedFields,
      // The result names the fields it wrote; sealed fields are not in it.
      filled: [
        `${P}f1_01[0]`,
        `${P}Boxes3a-b_ReadOrder[0].c1_1[0]`,
        `${P}Address_ReadOrder[0].f1_07[0]`,
        `${P}Address_ReadOrder[0].f1_08[0]`,
      ],
    });
    expect(saved[0]).toMatchObject({
      userId: 'test_user_tools',
      name: 'fw9 (filled).pdf',
      origin: 'filled',
      workId: 'w1',
      sealedFields,
    });
    const fields = new Map(
      (await readPdfFormFields(saved[0].bytes, { pageText: async () => new Map() })).map((field) => [
        field.name.replace(P, ''),
        field.value,
      ]),
    );
    expect(fields.get('f1_01[0]')).toBe('Sam J Rivera');
    expect(fields.get('Address_ReadOrder[0].f1_07[0]')).toBe('100 Example Street, Apt 4');
    expect(fields.get('Address_ReadOrder[0].f1_08[0]')).toBe('Springfield, NY 10001');
    // The sealed boxes are empty in the saved bytes.
    for (const box of ['f1_11[0]', 'f1_12[0]', 'f1_13[0]']) expect(fields.get(box)).toBeUndefined();
  });

  test('a fill of a filled file keeps its sealed fields unless a field gets a new value', async () => {
    const { saved } = harness({
      row: row({
        name: 'fw9 (filled).pdf',
        sourceUrl: undefined,
        workId: undefined,
        sealedFields: [
          { field: `${P}f1_11[0]`, ref: `{{secure:${SSN_ITEM}.number|AREA}}` },
          { field: `${P}f1_12[0]`, ref: `{{secure:${SSN_ITEM}.number|GROUP}}` },
        ],
      }),
    });
    const result = await pdfFormFill.handler(
      {
        fileId: 'upload_w9',
        values: [{ field: `${P}f1_12[0]`, value: '' }],
        title: 'W-9 for Example Co',
      },
      ctx,
    );
    expect(result.title).toBe('W-9 for Example Co.pdf');
    expect(result.sealedFields).toEqual([
      { field: `${P}f1_11[0]`, ref: `{{secure:${SSN_ITEM}.number|AREA}}` },
    ]);
    expect(saved[0].sourceUrl).toBeUndefined();
    expect(saved[0].name).toBe('W-9 for Example Co.pdf');
    // No sealed field left: the result has none.
    harness({ row: row({ name: 'fw9 (filled).pdf' }) });
    const plain = await pdfFormFill.handler(
      { fileId: 'upload_w9', values: [{ field: `${P}f1_01[0]`, value: 'Example Co' }], title: 'done.PDF' },
      ctx,
    );
    expect(plain.sealedFields).toBeUndefined();
    expect(plain.title).toBe('done.PDF');
  });

  test('refuses raw secrets, mixed references, unknown details, and wrong items; nothing is saved', async () => {
    const { saved } = harness();
    const error = await pdfFormFill
      .handler(
        {
          fileId: 'upload_w9',
          values: [
            { field: `${P}f1_10[0]`, value: '123-45-6789' },
            { field: `${P}f1_09[0]`, value: `SSN {{secure:${SSN_ITEM}.number}}` },
            { field: `${P}f1_02[0]`, value: { detail: 'passport' } },
            { field: `${P}f1_11[0]`, value: '{{secure:si_missing_00000000000001.number|AREA}}' },
            { field: `${P}f1_12[0]`, value: `{{secure:${SSN_ITEM}.number}}` },
            { field: `${P}f1_02[0]`, value: 'twice' },
          ],
        },
        ctx,
      )
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toStartWith('Nothing was filled. Fix these values:');
    expect(message).toContain('this looks like a Social Security number');
    expect(message).toContain('one whole reference');
    expect(message).toContain('no saved personal detail "passport"');
    expect(message).toContain('No saved item has this id');
    expect(message).toContain('send each field once');
    // The length check runs in the form step: 9 digits do not fit a 2-character box.
    harness();
    const tooLong = await pdfFormFill
      .handler(
        { fileId: 'upload_w9', values: [{ field: `${P}f1_12[0]`, value: `{{secure:${SSN_ITEM}.number}}` }] },
        ctx,
      )
      .catch((caught: Error) => caught);
    expect((tooLong as Error).message).toContain('This field takes 2 characters at most');
    expect(saved).toEqual([]);
    // The store is off for this user.
    harness({ secure: false });
    await expect(
      pdfFormFill.handler(
        {
          fileId: 'upload_w9',
          values: [{ field: `${P}f1_11[0]`, value: `{{secure:${SSN_ITEM}.number|AREA}}` }],
        },
        ctx,
      ),
    ).rejects.toThrow('Passwords and IDs is not available');
  });

  test('both tools are in the agent list with execute, in one group, and in the registry', () => {
    const lifted = liftToolsForAgent('b', 'UTC');
    for (const name of ['pdf_form_fields', 'pdf_form_fill']) {
      expect(TOOLS[name]).toBeTruthy();
      expect(typeof lifted[name]?.execute).toBe('function');
    }
    expect([...TOOL_GROUPS.pdf_forms.tools]).toEqual([
      'mail_attachment_save',
      'pdf_form_fields',
      'pdf_form_fill',
    ]);
    expect(pdfFormFill.risk).toBe('write_self');
    expect(pdfFormFields.mutating).toBe(false);
  });
});

describe('personal detail parts', () => {
  test('each key and part, and null for a part that does not exist', () => {
    const text = (key: string) => personalDetailText(details, key);
    expect(text('name')).toBe('Sam J Rivera');
    expect(text('name.full')).toBe('Sam J Rivera');
    expect(text('name.last')).toBe('Rivera');
    expect(text('name.nick')).toBeNull();
    expect(text('home_address')).toBe('100 Example Street, Apt 4, Springfield, NY 10001');
    expect(text('home_address.postalCode')).toBe('10001');
    expect(text('home_address.planet')).toBeNull();
    expect(text('phone')).toBe('(607) 555-0100');
    expect(text('phone.area')).toBe('607');
    expect(text('phone.e164')).toBe('+16075550100');
    expect(text('phone.color')).toBeNull();
    expect(text('emergency_contact')).toBe('Alex Rivera (Sibling), (607) 555-0101');
    expect(text('emergency_contact.relationship')).toBe('Sibling');
    expect(text('emergency_contact.age')).toBeNull();
    expect(text('email')).toBe('sam@example.com');
    expect(text('email.domain')).toBeNull();
    expect(text('custom:employer')).toBe('Example Co');
    expect(text('passport')).toBeNull();
  });
});
