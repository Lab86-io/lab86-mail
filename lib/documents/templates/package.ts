// The last step of a template render. docx packs the document with marker
// runs; this pass swaps each marker for the real XML and embeds the fonts.

import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { wrapBlankRun } from './blanks';
import { embedTemplateFonts } from './fonts';
import type { TemplateCanvas } from './house';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const STORY_PART = /^word\/(?:document|header\d*|footer\d*)\.xml$/;

function wElement(doc: Document, name: string, attrs: Record<string, string> = {}) {
  const node = doc.createElementNS(W, `w:${name}`);
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, value);
  return node;
}

/**
 * A field as five runs: begin, instruction, separate, result, end. Each run
 * has its own copy of the run properties. The docx library puts the whole
 * field in one run, and LibreOffice then shows the result in the body size.
 */
export function replaceWithFieldRuns(run: Element, instruction: string) {
  const doc = run.ownerDocument;
  const rPr = Array.from(run.children).find((node) => node.localName === 'rPr');
  const wrap = (child: Element) => {
    const next = wElement(doc, 'r');
    if (rPr) next.append(rPr.cloneNode(true));
    next.append(child);
    return next;
  };
  const instr = wElement(doc, 'instrText');
  instr.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  instr.textContent = ` ${instruction} `;
  const result = wElement(doc, 't');
  result.textContent = '1';
  run.replaceWith(
    wrap(wElement(doc, 'fldChar', { fldCharType: 'begin' })),
    wrap(instr),
    wrap(wElement(doc, 'fldChar', { fldCharType: 'separate' })),
    wrap(result),
    wrap(wElement(doc, 'fldChar', { fldCharType: 'end' })),
  );
}

export interface FinalizedTemplate {
  bytes: Uint8Array;
  /** Blank names in page order, each name once. */
  blanks: string[];
}

export async function finalizeTemplatePackage(
  packed: Uint8Array,
  canvas: TemplateCanvas,
  options: { fontRoot?: string } = {},
): Promise<FinalizedTemplate> {
  const zip = await JSZip.loadAsync(packed);
  const pattern = canvas.markerPattern();
  const token = `lab86-${canvas.nonce}-`;
  const blanks: string[] = [];
  let controlId = 7_000;
  const paths = Object.keys(zip.files)
    .filter((path) => STORY_PART.test(path))
    // document.xml first, so blank names follow the page order of the body.
    .sort((a, b) => Number(b === 'word/document.xml') - Number(a === 'word/document.xml'));
  for (const path of paths) {
    const source = await zip.file(path)!.async('string');
    if (!source.includes(token)) continue;
    const dom = new JSDOM(source, { contentType: 'application/xml' });
    try {
      const doc = dom.window.document;
      for (const run of Array.from(doc.getElementsByTagNameNS(W, 'r'))) {
        const texts = Array.from(run.children).filter((node) => node.localName === 't');
        const match = texts.length === 1 ? pattern.exec(texts[0].textContent || '') : null;
        if (!match) continue;
        if (match[1] === 'field') {
          replaceWithFieldRuns(run, match[2]);
          continue;
        }
        const blank = canvas.blanks[Number(match[2])];
        if (!blank) throw new Error('A template blank has no definition.');
        wrapBlankRun(run, blank, controlId++);
        if (!blanks.includes(blank.label)) blanks.push(blank.label);
      }
      const serialized = dom.serialize();
      if (serialized.includes(token)) throw new Error('A template marker was not replaced.');
      zip.file(path, serialized);
    } finally {
      dom.window.close();
    }
  }
  await embedTemplateFonts(zip, { root: options.fontRoot });
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), blanks };
}
