/** Run each pinned-engine operation in a terminable worker, isolated from request traffic. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AlbatrossDocumentModel } from './model';
import {
  assertModelWithinLimit,
  ODOO_SPREADSHEET_VERSION,
  type SheetChangeSet,
  type SheetWorkbookModel,
  sheetChangeSetSchema,
  sheetWorkbookModelSchema,
} from './sheet-workbook';
import { validateSpreadsheetCommand } from './spreadsheet-commands';

const require = createRequire(import.meta.url);
export async function applySpreadsheetChanges(
  source: AlbatrossDocumentModel,
  input: SheetChangeSet,
  options: { timeoutMs?: number } = {},
): Promise<SheetWorkbookModel> {
  if (source.kind !== 'sheet') throw new Error('Spreadsheet commands require a spreadsheet.');
  const plan = sheetChangeSetSchema.parse(input);
  plan.commands?.forEach(validateSpreadsheetCommand);
  assertModelWithinLimit(plan);
  assertModelWithinLimit(source);
  const output = await new Promise<unknown>((resolve, reject) => {
    // Spawn the traced worker as a runtime asset; Turbopack rewrites fork() module paths.
    const worker = spawn(
      process.versions.bun ? 'node' : process.execPath,
      ['--max-old-space-size=256', join(process.cwd(), 'lib/documents/spreadsheet-worker.mjs')],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
      },
    );
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill('SIGKILL');
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error('Spreadsheet editing timed out. No changes were saved.')),
      Math.min(15_000, Math.max(1, options.timeoutMs ?? 15_000)),
    );
    worker.once('message', (message: any) =>
      finish(message.error ? new Error(message.error) : undefined, message.output),
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`Spreadsheet worker exited before returning a result (${code}).`));
    });
    worker.send!(
      {
        source,
        plan,
        version: ODOO_SPREADSHEET_VERSION,
        jsdomPath: require.resolve('jsdom'),
        canvasPath: require.resolve('@napi-rs/canvas'),
        enginePaths: [
          require.resolve('@odoo/owl/dist/owl.iife.js'),
          require.resolve('@odoo/o-spreadsheet/dist/o_spreadsheet.iife.js'),
        ],
      },
      (error) => {
        if (error) finish(error);
      },
    );
  });
  const result = sheetWorkbookModelSchema.parse(output);
  assertModelWithinLimit(result);
  return result;
}
