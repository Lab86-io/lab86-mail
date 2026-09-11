/**
 * Bounded validation of an .xlsx container BEFORE anything inflates it.
 *
 * Isomorphic on purpose: the browser runs it before handing an email
 * attachment to the spreadsheet engine's Excel reader, and the import route
 * runs it again on the received bytes before storing the original. Only the
 * ZIP central directory is read (no inflation), so a ZIP bomb, a
 * password-protected workbook, a macro-enabled workbook renamed to .xlsx, or a
 * hostile entry name is refused at the cost of scanning a few kilobytes.
 *
 * Limits are deliberately below what the engine could theoretically handle:
 * the workbook has to fit a 900 KB Convex revision after import anyway.
 */
import type JSZip from 'jszip';

export const MAX_XLSX_BYTES = 15 * 1024 * 1024;
export const MAX_XLSX_ENTRIES = 4_000;
/** Total declared uncompressed size across all parts. */
export const MAX_XLSX_EXPANDED_BYTES = 120 * 1024 * 1024;
/** Declared (and, during inflation, actual) size of any single part. */
export const MAX_XLSX_ENTRY_BYTES = 48 * 1024 * 1024;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_MAX_COMMENT = 0xffff;
/** OLE compound file: password-protected OOXML and legacy .xls both use it. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const STORED = 0;
const DEFLATED = 8;

export class XlsxImportError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'XlsxImportError';
    this.status = status;
  }
}

export interface XlsxContainerEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

export interface XlsxContainer {
  entries: XlsxContainerEntry[];
  expandedBytes: number;
}

function isCompoundFile(bytes: Uint8Array) {
  return bytes.byteLength >= 8 && CFB_SIGNATURE.every((value, index) => bytes[index] === value);
}

function hasControlCharacters(name: string) {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function unsafeEntryName(name: string) {
  if (!name || name.length > 512) return true;
  if (name.startsWith('/') || name.includes('\\')) return true;
  if (name.split('/').some((segment) => segment === '..' || segment === '.')) return true;
  return hasControlCharacters(name);
}

/** Parts that mean "macro-enabled" or "ActiveX" regardless of the extension the file wears. */
export function isMacroOrActiveXPart(name: string) {
  return /(^|\/)(vbaProject\w*\.bin|vbaData\.xml)$/iu.test(name) || /(^|\/)activeX\//iu.test(name);
}

/**
 * Read the central directory of an .xlsx and enforce structural limits. Throws
 * XlsxImportError; never inflates. Callers still bound actual inflation with
 * `inflateEntryBounded` because a central directory can lie about sizes.
 */
export function inspectXlsxContainer(bytes: Uint8Array, maxBytes = MAX_XLSX_BYTES): XlsxContainer {
  if (!bytes.byteLength) throw new XlsxImportError('The file is empty.');
  if (bytes.byteLength > maxBytes) {
    throw new XlsxImportError(
      `Workbooks above ${Math.round(maxBytes / (1024 * 1024))} MB cannot be imported.`,
      413,
    );
  }
  if (isCompoundFile(bytes)) {
    throw new XlsxImportError(
      'Password-protected workbooks and legacy .xls files cannot be imported. Remove the password or save as .xlsx first.',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22 || view.getUint32(0, true) !== ZIP_LOCAL_FILE_HEADER) {
    throw new XlsxImportError('This file is not an Excel workbook (.xlsx).');
  }
  let end = -1;
  const lowest = Math.max(0, bytes.byteLength - 22 - ZIP_MAX_COMMENT);
  for (let index = bytes.byteLength - 22; index >= lowest; index -= 1) {
    if (view.getUint32(index, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new XlsxImportError('This file is not an Excel workbook (.xlsx).');
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new XlsxImportError('Multi-part archives are not supported.');
  }
  const count = view.getUint16(end + 10, true);
  if (
    view.getUint16(end + 8, true) !== count ||
    end + 22 + view.getUint16(end + 20, true) !== bytes.byteLength
  ) {
    throw new XlsxImportError('The workbook archive directory is invalid.');
  }
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new XlsxImportError('ZIP64 workbooks are not supported.');
  }
  if (!count) throw new XlsxImportError('The workbook archive is empty.');
  if (count > MAX_XLSX_ENTRIES) {
    throw new XlsxImportError(`The workbook has too many parts (${count}; limit ${MAX_XLSX_ENTRIES}).`);
  }
  if (directoryOffset + directorySize > end) {
    throw new XlsxImportError('The workbook archive directory is invalid.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const names = new Set<string>();
  const offsets = new Set<number>();
  const entries: XlsxContainerEntry[] = [];
  let cursor = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new XlsxImportError('The workbook archive directory is invalid.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new XlsxImportError('The workbook archive directory is invalid.');
    if (flags & 0x0001 || flags & 0x0040) {
      throw new XlsxImportError('Encrypted workbook parts cannot be imported. Remove the password first.');
    }
    if (method !== STORED && method !== DEFLATED) {
      throw new XlsxImportError('The workbook uses an unsupported compression method.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new XlsxImportError('ZIP64 workbooks are not supported.');
    }
    if (localOffset >= directoryOffset) {
      throw new XlsxImportError('The workbook archive directory is invalid.');
    }
    if (uncompressedSize > MAX_XLSX_ENTRY_BYTES) {
      throw new XlsxImportError('A part of this workbook is too large to import.', 413);
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_XLSX_EXPANDED_BYTES) {
      throw new XlsxImportError('This workbook expands beyond the supported size.', 413);
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER ||
      view.getUint16(localOffset + 6, true) !== flags ||
      view.getUint16(localOffset + 8, true) !== method ||
      offsets.has(localOffset)
    ) {
      throw new XlsxImportError('The workbook archive entry headers do not match.');
    }
    offsets.add(localOffset);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataOffset + compressedSize > directoryOffset ||
      decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name
    ) {
      throw new XlsxImportError('The workbook archive entry data is invalid.');
    }
    if (unsafeEntryName(name)) throw new XlsxImportError('The workbook archive contains an unsafe path.');
    if (isMacroOrActiveXPart(name)) {
      throw new XlsxImportError(
        'Macro-enabled or ActiveX workbooks are not supported. Save a copy without macros (.xlsx) and import that.',
      );
    }
    if (names.has(name)) throw new XlsxImportError('The workbook archive repeats a part name.');
    names.add(name);
    if (!name.endsWith('/')) entries.push({ name, compressedSize, uncompressedSize, method });
    cursor = next;
  }
  if (cursor !== directoryOffset + directorySize) {
    throw new XlsxImportError('The workbook archive directory is invalid.');
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new XlsxImportError('This file is not an Excel workbook (.xlsx).');
  }
  return { entries, expandedBytes };
}

/**
 * The package content types must describe a plain workbook. Macro-enabled,
 * template, and add-in packages declare different main parts, and a renamed
 * file keeps them.
 */
export function assertSupportedContentTypes(contentTypesXml: string) {
  if (/macroEnabled|\.addin\.|ms-excel\.template/iu.test(contentTypesXml)) {
    throw new XlsxImportError(
      'Macro-enabled, template, and add-in workbooks are not supported. Save a copy as a plain .xlsx and import that.',
    );
  }
  if (!/spreadsheetml\.sheet\.main\+xml/u.test(contentTypesXml)) {
    throw new XlsxImportError('This file is not an Excel workbook (.xlsx).');
  }
}

type StreamingEntry = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

/**
 * Inflate one ZIP entry while counting bytes, so a part whose directory record
 * under-reports its size still cannot exhaust memory. Uses JSZip's public
 * streaming helper (`internalStream`), pausing and dropping the stream as soon
 * as the limit is crossed.
 */
export function inflateEntryBounded(
  entry: JSZip.JSZipObject,
  limit = MAX_XLSX_ENTRY_BYTES,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = (entry as StreamingEntry).internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > limit) {
          settled = true;
          stream.pause();
          reject(new XlsxImportError(`The workbook part "${entry.name}" is too large to import.`, 413));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(out);
      })
      .resume();
  });
}

export async function inflateEntryText(entry: JSZip.JSZipObject, limit = MAX_XLSX_ENTRY_BYTES) {
  const bytes = await inflateEntryBounded(entry, limit);
  // Strip a UTF-8 BOM the way JSZip's text output does.
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(start ? bytes.subarray(start) : bytes);
}
