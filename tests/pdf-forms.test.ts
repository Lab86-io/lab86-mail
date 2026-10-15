import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import {
  fillPdfForm,
  isPdfBytes,
  nearbyLabel,
  PdfFormError,
  readPageText,
  readPdfFormFields,
  xfaLabels,
} from '../lib/files/pdf-forms';

// The IRS Form W-9 (Rev. March 2024) from irs.gov. IRS forms are US
// government works in the public domain; the file is test data only.
const W9 = new Uint8Array(readFileSync(path.join(import.meta.dir, 'fixtures/irs-fw9-2024-03.pdf')));
const P = 'topmostSubform[0].Page1[0].';
const noPageText = async () => new Map();

async function makeForm(options: { tooltips?: boolean; signature?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Full name', { x: 40, y: 704, size: 10, font });
  page.drawText('Agree to terms', { x: 70, y: 654, size: 10, font });
  const form = doc.getForm();
  const name = form.createTextField('applicant.name');
  name.addToPage(page, { x: 110, y: 698, width: 200, height: 18 });
  const zip = form.createTextField('applicant.zip');
  zip.setMaxLength(5);
  zip.addToPage(page, { x: 110, y: 600, width: 60, height: 18 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 50, y: 650, width: 12, height: 12 });
  const state = form.createDropdown('state');
  state.addOptions(['NY', 'NJ', 'CA']);
  state.addToPage(page, { x: 110, y: 560, width: 60, height: 18 });
  const plan = form.createRadioGroup('plan');
  plan.addOptionToPage('basic', page, { x: 110, y: 520, width: 12, height: 12 });
  plan.addOptionToPage('pro', page, { x: 140, y: 520, width: 12, height: 12 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 110, y: 400, width: 200, height: 60 });
  const locked = form.createTextField('locked');
  locked.setText('fixed');
  locked.enableReadOnly();
  locked.addToPage(page, { x: 110, y: 360, width: 100, height: 18 });
  const pages = form.createOptionList('topics');
  pages.addOptions(['Billing', 'Support']);
  pages.addToPage(page, { x: 320, y: 360, width: 100, height: 40 });
  if (options.tooltips) name.acroField.dict.set(PDFName.of('TU'), PDFString.of('Applicant full legal name'));
  if (options.signature) {
    const widget = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of('sign_here'),
      Rect: [110, 300, 310, 330],
      F: 4,
      P: page.ref,
    });
    const ref = doc.context.register(widget);
    page.node.addAnnot(ref);
    form.acroForm.addField(ref);
  }
  return doc.save();
}

describe('reading PDF form fields', () => {
  test('the W-9 gives every field a label from its XFA template or the page text', async () => {
    const fields = await readPdfFormFields(W9);
    expect(fields.length).toBe(23);
    const byName = new Map(fields.map((field) => [field.name.replace(P, ''), field]));
    expect(byName.get('f1_01[0]')).toMatchObject({
      type: 'text',
      page: 1,
      label: '1 Name of entity/individual.',
    });
    expect(byName.get('Address_ReadOrder[0].f1_08[0]')?.label).toBe('6 City, state, and ZIP code');
    expect(byName.get('Boxes3a-b_ReadOrder[0].c1_1[0]')).toMatchObject({
      type: 'check',
      label: 'Individual/sole proprietor',
      value: false,
    });
    // The Social Security number takes three boxes; the label says how long each is.
    expect(byName.get('f1_11[0]')).toMatchObject({
      maxLength: 3,
      label: 'Social security number (3 characters at most)',
    });
    expect(byName.get('f1_12[0]')?.maxLength).toBe(2);
    expect(byName.get('f1_13[0]')?.maxLength).toBe(4);
    expect(byName.get('Boxes3a-b_ReadOrder[0].f1_03[0]')?.label).toContain('(1 character at most)');
    // A section mark alone ("Part I.") is not a label: the page text wins.
    expect(fields.every((field) => field.label && !field.label.startsWith('Part I.'))).toBe(true);
  });

  test('a form with tooltips, lists, a radio group, a read-only field, and a signature', async () => {
    const fields = await readPdfFormFields(await makeForm({ tooltips: true, signature: true }), {
      pageText: noPageText,
    });
    const byName = new Map(fields.map((field) => [field.name, field]));
    expect(byName.get('applicant.name')?.label).toBe('Applicant full legal name');
    expect(byName.get('applicant.zip')).toMatchObject({ maxLength: 5, label: 'zip (5 characters at most)' });
    expect(byName.get('state')).toMatchObject({ type: 'choice', options: ['NY', 'NJ', 'CA'] });
    expect(byName.get('topics')).toMatchObject({ type: 'choice', options: ['Billing', 'Support'] });
    expect(byName.get('plan')).toMatchObject({ type: 'radio', options: ['basic', 'pro'] });
    expect(byName.get('locked')).toMatchObject({ readOnly: true, value: 'fixed' });
    expect(byName.get('sign_here')).toMatchObject({ type: 'signature', page: 1, label: 'sign here' });
  });

  test('a field with no tooltip takes the page text next to it (pdfjs)', async () => {
    const fields = await readPdfFormFields(await makeForm());
    const byName = new Map(fields.map((field) => [field.name, field]));
    expect(byName.get('applicant.name')?.label).toBe('Full name');
    expect(byName.get('agree')?.label).toBe('Agree to terms');
    const text = await readPageText(await makeForm(), [1, 9]);
    expect(text.get(1)?.some((item) => item.text === 'Full name')).toBe(true);
    expect(text.has(9)).toBe(false);
  });

  test('a page text reader that fails leaves the field name as the label', async () => {
    const fields = await readPdfFormFields(await makeForm(), {
      pageText: async () => {
        throw new Error('no text');
      },
    });
    expect(fields.find((field) => field.name === 'applicant.name')?.label).toBe('name');
  });

  test('nearby text: left on the line, right of a check box, or just above', () => {
    const rect = { x: 100, y: 100, width: 80, height: 16 };
    const items = [
      { text: 'Far away', x: 400, y: 400, width: 40, height: 8 },
      { text: 'Above it', x: 100, y: 120, width: 40, height: 8 },
      { text: 'Left of it', x: 30, y: 104, width: 60, height: 8 },
    ];
    expect(nearbyLabel(rect, 'text', items)).toBe('Left of it');
    expect(nearbyLabel(rect, 'text', items.slice(0, 2))).toBe('Above it');
    expect(
      nearbyLabel({ x: 50, y: 100, width: 10, height: 10 }, 'check', [
        { text: 'Yes', x: 64, y: 101, width: 20, height: 8 },
      ]),
    ).toBe('Yes');
    expect(nearbyLabel(rect, 'text', [{ text: 'x', x: 30, y: 104, width: 6, height: 8 }])).toBe('');
  });

  test('XFA labels follow the SOM path through unnamed subforms, and match by the last part', () => {
    const template = `<template><subform name="form1"><subform><field name="a"><caption><value><text>First &amp; last</text></value></caption></field
    ><field name="a"><assist><toolTip>Second one</toolTip></assist></field
    ><exclGroup name="choice"><caption><value><text>Pick one</text></value></caption><field name="x"/></exclGroup
    ><field name="b"><assist><speak>Spoken &#x41;BC</speak></assist></field></subform></subform>
    <proto><field name="ghost"><caption><value><text>No</text></value></caption></field></proto></template>`;
    const labels = xfaLabels(template);
    expect(labels.byPath.get('form1[0].a[0]')).toBe('First & last');
    expect(labels.byPath.get('form1[0].a[1]')).toBe('Second one');
    expect(labels.byPath.get('form1[0].choice[0]')).toBe('Pick one');
    expect(labels.byPath.get('form1[0].b[0]')).toBe('Spoken ABC');
    expect(labels.byLeaf.has('ghost')).toBe(false);
    expect(xfaLabels('').byPath.size).toBe(0);
  });

  test('not a PDF, a broken PDF, and a PDF with a password are refused in plain words', async () => {
    expect(isPdfBytes(new TextEncoder().encode('hello'))).toBe(false);
    await expect(readPdfFormFields(new TextEncoder().encode('hello'))).rejects.toMatchObject({
      code: 'not_pdf',
    });
    await expect(readPdfFormFields(new TextEncoder().encode('%PDF-1.7 garbage'))).rejects.toMatchObject({
      code: 'not_pdf',
      message: 'This PDF could not be read.',
    });
    // A trailer that names an Encrypt dictionary makes the file encrypted for pdf-lib.
    const plain = await PDFDocument.create();
    plain.addPage();
    const saved = new TextDecoder('latin1').decode(await plain.save({ useObjectStreams: false }));
    const locked = new Uint8Array(
      Buffer.from(
        saved.replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 >>'),
        'latin1',
      ),
    );
    await expect(readPdfFormFields(locked)).rejects.toMatchObject({ code: 'encrypted' });
  });
});

describe('filling PDF forms', () => {
  test('the W-9 fills, stays fillable, and drops the XFA copy and the usage rights', async () => {
    const out = await fillPdfForm(W9, {
      values: {
        [`${P}f1_01[0]`]: 'Sam Rivera',
        [`${P}Boxes3a-b_ReadOrder[0].c1_1[0]`]: true,
        [`${P}Address_ReadOrder[0].f1_07[0]`]: '100 Example Street',
        [`${P}Address_ReadOrder[0].f1_08[0]`]: 'Springfield, NY 10001',
      },
      sealed: [
        { field: `${P}f1_11[0]`, length: 3 },
        { field: `${P}f1_12[0]`, length: 2 },
        { field: `${P}f1_13[0]`, length: 4 },
      ],
    });
    expect(out.filled).toHaveLength(4);
    const fields = await readPdfFormFields(out.bytes, { pageText: noPageText });
    expect(fields).toHaveLength(23);
    const byName = new Map(fields.map((field) => [field.name.replace(P, ''), field]));
    expect(byName.get('f1_01[0]')?.value).toBe('Sam Rivera');
    expect(byName.get('Boxes3a-b_ReadOrder[0].c1_1[0]')?.value).toBe(true);
    // The sealed boxes stay empty in the bytes.
    for (const box of ['f1_11[0]', 'f1_12[0]', 'f1_13[0]']) expect(byName.get(box)?.value).toBeUndefined();
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.catalog.get(PDFName.of('Perms'))).toBeUndefined();
    expect(doc.getForm().acroForm.dict.get(PDFName.of('XFA'))).toBeUndefined();
    // Not flattened: the form still has its fields, and they still take values.
    expect(doc.getForm().getTextField(`${P}f1_01[0]`).isReadOnly()).toBe(false);
  });

  test('every wrong value is listed, and nothing is written', async () => {
    const error = await fillPdfForm(W9, {
      values: {
        [`${P}f1_11[0]`]: '1234',
        nope: 'x',
        [`${P}Boxes3a-b_ReadOrder[0].c1_1[0]`]: 'maybe',
        [`${P}f1_01[0]`]: true,
        [`${P}f1_02[0]`]: 'line one\nline two',
        [`${P}f1_09[0]`]: 'Emoji 🙂',
      },
      sealed: [
        { field: `${P}f1_12[0]`, length: 9 },
        { field: `${P}Boxes3a-b_ReadOrder[0].c1_1[1]` },
        { field: 'missing' },
      ],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PdfFormError);
    expect(error.code).toBe('bad_values');
    const messages = Object.fromEntries(
      (error as PdfFormError).problems.map((entry) => [entry.field.replace(P, ''), entry.message]),
    );
    expect(messages).toEqual({
      'f1_12[0]': 'This field takes 2 characters at most. Use a shorter format of the saved detail.',
      'Boxes3a-b_ReadOrder[0].c1_1[1]': 'A saved detail goes only into a text field.',
      missing: 'This PDF has no field with this name.',
      'f1_11[0]': 'This field takes 3 characters at most.',
      nope: 'This PDF has no field with this name. Call pdf_form_fields for the names.',
      'Boxes3a-b_ReadOrder[0].c1_1[0]': 'This is a check box. Send true or false.',
      'f1_01[0]': 'This is a text field. Send text.',
      'f1_02[0]': 'This field takes one line.',
      'f1_09[0]': 'The value has a character that this form cannot show.',
    });
    expect(error.message.startsWith('Nothing was filled.')).toBe(true);
  });

  test('lists, radio groups, check words, signatures, and read-only fields', async () => {
    const form = await makeForm({ signature: true });
    const out = await fillPdfForm(form, {
      values: {
        state: 'nj',
        plan: 'pro',
        agree: 'yes',
        notes: 'one\ntwo',
        topics: 'Support',
        'applicant.name': '',
      },
    });
    const fields = new Map(
      (await readPdfFormFields(out.bytes, { pageText: noPageText })).map((field) => [field.name, field]),
    );
    expect(fields.get('state')?.value).toBe('NJ');
    expect(fields.get('plan')?.value).toBe('pro');
    expect(fields.get('agree')?.value).toBe(true);
    expect(fields.get('notes')?.value).toBe('one\ntwo');
    expect(fields.get('topics')?.value).toBe('Support');
    const unchecked = await fillPdfForm(out.bytes, { values: { agree: false } });
    expect(
      (await readPdfFormFields(unchecked.bytes, { pageText: noPageText })).find(
        (field) => field.name === 'agree',
      )?.value,
    ).toBe(false);

    const refused = (await fillPdfForm(form, {
      values: { sign_here: 'Sam', locked: 'new', state: 'TX', plan: true, topics: false },
      sealed: [{ field: 'locked' }],
    }).catch((caught) => caught)) as PdfFormError;
    expect(Object.fromEntries(refused.problems.map((entry) => [entry.field, entry.message]))).toEqual({
      locked: 'This field is read only.',
      sign_here: 'This is a signature field. Albatross never signs. Leave it for the user.',
      state: 'Choose one of: NY, NJ, CA.',
      plan: 'Choose one of: basic, pro.',
      topics: 'This is a list. Send one of its options.',
    });
  });

  test('a PDF with no form says so', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await expect(fillPdfForm(await doc.save(), { values: { a: 'b' } })).rejects.toMatchObject({
      code: 'no_form',
    });
  });
});
