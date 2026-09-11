/** Synthetic, reversible provider round-trip; never touches an existing file. */
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { exportDocument } from '../lib/documents/export';
import {
  __setGoogleWorkingCopyDepsForTest,
  downloadGoogleWorkingCopy,
  saveGoogleWorkingCopy,
} from '../lib/documents/google-working-copy';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { OFFICE_MIME } from '../lib/documents/office-security';
import { getCloudFileAccess } from '../lib/files/connections';

__setGoogleWorkingCopyDepsForTest({
  fetch: async (...args) => {
    const response = await fetch(...args);
    if (!response.ok)
      console.log('Synthetic Google response:', response.status, await response.clone().text());
    return response;
  },
});
const records = JSON.parse(readFileSync('/tmp/chat-doc-google-connections.json', 'utf8'));
const connection = records.find((r: any) => r.status === 'connected');
if (!connection) throw new Error('No connected Google Drive account available for live verification.');
const access = await getCloudFileAccess({ userId: connection.userId, connectionId: connection.connectionId });
if (!access) throw new Error('Google access unavailable.');
for (const kind of ['doc', 'sheet', 'deck'] as const) {
  const model = createDefaultDocumentModel(kind);
  const exported = await exportDocument({
    documentId: 'synthetic',
    title: 'Albatross editor verification',
    kind,
    model,
    currentRevision: 1,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const boundary = `test_${crypto.randomUUID()}`;
  const native = `application/vnd.google-apps.${kind === 'doc' ? 'document' : kind === 'sheet' ? 'spreadsheet' : 'presentation'}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: `Albatross synthetic ${kind} save verification`, mimeType: native })}\r\n--${boundary}\r\nContent-Type: ${OFFICE_MIME[exported.extension]}\r\n\r\n`,
    ),
    Buffer.from(exported.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!created.ok) throw new Error(`Synthetic Google create failed (${created.status}).`);
  const { id: fileId } = (await created.json()) as any;
  try {
    const copy = await downloadGoogleWorkingCopy({
      userId: connection.userId,
      connectionId: connection.connectionId,
      fileId,
    });
    const zip = await JSZip.loadAsync(copy.bytes);
    const marker = `ALBATROSS-SAVE-${crypto.randomUUID()}`;
    const entry =
      kind === 'doc'
        ? 'word/document.xml'
        : kind === 'sheet'
          ? 'xl/worksheets/sheet1.xml'
          : 'ppt/slides/slide1.xml';
    let xml = await zip.file(entry)!.async('string');
    if (kind === 'doc') xml = xml.replace('</w:body>', `<w:p><w:r><w:t>${marker}</w:t></w:r></w:p></w:body>`);
    if (kind === 'sheet')
      xml = xml
        .replace(/<sheetData(?:\s[^>]*)?\/>/, '<sheetData></sheetData>')
        .replace(
          '</sheetData>',
          `<row r="20"><c r="A20" t="inlineStr"><is><t>${marker}</t></is></c></row></sheetData>`,
        );
    if (kind === 'deck') xml = xml.replace(/<a:t>[^<]*<\/a:t>/, `<a:t>${marker}</a:t>`);
    if (!xml.includes(marker)) throw new Error('Fixture mutation did not insert marker.');
    zip.file(entry, xml);
    let edited = await zip.generateAsync({ type: 'uint8array' });
    if (kind === 'sheet') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(copy.bytes) as any);
      workbook.worksheets[0].getCell('A20').value = marker;
      edited = new Uint8Array(await workbook.xlsx.writeBuffer());
    }
    const saved = await saveGoogleWorkingCopy({
      userId: connection.userId,
      session: copy.session,
      bytes: edited,
      extension: copy.extension,
    });
    if (saved.fileId !== fileId) throw new Error('Save changed the file ID.');
    const reopened = await downloadGoogleWorkingCopy({
      userId: connection.userId,
      connectionId: connection.connectionId,
      fileId,
    });
    const output = await JSZip.loadAsync(reopened.bytes);
    const texts = await Promise.all(
      Object.values(output.files)
        .filter((file) => file.name.endsWith('.xml'))
        .map((file) => file.async('string')),
    );
    if (!texts.join('\n').includes(marker))
      throw new Error(`${kind} save marker missing after reopening Google file.`);
    console.log(
      `${kind.toUpperCase()}: Google export → edit → conditional save → reopen verified; original file ID retained.`,
    );
    // A second save with the old token must not overwrite the newly saved file.
    let conflict = false;
    try {
      await saveGoogleWorkingCopy({
        userId: connection.userId,
        session: copy.session,
        bytes: edited,
        extension: copy.extension,
      });
    } catch (error: any) {
      conflict = error.status === 409;
    }
    if (!conflict) throw new Error('Stale save was not refused.');
    console.log(`${kind.toUpperCase()}: stale-copy conflict verified.`);
  } finally {
    const cleanup = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${access.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    if (!cleanup.ok) {
      console.error(`Synthetic file cleanup failed (${cleanup.status}).`);
      process.exitCode = 1;
    }
    console.log(`${kind.toUpperCase()}: synthetic file moved to Trash.`);
  }
}
