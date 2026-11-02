// The check before a file counts as made: open the archive again and strictly
// parse its XML. `validateOfficeArchive` reads only the ZIP directory, so a form
// feed in a paragraph passes it and then the file does not open in Word.

import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { OfficeError, type OfficeExtension } from './office-security';

const FILE_NAME: Record<OfficeExtension, string> = {
  docx: 'Word file',
  xlsx: 'Excel file',
  pptx: 'PowerPoint file',
};
const MAIN_PART: Record<OfficeExtension, { part: string; root: string }> = {
  docx: { part: 'word/document.xml', root: 'document' },
  xlsx: { part: 'xl/workbook.xml', root: 'workbook' },
  pptx: { part: 'ppt/presentation.xml', root: 'presentation' },
};

let parser: DOMParser | undefined;
function strictParser() {
  // One window for all parts: a new JSDOM for each part costs about 30 ms.
  parser ??= new new JSDOM('<x/>', { contentType: 'application/xml' }).window.DOMParser();
  return parser;
}

/** The local name of the root element, or the reason that the XML is not valid. */
export function parseStrictXml(source: string): { root: string } | { error: string } {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return { error: 'it has a document type declaration' };
  const root = strictParser().parseFromString(source, 'application/xml').documentElement;
  if (!root) return { error: 'it has no root element' };
  if (root.localName === 'parsererror')
    return { error: (root.textContent || 'it does not parse').trim().split('\n')[0].slice(0, 160) };
  return { root: root.localName };
}

function refuse(extension: OfficeExtension, detail: string): never {
  throw new OfficeError(
    `The server built a ${FILE_NAME[extension]} that does not open (${detail}). The file was not saved or sent.`,
    422,
  );
}

/**
 * Opens a built file: the archive, the content types, the main part, and each
 * XML part. `parts` limits the XML check to the parts that an edit changed, so
 * an unusual part from another program never blocks an edit.
 * Throws OfficeError with a plain message when the file does not open.
 */
export async function verifyOfficePackage(
  bytes: Uint8Array,
  extension: OfficeExtension,
  options: { parts?: readonly string[] } = {},
) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return refuse(extension, 'the archive does not read');
  }
  const main = MAIN_PART[extension];
  const names =
    options.parts ??
    Object.keys(zip.files).filter((name) => !zip.files[name].dir && /\.(?:xml|rels)$/i.test(name));
  for (const name of new Set(['[Content_Types].xml', main.part, ...names])) {
    const part = zip.file(name);
    if (!part) return refuse(extension, `${name} is missing`);
    const parsed = parseStrictXml(await part.async('string'));
    if ('error' in parsed) return refuse(extension, `${name} is not valid XML: ${parsed.error}`);
    if (name === main.part && parsed.root !== main.root)
      return refuse(extension, `${name} is not a ${main.root} part`);
  }
}
