// PDF forms (docs/albatross-goal-runs.md G5): read the fillable fields of a
// PDF and write values into them. The form stays fillable: no field is
// flattened, so the user can change any value later. A signature field is
// never filled; it stays a blank for the user.
//
// Labels come from the field's own tooltip (the PDF "alternate name"), then
// from the XFA template that IRS forms carry (caption, tool tip, or spoken
// text), then from the page text next to the field. pdf-lib cannot write XFA,
// so a filled file keeps the AcroForm only, and every viewer shows the values.
//
// This module is pure: bytes in, bytes or field lists out. It never logs a
// value, and no error message here holds a value.

import {
  decodePDFRawStream,
  EncryptedPDFError,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
} from 'pdf-lib';

export type PdfFieldType = 'text' | 'check' | 'choice' | 'radio' | 'signature';

/** One fillable field, as pdf_form_fields returns it. `page` starts at 1. */
export interface PdfFormField {
  name: string;
  label: string;
  type: PdfFieldType;
  options?: string[];
  value?: string | boolean;
  page: number;
  /** The most characters the field takes (text fields with a limit). */
  maxLength?: number;
  readOnly?: boolean;
}

/** A value to write: text, a choice, or a check. */
export type PdfFillValue = string | boolean;

export type PdfFormErrorCode = 'not_pdf' | 'encrypted' | 'no_form' | 'bad_values';

export class PdfFormError extends Error {
  constructor(
    readonly code: PdfFormErrorCode,
    message: string,
    /** For bad_values: one plain line for each field that cannot take its value. */
    readonly problems: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'PdfFormError';
  }
}

/** The most fields that one read returns. */
export const PDF_FORM_FIELDS_MAX = 300;
const LABEL_MAX = 100;
const OPTIONS_MAX = 60;
const VALUE_MAX = 2_000;

/** Page text near a field, for forms with no tooltip and no XFA. Tests replace it. */
export type PageTextReader = (
  bytes: Uint8Array,
  pages: number[],
) => Promise<Map<number, Array<{ text: string; x: number; y: number; width: number; height: number }>>>;

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (!isPdfBytes(bytes)) throw new PdfFormError('not_pdf', 'This file is not a PDF.');
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // A file with a PDF header and no document inside loads with no catalog.
    if (!doc.catalog || doc.getPageCount() < 1) throw new Error('empty');
  } catch (error) {
    // pdf-lib builds to ES5, so its error classes can lose their prototype: check the text too.
    if (error instanceof EncryptedPDFError || /is encrypted/i.test(String((error as Error)?.message)))
      throw new PdfFormError('encrypted', 'This PDF has a password. Albatross cannot fill it.');
    throw new PdfFormError('not_pdf', 'This PDF could not be read.');
  }
  return doc;
}

/** True when the bytes start like a PDF (the header may follow a few bytes of junk). */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

function acroFormOf(doc: PDFDocument): PDFDict | undefined {
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  return acro instanceof PDFDict ? acro : undefined;
}

/**
 * Removes the parts that a changed file must not keep: the XFA copy of the
 * form (pdf-lib writes the AcroForm only, so a viewer that prefers XFA would
 * show stale values), the XFA rendering flag, and the usage-rights signature
 * (it breaks when the file changes, and Acrobat then warns).
 */
function dropXfa(doc: PDFDocument) {
  acroFormOf(doc)?.delete(PDFName.of('XFA'));
  doc.catalog.delete(PDFName.of('NeedsRendering'));
  doc.catalog.delete(PDFName.of('Perms'));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return '';
}

function oneLine(raw: string) {
  return raw.replace(/\s+/g, ' ').trim();
}

function firstSentence(text: string) {
  return text.match(/^(.{3,}?[.:?])\s/)?.[1] ?? text;
}

function cleanLabel(raw: string): string {
  const text = oneLine(raw);
  if (text.length <= LABEL_MAX) return text;
  // Long captions ("1 Name of entity/individual. An entry is required. (For …)"): the first sentence.
  const first = firstSentence(text);
  return first.length <= LABEL_MAX ? first : `${first.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/**
 * A label that says what the field is. A long text whose first sentence is
 * only a section mark ("Part I.", "3a.") is weak: the page text next to the
 * field is better then.
 */
function strongLabel(raw: string): boolean {
  const text = oneLine(raw);
  if (!text) return false;
  return text.length <= LABEL_MAX || firstSentence(text).length >= 15;
}

/** The field's tooltip (TU), on the field or a parent. */
function tooltipOf(field: PDFField): string {
  let dict: PDFDict | undefined = field.acroField.dict;
  for (let depth = 0; dict && depth < 4; depth += 1) {
    const label = textOf(dict.lookup(PDFName.of('TU')));
    if (label.trim()) return label;
    const parent: unknown = dict.lookup(PDFName.of('Parent'));
    dict = parent instanceof PDFDict ? parent : undefined;
  }
  return '';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function between(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`));
  return match ? xmlText(match[1]) : '';
}

/** The label of one XFA field or group: its tool tip, its caption, or its spoken text. */
function xfaLabel(body: string): string {
  const tip = between(body, 'toolTip');
  if (tip) return tip;
  const caption = between(body, 'caption');
  if (caption) return caption;
  return between(body, 'speak');
}

function xfaTemplate(doc: PDFDocument): string {
  const xfa = acroFormOf(doc)?.lookup(PDFName.of('XFA'));
  const decode = (stream: unknown) => {
    if (!(stream instanceof PDFRawStream)) return '';
    try {
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    } catch {
      return '';
    }
  };
  if (xfa instanceof PDFArray) {
    for (let index = 0; index + 1 < xfa.size(); index += 2)
      if (textOf(xfa.lookup(index)) === 'template') return decode(xfa.lookup(index + 1));
    return '';
  }
  // A single stream holds the whole XDP package.
  return decode(xfa);
}

const CONTAINERS = new Set(['subform', 'field', 'exclGroup', 'area']);

/**
 * The XFA labels by SOM path ("topmostSubform[0].Page1[0].f1_01[0]"), and by
 * the last part of the path for names that the path walk did not match.
 */
export function xfaLabels(template: string): { byPath: Map<string, string>; byLeaf: Map<string, string[]> } {
  const byPath = new Map<string, string>();
  const byLeaf = new Map<string, string[]>();
  if (!template) return { byPath, byLeaf };
  const source = template.replace(/<proto\b[^>]*?\/>|<proto\b[\s\S]*?<\/proto\s*>/g, '');
  // Each open container: its path part (null when it is not named) and the counts of its named children.
  const stack: Array<{ tag: string; part: string | null; counts: Map<string, number> }> = [
    { tag: '#root', part: null, counts: new Map() },
  ];
  const tagPattern = /<(\/?)([A-Za-z][\w.-]*)\b([^>]*?)(\/?)>/g;
  for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
    const [, closing, tag, attributes, selfClosing] = match;
    if (!CONTAINERS.has(tag)) continue;
    if (closing) {
      while (stack.length > 1) {
        const top = stack.pop();
        if (top?.tag === tag) break;
      }
      continue;
    }
    const name = attributes.match(/\bname="([^"]*)"/)?.[1] ?? '';
    let part: string | null = null;
    if (name) {
      // The SOM index counts named siblings with the same name, through unnamed containers.
      let owner = stack[stack.length - 1];
      for (let index = stack.length - 1; index > 0 && stack[index].part === null; index -= 1)
        owner = stack[index - 1];
      const count = owner.counts.get(name) ?? 0;
      owner.counts.set(name, count + 1);
      part = `${name}[${count}]`;
    }
    if ((tag === 'field' || tag === 'exclGroup') && name) {
      const path = [...stack.map((entry) => entry.part).filter(Boolean), part].join('.');
      let label = '';
      if (!selfClosing) {
        const rest = source.slice(tagPattern.lastIndex);
        const end = rest.search(new RegExp(`</${tag}\\s*>`));
        const body = end === -1 ? rest : rest.slice(0, end);
        // A group's own caption comes before its first field.
        label = xfaLabel(tag === 'exclGroup' ? body.split(/<field\b/)[0] : body);
      }
      if (label) {
        byPath.set(path, label);
        const leaf = byLeaf.get(name) ?? [];
        leaf.push(label);
        byLeaf.set(name, leaf);
      }
    }
    if (!selfClosing) stack.push({ tag, part, counts: new Map() });
  }
  return { byPath, byLeaf };
}

function xfaLabelFor(name: string, labels: ReturnType<typeof xfaLabels>): string {
  const exact = labels.byPath.get(name);
  if (exact) return exact;
  // A path with parts that the template does not name: match the last part.
  const leaf = name.split('.').pop() || '';
  const parsed = leaf.match(/^(.*)\[(\d+)\]$/);
  const list = labels.byLeaf.get(parsed ? parsed[1] : leaf);
  if (!list?.length) return '';
  if (list.length === 1) return list[0];
  return parsed ? (list[Number(parsed[2])] ?? '') : '';
}

/** The default page text reader: pdfjs text items with their positions. */
export const readPageText: PageTextReader = async (bytes, pages) => {
  const out: Awaited<ReturnType<PageTextReader>> = new Map();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await loading.promise;
    for (const number of pages.slice(0, 20)) {
      if (number < 1 || number > doc.numPages) continue;
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const items: Array<{ text: string; x: number; y: number; width: number; height: number }> = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        items.push({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height || Math.abs(item.transform[3]) || 8,
        });
      }
      out.set(number, items);
    }
  } finally {
    await loading.destroy();
  }
  return out;
};

type Rect = { x: number; y: number; width: number; height: number };

/** The page text closest to a field: left on the same line, right for a check, or just above. */
export function nearbyLabel(
  rect: Rect,
  type: PdfFieldType,
  items: ReadonlyArray<{ text: string; x: number; y: number; width: number; height: number }>,
): string {
  const top = rect.y + rect.height;
  const middle = rect.y + rect.height / 2;
  let best: { text: string; score: number } | null = null;
  const consider = (text: string, score: number) => {
    if (!best || score < best.score) best = { text, score };
  };
  for (const item of items) {
    const text = item.text.replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    const itemMiddle = item.y + item.height / 2;
    const sameLine = Math.abs(itemMiddle - middle) <= Math.max(6, rect.height / 2);
    const right = item.x + item.width;
    if (sameLine && right <= rect.x + 2 && rect.x - right <= 220) consider(text, rect.x - right);
    if (
      sameLine &&
      type === 'check' &&
      item.x >= rect.x + rect.width - 1 &&
      item.x - rect.x - rect.width <= 60
    )
      consider(text, (item.x - rect.x - rect.width) / 2);
    const gap = item.y - top;
    if (gap >= -2 && gap <= 24 && item.x <= rect.x + rect.width && right >= rect.x - 10)
      consider(text, gap + 8);
  }
  return best ? (best as { text: string }).text : '';
}

function leafName(name: string): string {
  const leaf = name.split('.').pop() || name;
  return (
    leaf
      .replace(/\[\d+\]$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || name
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function typeOf(field: PDFField): PdfFieldType | null {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'check';
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return 'choice';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFSignature) return 'signature';
  return null;
}

function pageIndexes(doc: PDFDocument): Map<PDFDict, number> {
  const out = new Map<PDFDict, number>();
  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let at = 0; at < annots.size(); at += 1) {
      const dict = annots.lookup(at);
      if (dict instanceof PDFDict) out.set(dict, index);
    }
  });
  return out;
}

function widgetPlace(doc: PDFDocument, field: PDFField, pages: Map<PDFDict, number>) {
  const widget = field.acroField.getWidgets()[0];
  if (!widget) return { page: 1, rect: null as Rect | null };
  let index = pages.get(widget.dict);
  if (index === undefined) {
    const ref = widget.P();
    if (ref instanceof PDFRef) {
      const found = doc.getPages().findIndex((page) => page.ref === ref);
      if (found >= 0) index = found;
    }
  }
  return { page: (index ?? 0) + 1, rect: widget.getRectangle() };
}

function currentValue(field: PDFField): string | boolean | undefined {
  if (field instanceof PDFTextField) {
    const text = field.getText();
    return text ? text.slice(0, VALUE_MAX) : undefined;
  }
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected()[0];
  if (field instanceof PDFRadioGroup) return field.getSelected();
  return undefined;
}

function optionsOf(field: PDFField): string[] | undefined {
  if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup)
    return field.getOptions().slice(0, OPTIONS_MAX);
  return undefined;
}

/**
 * The fillable fields of a PDF in page order. Push buttons are left out.
 * Throws PdfFormError: not_pdf, encrypted.
 */
export async function readPdfFormFields(
  bytes: Uint8Array,
  options: { pageText?: PageTextReader } = {},
): Promise<PdfFormField[]> {
  const doc = await loadPdf(bytes);
  const labels = xfaLabels(xfaTemplate(doc));
  dropXfa(doc);
  const pages = pageIndexes(doc);
  const fields: Array<PdfFormField & { rect: Rect | null; order: number; strong: boolean }> = [];
  for (const [order, field] of doc.getForm().getFields().entries()) {
    const type = typeOf(field);
    if (!type) continue;
    const name = field.getName();
    const place = widgetPlace(doc, field, pages);
    const maxLength = field instanceof PDFTextField ? field.getMaxLength() : undefined;
    const value = currentValue(field);
    const choices = optionsOf(field);
    const own = tooltipOf(field) || xfaLabelFor(name, labels);
    fields.push({
      name,
      label: own ? cleanLabel(own) : '',
      type,
      ...(choices?.length ? { options: choices } : {}),
      ...(value !== undefined && value !== '' ? { value } : {}),
      page: place.page,
      ...(maxLength ? { maxLength } : {}),
      ...(field.isReadOnly() ? { readOnly: true } : {}),
      rect: place.rect,
      order,
      strong: strongLabel(own),
    });
  }
  const weak = fields.filter((field) => !field.strong && field.rect);
  if (weak.length) {
    const reader = options.pageText ?? readPageText;
    const text = await reader(bytes, [...new Set(weak.map((field) => field.page))]).catch(
      () => new Map() as Awaited<ReturnType<PageTextReader>>,
    );
    for (const field of weak) {
      const near = cleanLabel(nearbyLabel(field.rect as Rect, field.type, text.get(field.page) ?? []));
      if (near) field.label = near;
    }
  }
  return fields
    .sort((a, b) => a.page - b.page || a.order - b.order)
    .slice(0, PDF_FORM_FIELDS_MAX)
    .map(({ rect: _rect, order: _order, strong: _strong, ...field }) => {
      const label = field.label || leafName(field.name);
      const max = field.maxLength;
      const limit = max && max <= 40 ? ` (${max} character${max === 1 ? '' : 's'} at most)` : '';
      return { ...field, label: `${label}${limit}` };
    });
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['true', 'yes', 'on', 'checked', 'x', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', 'unchecked', '0', '']);

function checkValue(value: PdfFillValue): boolean | null {
  if (typeof value === 'boolean') return value;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

function pickOption(options: string[], value: string): string | null {
  const wanted = value.trim();
  return (
    options.find((option) => option === wanted) ??
    options.find((option) => option.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

/** Fields that must stay empty in the saved bytes (sealed values), and must exist as text fields. */
export interface FillPlan {
  values: Record<string, PdfFillValue>;
  /** Text fields that a sealed value fills later. They are checked, and left as they are. */
  sealed?: Array<{ field: string; length?: number | null }>;
}

/**
 * Checks every value against its field, writes the values, and returns new
 * bytes. Nothing is written when one value is wrong: the error lists each
 * problem. Throws PdfFormError: not_pdf, encrypted, no_form, bad_values.
 */
export async function fillPdfForm(
  bytes: Uint8Array,
  plan: FillPlan,
): Promise<{ bytes: Uint8Array; filled: string[] }> {
  const doc = await loadPdf(bytes);
  dropXfa(doc);
  const form = doc.getForm();
  const all = form.getFields();
  if (!all.length) throw new PdfFormError('no_form', 'This PDF has no fillable fields.');
  const byName = new Map(all.map((field) => [field.getName(), field]));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const problems: Array<{ field: string; message: string }> = [];
  const writes: Array<() => void> = [];
  const problem = (field: string, message: string) => problems.push({ field, message });

  for (const { field: name, length } of plan.sealed ?? []) {
    const field = byName.get(name);
    if (!field) problem(name, 'This PDF has no field with this name.');
    else if (!(field instanceof PDFTextField)) problem(name, 'A saved detail goes only into a text field.');
    else if (field.isReadOnly()) problem(name, 'This field is read only.');
    else {
      const max = field.getMaxLength();
      if (max && length && length > max)
        problem(
          name,
          `This field takes ${max} characters at most. Use a shorter format of the saved detail.`,
        );
    }
  }

  for (const [name, value] of Object.entries(plan.values)) {
    const field = byName.get(name);
    if (!field) {
      problem(name, 'This PDF has no field with this name. Call pdf_form_fields for the names.');
      continue;
    }
    if (field instanceof PDFSignature) {
      problem(name, 'This is a signature field. Albatross never signs. Leave it for the user.');
      continue;
    }
    if (field.isReadOnly()) {
      problem(name, 'This field is read only.');
      continue;
    }
    if (field instanceof PDFTextField) {
      if (typeof value !== 'string') {
        problem(name, 'This is a text field. Send text.');
        continue;
      }
      const text = value.replace(/\r\n?/g, '\n');
      if (!field.isMultiline() && text.includes('\n')) {
        problem(name, 'This field takes one line.');
        continue;
      }
      const max = field.getMaxLength();
      if (max && text.length > max) {
        problem(name, `This field takes ${max} characters at most.`);
        continue;
      }
      try {
        for (const line of text.split('\n')) font.encodeText(line);
      } catch {
        problem(name, 'The value has a character that this form cannot show.');
        continue;
      }
      writes.push(() => field.setText(text || undefined));
    } else if (field instanceof PDFCheckBox) {
      const checked = checkValue(value);
      if (checked === null) problem(name, 'This is a check box. Send true or false.');
      else writes.push(() => (checked ? field.check() : field.uncheck()));
    } else if (field instanceof PDFRadioGroup) {
      const option = typeof value === 'string' ? pickOption(field.getOptions(), value) : null;
      if (!option) problem(name, `Choose one of: ${field.getOptions().slice(0, 20).join(', ')}.`);
      else writes.push(() => field.select(option));
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (typeof value !== 'string') {
        problem(name, 'This is a list. Send one of its options.');
        continue;
      }
      const option = pickOption(field.getOptions(), value);
      const editable = field instanceof PDFDropdown && field.isEditable();
      if (!option && !(editable && value.trim())) {
        problem(name, `Choose one of: ${field.getOptions().slice(0, 20).join(', ')}.`);
        continue;
      }
      writes.push(() => field.select(option ?? value.trim()));
    } else problem(name, 'Albatross cannot fill this kind of field.');
  }

  if (problems.length)
    throw new PdfFormError(
      'bad_values',
      `Nothing was filled. Fix these fields: ${problems.map((entry) => `${entry.field}: ${entry.message}`).join(' ')}`,
      problems,
    );
  for (const write of writes) write();
  form.updateFieldAppearances(font);
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, filled: Object.keys(plan.values) };
}
