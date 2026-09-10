/** Synthetic-only Notifications preview. Uses current app CSS, never account data. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { build, file, serve } from 'bun';
import postcss from 'postcss';

const root = process.cwd();
const result = await build({
  entrypoints: [resolve(root, 'scripts/fixtures/notifications-preview.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
});
if (!result.success) throw new Error(result.logs.map(String).join('\n'));
const script = await result.outputs[0].text();
const cssFile = resolve(root, 'app/globals.css');
const css = await postcss([tailwindcss({ base: root })]).process(await readFile(cssFile, 'utf8'), {
  from: cssFile,
});
const chunkRoot = resolve(root, '.next/static/chunks');
const existing = await readdir(chunkRoot).catch(() => []);
const fonts = (
  await Promise.all(
    existing
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFile(resolve(chunkRoot, name), 'utf8')),
  )
).join('\n');
const fontFaces = [...fonts.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]).join('\n');
const fontVariables = [...fonts.matchAll(/--font-(?:geist-sans|geist-mono|fraunces|averia):[^;}]+/g)]
  .map((match) => match[0])
  .join(';');
const styles = `${fontFaces}\n${css.css}\n:root{${fontVariables}}`;
const server = serve({
  hostname: '127.0.0.1',
  port: 18843,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css') return new Response(styles, { headers: { 'content-type': 'text/css' } });
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notifications · synthetic preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Notifications synthetic preview: ${server.url}`);
