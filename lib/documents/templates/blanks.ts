// Blanks: fields the user must still fill, kept as Word content controls
// (`w:sdt`) with the tag `blank:<slug>` and the label as the alias. The
// placeholder shows the label in the accent tint. `w:sdtPr/w:rPr` holds the
// style of a filled value, so Word, the document server, and `fill_blank`
// all write the value in the body style. Reading a control gives the same
// value that the thread shows.

import { ACCENT, BLANK_TAG_PREFIX, type BlankSpec, blankSlug, INK, TINT } from './house';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface BlankValue {
  /** The label, for example "Invoice number". `fill_blank` takes this name. */
  name: string;
  slug: string;
  value: string;
  filled: boolean;
}

function el(doc: Document, name: string, attrs: Record<string, string | number> = {}) {
  const node = doc.createElementNS(W, `w:${name}`);
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, String(value));
  return node;
}
function kids(parent: Element, name: string) {
  return Array.from(parent.children).filter((node) => node.namespaceURI === W && node.localName === name);
}
function kid(parent: Element, name: string) {
  return kids(parent, name)[0];
}
function all(parent: Document | Element, name: string) {
  return Array.from(parent.getElementsByTagNameNS(W, name));
}

/** Replaces a property in a w:rPr with one element (or removes it when attrs is null). */
function setRunProperty(rPr: Element, name: string, attrs: Record<string, string> | null) {
  for (const node of kids(rPr, name)) node.remove();
  if (!attrs) return;
  const node = el(rPr.ownerDocument, name, attrs);
  // rPr schema order: rStyle rFonts b bCs i iCs ... color spacing w kern position sz szCs highlight u effect bdr shd ...
  const order = [
    'rStyle',
    'rFonts',
    'b',
    'bCs',
    'i',
    'iCs',
    'caps',
    'strike',
    'color',
    'sz',
    'szCs',
    'highlight',
    'u',
    'shd',
  ];
  const position = order.indexOf(name);
  const before = Array.from(rPr.children).find((child) => order.indexOf(child.localName) > position);
  rPr.insertBefore(node, before ?? null);
}

function placeholderProperties(source: Element | undefined, doc: Document) {
  const rPr = source ? (source.cloneNode(true) as Element) : el(doc, 'rPr');
  setRunProperty(rPr, 'color', { val: ACCENT });
  setRunProperty(rPr, 'shd', { val: 'clear', color: 'auto', fill: TINT });
  return rPr;
}

function filledProperties(source: Element | undefined, doc: Document) {
  const rPr = source ? (source.cloneNode(true) as Element) : el(doc, 'rPr');
  setRunProperty(rPr, 'shd', null);
  if (!kid(rPr, 'color') || kid(rPr, 'color')?.getAttributeNS(W, 'val') === ACCENT)
    setRunProperty(rPr, 'color', { val: INK });
  return rPr;
}

/** A run with text; line breaks become w:br and tabs w:tab. */
function textRun(doc: Document, rPr: Element, value: string) {
  const run = el(doc, 'r');
  run.append(rPr);
  for (const piece of value.split(/(\n|\t)/)) {
    if (piece === '\n' || piece === '\t') run.append(el(doc, piece === '\n' ? 'br' : 'tab'));
    else if (piece) {
      const text = el(doc, 't');
      text.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      text.textContent = piece;
      run.append(text);
    }
  }
  return run;
}

const placeholderText = (label: string) => ` ${label} `;

// CT_SdtPr: rPr alias tag id lock placeholder temporary showingPlcHdr ...
const BEFORE_PLACEHOLDER_FLAG = ['rPr', 'alias', 'tag', 'id', 'lock', 'placeholder', 'temporary'];
function setShowingPlaceholder(sdtPr: Element, on: boolean) {
  for (const node of kids(sdtPr, 'showingPlcHdr')) node.remove();
  if (!on) return;
  const after = Array.from(sdtPr.children).find(
    (child) => !BEFORE_PLACEHOLDER_FLAG.includes(child.localName),
  );
  sdtPr.insertBefore(el(sdtPr.ownerDocument, 'showingPlcHdr'), after ?? null);
}

/**
 * Turns a marker run (styled as the filled value would be) into an inline
 * content control that shows the label as its placeholder.
 */
export function wrapBlankRun(run: Element, blank: BlankSpec, id: number) {
  const doc = run.ownerDocument;
  const rPr = kid(run, 'rPr');
  const sdt = el(doc, 'sdt');
  const sdtPr = el(doc, 'sdtPr');
  sdtPr.append(
    filledProperties(rPr, doc),
    el(doc, 'alias', { val: blank.label }),
    el(doc, 'tag', { val: `${BLANK_TAG_PREFIX}${blank.slug}` }),
    el(doc, 'id', { val: id }),
    el(doc, 'showingPlcHdr'),
    el(doc, 'text', blank.multiLine ? { multiLine: '1' } : {}),
  );
  const content = el(doc, 'sdtContent');
  content.append(textRun(doc, placeholderProperties(rPr, doc), placeholderText(blank.label)));
  sdt.append(sdtPr, content);
  run.replaceWith(sdt);
}

interface BlankControl {
  sdt: Element;
  sdtPr: Element;
  content: Element;
  slug: string;
  name: string;
}

function controls(doc: Document): BlankControl[] {
  const out: BlankControl[] = [];
  for (const sdt of all(doc, 'sdt')) {
    const sdtPr = kid(sdt, 'sdtPr');
    const content = kid(sdt, 'sdtContent');
    const tag = sdtPr && kid(sdtPr, 'tag')?.getAttributeNS(W, 'val');
    if (!sdtPr || !content || !tag?.startsWith(BLANK_TAG_PREFIX)) continue;
    const slug = tag.slice(BLANK_TAG_PREFIX.length);
    const name = kid(sdtPr, 'alias')?.getAttributeNS(W, 'val') || slug;
    out.push({ sdt, sdtPr, content, slug, name });
  }
  return out;
}

function contentText(content: Element) {
  return all(content, '*')
    .map((node) =>
      node.localName === 't'
        ? node.textContent || ''
        : node.localName === 'tab'
          ? '\t'
          : node.localName === 'br' || node.localName === 'cr'
            ? '\n'
            : '',
    )
    .join('');
}

function controlValue(control: BlankControl) {
  if (kid(control.sdtPr, 'showingPlcHdr')) return '';
  const text = contentText(control.content);
  // An editor can drop the placeholder flag and keep the label as text.
  return text.trim() === control.name.trim() ? '' : text;
}

/** Every blank in page order, one entry for each name, with its current value. */
export function readBlanks(doc: Document): BlankValue[] {
  const out: BlankValue[] = [];
  const seen = new Map<string, BlankValue>();
  for (const control of controls(doc)) {
    const value = controlValue(control);
    const existing = seen.get(control.slug);
    if (existing) {
      if (!existing.filled && value.trim()) Object.assign(existing, { value, filled: true });
      continue;
    }
    const entry = { name: control.name, slug: control.slug, value, filled: Boolean(value.trim()) };
    seen.set(control.slug, entry);
    out.push(entry);
  }
  return out;
}

/**
 * Writes a value into every control of one blank. The blank is found by its
 * name or its slug, without regard to case. An empty value shows the
 * placeholder again. Returns the name of the blank.
 */
export function fillBlank(doc: Document, blank: string, value: string): string {
  const wanted = blank.trim();
  const slug = blankSlug(wanted.replace(new RegExp(`^${BLANK_TAG_PREFIX}`, 'i'), ''));
  const matches = controls(doc).filter(
    (control) => control.slug === slug || control.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (!matches.length) {
    const names = readBlanks(doc).map((entry) => `"${entry.name}"`);
    throw new BlankNotFoundError(
      names.length
        ? `No blank is named "${wanted}". The blanks are ${names.join(', ')}.`
        : 'This document has no blanks.',
    );
  }
  const text = value.replace(/\r\n?/g, '\n');
  for (const control of matches) {
    const firstRun = all(control.content, 'r')[0];
    const rPrSource = kid(control.sdtPr, 'rPr') ?? (firstRun && kid(firstRun, 'rPr'));
    const empty = !text.trim();
    const rPr = empty ? placeholderProperties(rPrSource, doc) : filledProperties(rPrSource, doc);
    const run = textRun(doc, rPr, empty ? placeholderText(control.name) : text);
    // A block-level control holds paragraphs: keep the first one and its properties.
    const [paragraph, ...others] = kids(control.content, 'p');
    if (paragraph) {
      for (const other of others) other.remove();
      const pPr = kid(paragraph, 'pPr');
      paragraph.replaceChildren(...(pPr ? [pPr] : []), run);
    } else control.content.replaceChildren(run);
    setShowingPlaceholder(control.sdtPr, empty);
  }
  return matches[0].name;
}

export class BlankNotFoundError extends Error {}
