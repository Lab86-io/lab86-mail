/** Loopback-only synthetic Mail preview, current app CSS plus built font assets. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import { build, file, serve } from 'bun';
import postcss from 'postcss';
import { GROTESK_FONT_FAMILY } from '../lib/theme/font-families.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({
  entrypoints: [resolve(root, 'scripts/fixtures/mail-foundations-preview.tsx')],
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
const server = serve({
  hostname: '127.0.0.1',
  port: 18844,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css')
      return new Response(previewStyles, { headers: { 'content-type': 'text/css' } });
    if (path === '/synthetic-avatar.svg')
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" fill="#517267"/><path d="M6 21V7l16 14V7" fill="none" stroke="#f4f1e7" stroke-width="2.5"/></svg>',
        { headers: { 'content-type': 'image/svg+xml' } },
      );
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail foundations · synthetic preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Synthetic-only Mail preview: ${server.url}`);
