/** Loopback-only synthetic spreadsheet preview: fresh PostCSS of app/globals.css, built fonts, vendored engine assets. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import { build, file, serve } from 'bun';
import postcss from 'postcss';
import { createDefaultDocumentModel } from '../lib/documents/model.ts';
import { applySpreadsheetChanges } from '../lib/documents/spreadsheet-server.ts';
import { GROTESK_FONT_FAMILY } from '../lib/theme/font-families.ts';
import { changes, suiteCommands } from './fixtures/spreadsheet-suite-plan.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({
  entrypoints: [resolve(root, 'scripts/fixtures/spreadsheet-preview.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
});
if (!built.success) throw new Error(built.logs.map(String).join('\n'));
const script = await built.outputs[0].text();
const cssPaths = (
  await Promise.all(
    ['chunks', 'css'].map(async (directory) => {
      const cssRoot = resolve(root, '.next/static', directory);
      const names = await readdir(cssRoot).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      return names.filter((name) => name.endsWith('.css')).map((name) => resolve(cssRoot, name));
    }),
  )
).flat();
if (!cssPaths.length) throw new Error('Build the app once so the preview can use actual font assets.');
const builtStyles = (await Promise.all(cssPaths.map((path) => file(path).text()))).join('\n');
const fontVariables = [
  ...builtStyles.matchAll(/--font-(?:geist-sans|geist-mono|fraunces|averia|instrument):[^;}]+/g),
]
  .map((match) => match[0])
  .join(';');
const fontFaces = [...builtStyles.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]).join('\n');
const cssFile = resolve(root, 'app/globals.css');
const styles = await postcss([tailwindcss({ base: root })]).process(await readFile(cssFile, 'utf8'), {
  from: cssFile,
});
const previewStyles = `${fontFaces}\n${styles.css}\n:root{${fontVariables};--font-hanken:${GROTESK_FONT_FAMILY}}`;
const suiteWorkbook = await applySpreadsheetChanges(createDefaultDocumentModel('sheet', 'suite'), {
  kind: 'sheet-changes',
  version: 1,
  changes,
  commands: suiteCommands,
});
const server = serve({
  hostname: '127.0.0.1',
  port: 18846,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/suite-workbook.json') return Response.json(suiteWorkbook);
    if (path === '/execute-sheet' && request.method === 'POST')
      return request
        .json()
        .then(({ model, plan }) => applySpreadsheetChanges(model, plan))
        .then((result) => Response.json(result));
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css')
      return new Response(previewStyles, { headers: { 'content-type': 'text/css' } });
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (/^\/vendor\/[a-zA-Z0-9._~/-]+$/.test(path) && !path.includes('..'))
      return new Response(file(resolve(root, 'public', path.slice(1))));
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spreadsheet · synthetic preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Synthetic-only spreadsheet preview: ${server.url}`);
