/** Targeted DOCX edits preserve every unrelated package part, including Word-only features. */
import { loadImage } from '@napi-rs/canvas';
import { ImageRun, Packer, Paragraph, Document as WordDocument } from 'docx';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { z } from 'zod';
import { OfficeError, validateOfficeArchive } from './office-security';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const paragraphIndex = z.number().int().min(0);
const text = z.string().max(100_000);
const color = z.string().regex(/^[0-9a-fA-F]{6}$/);
const singleLine = text.refine(
  (value) => !/[\r\n\t]/.test(value),
  'Use paragraph insertion for line breaks and tabs.',
);
export const wordEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_header_footer'), area: z.enum(['header', 'footer']), text }).strict(),
  z
    .object({
      op: z.literal('add_comment'),
      paragraph: paragraphIndex,
      text: text.min(1).max(10_000),
      author: z.string().min(1).max(100).default('Albatross'),
    })
    .strict(),
  z
    .object({
      op: z.literal('insert_image'),
      after: paragraphIndex.optional(),
      dataUrl: z
        .string()
        .max(1_400_000)
        .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
      width: z.number().int().min(1).max(1600),
      height: z.number().int().min(1).max(2000),
      alt: z.string().max(500).default(''),
    })
    .strict(),
  z
    .object({
      op: z.literal('insert_paragraph'),
      after: paragraphIndex.optional(),
      text,
      heading: z.number().int().min(1).max(6).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace_text'),
      paragraph: paragraphIndex,
      find: text.min(1).refine((value) => !/[\r\n\t]/.test(value)),
      replacement: singleLine,
      all: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      op: z.literal('format_text'),
      paragraphs: z.array(paragraphIndex).min(1).max(500),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      strike: z.boolean().optional(),
      font: z.string().min(1).max(100).optional(),
      size: z.number().min(6).max(144).optional(),
      color: color.optional(),
      highlight: z.enum(['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'none']).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('format_paragraph'),
      paragraphs: z.array(paragraphIndex).min(1).max(500),
      alignment: z.enum(['left', 'center', 'right', 'both']).optional(),
      heading: z.number().int().min(0).max(6).optional(),
      lineSpacing: z.number().min(1).max(3).optional(),
      spaceAfter: z.number().min(0).max(144).optional(),
      pageBreakBefore: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('insert_table'),
      after: paragraphIndex.optional(),
      rows: z
        .array(z.array(text.max(10_000)).min(1).max(20))
        .min(1)
        .max(100),
      header: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      op: z.literal('page_setup'),
      size: z.enum(['letter', 'a4']).optional(),
      landscape: z.boolean().optional(),
      marginInches: z.number().min(0.25).max(3).optional(),
    })
    .strict(),
]);
export const wordEditsSchema = z.array(wordEditSchema).min(1).max(100);
export type WordEdit = z.input<typeof wordEditSchema>;

function xml(source: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || source.length > 8_000_000)
    throw new OfficeError('This document XML cannot be edited safely.');
  return new JSDOM(source, { contentType: 'application/xml' });
}
function descendants(parent: Element | XMLDocument, name: string) {
  return Array.from(parent.getElementsByTagNameNS(W, name));
}
function paragraphText(paragraph: Element) {
  return inlineNodes(paragraph).map(inlineText).join('');
}
function ancestor(node: Element, name: string) {
  let parent = node.parentElement;
  while (parent) {
    if (parent.namespaceURI === W && parent.localName === name) return parent;
    parent = parent.parentElement;
  }
  return null;
}
function inlineNodes(paragraph: Element) {
  return descendants(paragraph, '*').filter(
    (node) =>
      ['t', 'br', 'cr', 'tab'].includes(node.localName) &&
      ancestor(node, 'p') === paragraph &&
      ancestor(node, 'r'),
  );
}
function inlineText(node: Element) {
  return node.localName === 't' ? node.textContent || '' : node.localName === 'tab' ? '\t' : '\n';
}
function child(parent: Element, name: string) {
  return Array.from(parent.children).find((node) => node.namespaceURI === W && node.localName === name);
}
function element(doc: XMLDocument, name: string, attrs: Record<string, string | number> = {}) {
  const node = doc.createElementNS(W, `w:${name}`);
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, String(value));
  return node;
}
function property(parent: Element, name: string, attrs: Record<string, string | number>) {
  let node = child(parent, name);
  if (!node) {
    node = element(parent.ownerDocument, name);
    // Canonical WordprocessingML property order; retain unrelated existing nodes.
    const order = propertyOrder[parent.localName] || [];
    const position = order.indexOf(name);
    const next =
      position < 0
        ? undefined
        : Array.from(parent.children).find(
            (entry) => entry.namespaceURI === W && order.indexOf(entry.localName) > position,
          );
    parent.insertBefore(node, next || null);
  }
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, String(value));
  return node;
}

const propertyOrder: Record<string, string[]> = {
  rPr: 'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(
    ' ',
  ),
  pPr: 'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(
    ' ',
  ),
};
function properties(parent: Element, name: string) {
  let node = child(parent, name);
  if (!node) {
    node = element(parent.ownerDocument, name);
    parent.prepend(node);
  }
  return node;
}
function paragraph(doc: XMLDocument, value: string) {
  const node = element(doc, 'p');
  const run = element(doc, 'r');
  const pieces = value.replace(/\r\n?/g, '\n').split(/(\n|\t)/);
  pieces.forEach((piece) => {
    if (piece === '\n' || piece === '\t') {
      run.append(element(doc, piece === '\t' ? 'tab' : 'br'));
      return;
    }
    const content = element(doc, 't');
    content.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    content.textContent = piece;
    run.append(content);
  });
  node.append(run);
  return node;
}
async function open(bytes: Uint8Array) {
  validateOfficeArchive(bytes, 'docx');
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file('word/document.xml');
  if (!part) throw new OfficeError('The Word document body is missing.');
  const dom = xml(await part.async('string'));
  const document = dom.window.document;
  const body = descendants(document, 'body')[0];
  if (!body) {
    dom.window.close();
    throw new OfficeError('The Word document body is invalid.');
  }
  return { zip, dom, document, body };
}

export async function readWordPackage(bytes: Uint8Array) {
  const { zip, dom, body } = await open(bytes);
  try {
    const notes: Array<{ part: string; text: string }> = [];
    for (const path of Object.keys(zip.files).filter((path) =>
      /^word\/(?:header|footer|comments|footnotes|endnotes)[^/]*\.xml$/.test(path),
    )) {
      const content = xml(await zip.file(path)!.async('string'));
      try {
        notes.push({
          part: path,
          text: descendants(content.window.document, 'p').map(paragraphText).join('\n'),
        });
      } finally {
        content.window.close();
      }
    }
    return {
      notes,
      paragraphs: descendants(body, 'p').map((node, index) => ({
        index,
        text: paragraphText(node),
        style: child(child(node, 'pPr') || node, 'pStyle')?.getAttributeNS(W, 'val') || null,
        inTable: Boolean(ancestor(node, 'tc')),
      })),
      tables: descendants(body, 'tbl').length,
      images: descendants(body, 'drawing').length,
      sections: descendants(body, 'sectPr').length,
    };
  } finally {
    dom.window.close();
  }
}

export async function createWordPackage(title: string, edits?: WordEdit[]) {
  const bytes = await Packer.toBuffer(
    new WordDocument({ title, sections: [{ children: [new Paragraph('')] }] }),
  );
  return edits?.length ? editWordPackage(bytes, edits) : bytes;
}

export async function editWordPackage(bytes: Uint8Array, input: WordEdit[]) {
  if (JSON.stringify(input).length > 2_000_000)
    throw new OfficeError('Word edits must be smaller than 2 MB.', 413);
  const edits = wordEditsSchema.parse(input);
  const { zip, dom, document, body } = await open(bytes);
  const parts = new Map<string, JSDOM>();
  try {
    const part = async (path: string, root: string, namespace: string) => {
      let loaded = parts.get(path);
      if (!loaded) {
        loaded = xml(
          (await zip.file(path)?.async('string')) ||
            `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${namespace}"/>`,
        );
        parts.set(path, loaded);
      }
      return loaded.window.document;
    };
    const addContentType = async (path: string, contentType: string) => {
      const types = await part('[Content_Types].xml', 'Types', CT);
      if (
        Array.from(types.documentElement.children).some(
          (node) => node.getAttribute('PartName') === `/${path}`,
        )
      )
        return;
      const entry = types.createElementNS(CT, 'Override');
      entry.setAttribute('PartName', `/${path}`);
      entry.setAttribute('ContentType', contentType);
      types.documentElement.append(entry);
    };
    const relationships = () => part('word/_rels/document.xml.rels', 'Relationships', REL);
    const addRelationship = async (kind: string, target: string) => {
      const rels = await relationships();
      const id = `rId${crypto.randomUUID()}`;
      const entry = rels.createElementNS(REL, 'Relationship');
      entry.setAttribute('Id', id);
      entry.setAttribute('Type', `${R}/${kind}`);
      entry.setAttribute('Target', target);
      rels.documentElement.append(entry);
      return id;
    };
    const section = () => {
      let node = child(body, 'sectPr');
      if (!node) {
        node = element(document, 'sectPr');
        body.append(node);
      }
      return node;
    };
    const at = (index: number) => {
      const node = descendants(body, 'p')[index];
      if (!node) throw new OfficeError(`Paragraph ${index} does not exist. Read the current document first.`);
      return node;
    };
    const insert = (node: Element, after?: number) => {
      if (after !== undefined) {
        const anchor = at(after);
        if (anchor.parentElement !== body)
          throw new OfficeError('Insert after a body paragraph outside a table.');
        anchor.after(node);
      } else body.insertBefore(node, child(body, 'sectPr') || null);
    };
    for (const edit of edits) {
      if (edit.op === 'insert_paragraph') {
        const node = paragraph(document, edit.text);
        if (edit.heading) property(properties(node, 'pPr'), 'pStyle', { val: `Heading${edit.heading}` });
        insert(node, edit.after);
      } else if (edit.op === 'replace_text') {
        const target = at(edit.paragraph);
        if (
          descendants(target, 'fldChar').length ||
          descendants(target, 'fldSimple').length ||
          ancestor(target, 'ins') ||
          ancestor(target, 'del') ||
          descendants(target, 'ins').length ||
          descendants(target, 'del').length
        )
          throw new OfficeError(
            'Edit tracked changes and fields in the word processor before replacing this paragraph.',
          );
        const nodes = inlineNodes(target);
        const value = nodes.map(inlineText).join('');
        const matches: number[] = [];
        for (
          let position = value.indexOf(edit.find);
          position >= 0;
          position = value.indexOf(edit.find, position + edit.find.length)
        ) {
          matches.push(position);
          if (!edit.all) break;
        }
        if (!matches.length)
          throw new OfficeError(`The requested text was not found in paragraph ${edit.paragraph}.`);
        // Apply from the end so offsets stay valid; preserve the first matching run's formatting.
        for (const start of matches.reverse()) {
          let offset = 0;
          let inserted = false;
          for (const node of nodes) {
            const content = inlineText(node);
            const end = offset + content.length;
            if (node.localName === 't' && end > start && offset < start + edit.find.length) {
              const from = Math.max(0, start - offset);
              const to = Math.min(content.length, start + edit.find.length - offset);
              node.textContent =
                content.slice(0, from) + (inserted ? '' : edit.replacement) + content.slice(to);
              node.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
              inserted = true;
            }
            offset = end;
          }
        }
      } else if (edit.op === 'format_text') {
        for (const index of edit.paragraphs)
          for (const run of descendants(at(index), 'r').filter((node) => ancestor(node, 'p') === at(index))) {
            const props = properties(run, 'rPr');
            for (const [key, name] of [
              ['bold', 'b'],
              ['italic', 'i'],
              ['strike', 'strike'],
            ] as const)
              if (edit[key] !== undefined) property(props, name, { val: edit[key] ? '1' : '0' });
            if (edit.underline !== undefined)
              property(props, 'u', { val: edit.underline ? 'single' : 'none' });
            if (edit.font) property(props, 'rFonts', { ascii: edit.font, hAnsi: edit.font, cs: edit.font });
            if (edit.size !== undefined) property(props, 'sz', { val: Math.round(edit.size * 2) });
            if (edit.color) property(props, 'color', { val: edit.color });
            if (edit.highlight) property(props, 'highlight', { val: edit.highlight });
          }
      } else if (edit.op === 'format_paragraph') {
        for (const index of edit.paragraphs) {
          const props = properties(at(index), 'pPr');
          if (edit.alignment) property(props, 'jc', { val: edit.alignment });
          if (edit.heading !== undefined)
            property(props, 'pStyle', { val: edit.heading ? `Heading${edit.heading}` : 'Normal' });
          if (edit.lineSpacing !== undefined)
            property(props, 'spacing', { line: Math.round(edit.lineSpacing * 240), lineRule: 'auto' });
          if (edit.spaceAfter !== undefined)
            property(props, 'spacing', { after: Math.round(edit.spaceAfter * 20) });
          if (edit.pageBreakBefore !== undefined)
            property(props, 'pageBreakBefore', { val: edit.pageBreakBefore ? '1' : '0' });
        }
      } else if (edit.op === 'insert_table') {
        const columns = edit.rows[0].length;
        if (edit.rows.some((row) => row.length !== columns))
          throw new OfficeError('Table rows must have the same number of columns.');
        const table = element(document, 'tbl');
        const props = properties(table, 'tblPr');
        property(props, 'tblW', { w: 5000, type: 'pct' });
        const borders = property(props, 'tblBorders', {});
        for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'])
          property(borders, side, { val: 'single', sz: 4, color: 'CBD5E1' });
        const grid = element(document, 'tblGrid');
        for (let column = 0; column < columns; column++)
          grid.append(element(document, 'gridCol', { w: Math.floor(9360 / columns) }));
        table.append(grid);
        edit.rows.forEach((values, rowIndex) => {
          const row = element(document, 'tr');
          if (edit.header && rowIndex === 0) property(properties(row, 'trPr'), 'tblHeader', { val: '1' });
          for (const value of values) {
            const cell = element(document, 'tc');
            const p = paragraph(document, value);
            if (edit.header && rowIndex === 0) {
              property(properties(cell, 'tcPr'), 'shd', { fill: 'F1F5F9' });
              property(properties(descendants(p, 'r')[0], 'rPr'), 'b', { val: '1' });
            }
            cell.append(p);
            row.append(cell);
          }
          table.append(row);
        });
        insert(table, edit.after);
      } else if (edit.op === 'set_header_footer') {
        const properties = section();
        const previous = Array.from(properties.children).find(
          (node) =>
            node.localName === `${edit.area}Reference` && node.getAttributeNS(W, 'type') === 'default',
        );
        const rels = await relationships();
        const relationship = Array.from(rels.documentElement.children).find(
          (node) =>
            node.getAttribute('Id') === previous?.getAttributeNS(R, 'id') &&
            node.getAttribute('Type') === `${R}/${edit.area}`,
        );
        const target = relationship?.getAttribute('Target') || `${edit.area}-${crypto.randomUUID()}.xml`;
        if (
          relationship?.getAttribute('TargetMode') === 'External' ||
          !/^(?:\/word\/)?[\w-]+\.xml$/.test(target)
        )
          throw new OfficeError('The header or footer target cannot be edited safely.');
        const path = target.startsWith('/word/') ? target.slice(1) : `word/${target}`;
        const content = await part(path, edit.area === 'header' ? 'hdr' : 'ftr', W);
        content.documentElement.replaceChildren(paragraph(content, edit.text));
        const id = relationship?.getAttribute('Id') || (await addRelationship(edit.area, target));
        await addContentType(
          path,
          `application/vnd.openxmlformats-officedocument.wordprocessingml.${edit.area}+xml`,
        );
        for (const node of Array.from(properties.children))
          if (node.localName === `${edit.area}Reference` && node.getAttributeNS(W, 'type') === 'default')
            node.remove();
        const reference = element(document, `${edit.area}Reference`, { type: 'default' });
        reference.setAttributeNS(R, 'r:id', id);
        properties.prepend(reference);
      } else if (edit.op === 'add_comment') {
        const targetParagraph = at(edit.paragraph);
        const rels = await relationships();
        let relationship = Array.from(rels.documentElement.children).find(
          (node) => node.getAttribute('Type') === `${R}/comments`,
        );
        if (!relationship) {
          const id = await addRelationship('comments', 'comments.xml');
          relationship = Array.from(rels.documentElement.children).find(
            (node) => node.getAttribute('Id') === id,
          )!;
        }
        const target = relationship.getAttribute('Target') || '';
        if (
          relationship.getAttribute('TargetMode') === 'External' ||
          !/^(?:\/word\/)?[\w-]+\.xml$/.test(target)
        )
          throw new OfficeError('The comments part uses an unsupported location.');
        const path = target.startsWith('/') ? target.slice(1) : `word/${target}`;
        const comments = await part(path, 'comments', W);
        const ids = descendants(comments, 'comment')
          .map((node) => Number(node.getAttributeNS(W, 'id')))
          .filter(Number.isFinite);
        const id = Math.max(-1, ...ids) + 1;
        const comment = element(comments, 'comment', {
          id,
          author: edit.author,
          date: new Date().toISOString(),
        });
        comment.append(paragraph(comments, edit.text));
        comments.documentElement.append(comment);
        await addContentType(
          path,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
        );
        const start = element(document, 'commentRangeStart', { id });
        const pPr = child(targetParagraph, 'pPr');
        if (pPr) pPr.after(start);
        else targetParagraph.prepend(start);
        targetParagraph.append(element(document, 'commentRangeEnd', { id }));
        const run = element(document, 'r');
        run.append(element(document, 'commentReference', { id }));
        targetParagraph.append(run);
      } else if (edit.op === 'insert_image') {
        const data = Buffer.from(edit.dataUrl.split(',')[1], 'base64');
        const type = edit.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
        if (
          data.length > 1_000_000 ||
          (type === 'png'
            ? !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : data[0] !== 255 || data[1] !== 216)
        )
          throw new OfficeError('Use a PNG or JPEG image smaller than 1 MB.');
        try {
          const decoded = await loadImage(data);
          if (!decoded.width || !decoded.height) throw new Error('Empty image');
        } catch {
          throw new OfficeError('The PNG or JPEG image could not be decoded.');
        }
        const imageBytes = await Packer.toBuffer(
          new WordDocument({
            sections: [
              {
                children: [
                  new Paragraph({
                    children: [
                      new ImageRun({
                        type,
                        data,
                        transformation: { width: edit.width, height: edit.height },
                        altText: { name: edit.alt, title: edit.alt, description: edit.alt },
                      }),
                    ],
                  }),
                ],
              },
            ],
          }),
        );
        const imageZip = await JSZip.loadAsync(imageBytes);
        const imageDom = xml(await imageZip.file('word/document.xml')!.async('string'));
        try {
          const drawing = document.importNode(descendants(imageDom.window.document, 'p')[0], true);
          const imagePath = `media/albatross-${crypto.randomUUID()}.${type}`;
          zip.file(`word/${imagePath}`, data);
          const id = await addRelationship('image', imagePath);
          for (const node of Array.from(drawing.getElementsByTagName('*')))
            if (node.hasAttributeNS(R, 'embed')) node.setAttributeNS(R, 'r:embed', id);
          // Drawing ids must be unique across the complete document.
          const existing = Array.from(document.getElementsByTagName('*'))
            .filter((node) => node.localName === 'docPr')
            .map((node) => Number(node.getAttribute('id')))
            .filter(Number.isFinite);
          for (const node of Array.from(drawing.getElementsByTagName('*')))
            if (node.localName === 'docPr') node.setAttribute('id', String(Math.max(0, ...existing) + 1));
          await addContentType(`word/${imagePath}`, type === 'png' ? 'image/png' : 'image/jpeg');
          insert(drawing, edit.after);
        } finally {
          imageDom.window.close();
        }
      } else {
        const properties = section();
        const pageSize = child(properties, 'pgSz');
        let width =
          edit.size === 'a4'
            ? 11906
            : edit.size === 'letter'
              ? 12240
              : Number(pageSize?.getAttributeNS(W, 'w') || 12240);
        let height =
          edit.size === 'a4'
            ? 16838
            : edit.size === 'letter'
              ? 15840
              : Number(pageSize?.getAttributeNS(W, 'h') || 15840);
        const landscape = edit.landscape ?? pageSize?.getAttributeNS(W, 'orient') === 'landscape';
        [width, height] = landscape
          ? [Math.max(width, height), Math.min(width, height)]
          : [Math.min(width, height), Math.max(width, height)];
        property(properties, 'pgSz', { w: width, h: height, orient: landscape ? 'landscape' : 'portrait' });
        if (edit.marginInches !== undefined) {
          const margin = Math.round(edit.marginInches * 1440);
          property(properties, 'pgMar', { top: margin, bottom: margin, left: margin, right: margin });
        }
      }
    }
    zip.file('word/document.xml', dom.serialize());
    for (const [path, content] of parts) zip.file(path, content.serialize());
    const result = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    validateOfficeArchive(result, 'docx');
    return result;
  } finally {
    dom.window.close();
    for (const content of parts.values()) content.window.close();
  }
}
