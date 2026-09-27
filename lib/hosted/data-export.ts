// "Export my data": one ZIP with a JSON file for each user-scoped table in
// the deletion cascade, streamed as it is read. Each table file is pulled
// page by page only when the ZIP writer reaches it, so memory stays at about
// one page however large the account is.

import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { api, convexQuery } from './convex';
import { exportPageSize, REDACTED } from './export-redaction';
import { COMPANY_NAME, PRODUCT_NAME, SUPPORT_EMAIL } from './plans';

export interface ExportPage {
  page: unknown[];
  isDone: boolean;
  continueCursor: string;
}

export interface DataExportDependencies {
  tables(): Promise<string[]>;
  page(input: {
    userId: string;
    table: string;
    cursor: string | null;
    numItems: number;
  }): Promise<ExportPage>;
  now(): Date;
}

export const dataExportDefaults: DataExportDependencies = {
  tables: () => convexQuery<string[]>(api.accounts.exportTableList, {}),
  page: (input) => convexQuery<ExportPage>(api.accounts.exportUserTablePage, input),
  now: () => new Date(),
};

/**
 * Read one page, halving the page size while Convex refuses it as too large.
 * A page of one row that still fails is a real failure.
 */
export async function readExportPage(
  deps: Pick<DataExportDependencies, 'page'>,
  input: { userId: string; table: string; cursor: string | null; numItems: number },
): Promise<ExportPage> {
  let numItems = input.numItems;
  for (;;) {
    try {
      return await deps.page({ ...input, numItems });
    } catch (error) {
      if (numItems <= 1) throw error;
      numItems = Math.max(1, Math.floor(numItems / 2));
    }
  }
}

/** One table as a JSON array, one row per line, read page by page. */
export async function* tableJson(
  deps: Pick<DataExportDependencies, 'page'>,
  userId: string,
  table: string,
  counts: Record<string, number>,
): AsyncGenerator<string> {
  counts[table] = 0;
  let cursor: string | null = null;
  yield '[';
  for (;;) {
    const result = await readExportPage(deps, { userId, table, cursor, numItems: exportPageSize(table) });
    for (const row of result.page) {
      yield `${counts[table] === 0 ? '\n' : ',\n'}${JSON.stringify(row)}`;
      counts[table] += 1;
    }
    if (result.isDone || !result.continueCursor) break;
    cursor = result.continueCursor;
  }
  yield counts[table] ? '\n]\n' : ']\n';
}

export function exportReadme(exportedAt: Date): string {
  return [
    `${PRODUCT_NAME} data export`,
    `Made ${exportedAt.toISOString()} for the signed-in account.`,
    '',
    `Each file in data/ is one table that ${PRODUCT_NAME} keeps about you, as a JSON array of rows.`,
    'summary.json lists every file with its row count.',
    '',
    'What is not in this file:',
    `- Sign-in tokens, encrypted keys, push tokens, one-time codes, and sign-in state. They show as "${REDACTED}".`,
    '- Mail bodies. Your mail provider holds the original of every message; the export lists each',
    '  message with its headers, snippet, and labels.',
    '- Search data derived from your content (embeddings and search text).',
    '- Uploaded files and document versions. Their records are here; download the files from Files.',
    '',
    `Questions: ${SUPPORT_EMAIL} (${COMPANY_NAME}).`,
    '',
  ].join('\n');
}

export function exportFileName(date: Date): string {
  return `albatross-export-${date.toISOString().slice(0, 10)}.zip`;
}

/**
 * The export as a Node stream of ZIP bytes. Files are added in order and
 * written one at a time; summary.json is last, so its counts are final.
 */
export async function buildDataExport(
  userId: string,
  deps: DataExportDependencies = dataExportDefaults,
): Promise<{ stream: NodeJS.ReadableStream; fileName: string; tables: string[] }> {
  const exportedAt = deps.now();
  const tables = await deps.tables();
  const counts: Record<string, number> = {};
  const zip = new JSZip();
  zip.file('README.txt', exportReadme(exportedAt));
  for (const table of tables)
    zip.file(`data/${table}.json`, Readable.from(tableJson(deps, userId, table, counts)));
  zip.file(
    'summary.json',
    Readable.from(
      (async function* summary() {
        yield `${JSON.stringify(
          {
            product: PRODUCT_NAME,
            exportedAt: exportedAt.toISOString(),
            files: tables.map((table) => ({ file: `data/${table}.json`, rows: counts[table] ?? 0 })),
          },
          null,
          2,
        )}\n`;
      })(),
    ),
  );
  const stream = zip.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { stream, fileName: exportFileName(exportedAt), tables };
}

/**
 * A Node-style byte stream as a web stream for the Response body, with
 * backpressure: the ZIP writer (and so the Convex paging) waits while the
 * client is slow.
 */
export function toWebStream(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stream.on('data', (chunk: Buffer | string) => {
          controller.enqueue(
            typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
          );
          if ((controller.desiredSize ?? 1) <= 0) stream.pause();
        });
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
      pull() {
        stream.resume();
      },
      cancel() {
        stream.pause();
      },
    },
    { highWaterMark: 8 },
  );
}
