import { convert } from 'html-to-text';
import JSZip from 'jszip';
import { stripLoneSurrogates, truncateText } from '../shared/text';
import { MAX_CONTENT_CHARS } from './contract';

export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export async function boundedBytes(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error('File exceeds the indexing size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error('File exceeds the indexing size limit.');
      chunks.push(value.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function supportedContent(mime: string, name = '') {
  return (
    /^text\//.test(mime) ||
    /json|xml|pdf|openxmlformats|google-apps\.(document|spreadsheet|presentation)/.test(mime) ||
    /\.(md|txt|csv|json|pdf|docx|xlsx|pptx)$/i.test(name)
  );
}
export async function extractContent(
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<{ text: string; partial: boolean }> {
  let text = '';
  let partial = false;
  if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: bytes, useSystemFonts: true });
    const doc = await loading.promise;
    try {
      partial = doc.numPages > 80;
      for (let i = 1; i <= Math.min(doc.numPages, 80) && text.length <= MAX_CONTENT_CHARS; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += `\n[Page ${i}]\n${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}`;
      }
      // Scanned PDFs without selectable text remain explicitly incomplete.
      if (text.replace(/\[Page \d+\]/g, '').trim().length < 10) partial = true;
    } finally {
      await loading.destroy();
    }
  } else if (/openxmlformats/.test(mime) || /\.(docx|xlsx|pptx)$/i.test(name)) {
    const zip = await JSZip.loadAsync(bytes);
    const paths = Object.keys(zip.files)
      .filter((path) =>
        /^(word\/document|ppt\/slides\/slide\d+|xl\/(sharedStrings|worksheets\/sheet\d+))\.xml$/.test(path),
      )
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let expanded = 0;
    for (const path of paths.slice(0, 100)) {
      const entry = zip.files[path];
      const declaredSize = (entry as any)._data?.uncompressedSize;
      if (
        typeof declaredSize !== 'number' ||
        !Number.isFinite(declaredSize) ||
        declaredSize < 0 ||
        expanded + declaredSize > 16 * 1024 * 1024
      ) {
        partial = true;
        break;
      }
      expanded += declaredSize;
      const xml = await entry.async('string');
      text += `\n[${path}]\n${convert(xml.replace(/<\/(?:w:p|a:p|row)>/g, '\n'), { wordwrap: false })}`;
      if (text.length > MAX_CONTENT_CHARS) {
        partial = true;
        break;
      }
    }
    if (!paths.length || paths.length > 100) partial = true;
  } else {
    const decoded = new TextDecoder().decode(bytes);
    text = /html/.test(mime) ? convert(decoded, { wordwrap: false }) : decoded;
  }
  return {
    text: truncateText(stripLoneSurrogates(text), MAX_CONTENT_CHARS),
    partial: partial || text.length > MAX_CONTENT_CHARS,
  };
}
