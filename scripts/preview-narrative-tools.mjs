/** Run `bun run build` first, then `bun scripts/preview-narrative-tools.mjs`.
 * Bundles the real components against synthetic responses on loopback only.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import { build, file, serve } from 'bun';
import postcss from 'postcss';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({
  entrypoints: [
    resolve(
      root,
      process.argv.includes('--controls')
        ? 'scripts/fixtures/controls-preview.tsx'
        : process.argv.includes('--files')
          ? 'scripts/fixtures/files-preview.tsx'
          : process.argv.includes('--today')
            ? 'scripts/fixtures/today-workspace-preview.tsx'
            : 'scripts/fixtures/narrative-tools-preview.tsx',
    ),
  ],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
});
if (!built.success) throw new Error(built.logs.map(String).join('\n'));
const script = await built.outputs.find((output) => output.path.endsWith('.js')).text();
const componentCss = (
  await Promise.all(
    built.outputs.filter((output) => output.path.endsWith('.css')).map((output) => output.text()),
  )
).join('\n');
// Turbopack emits CSS in chunks; Webpack builds may use static/css.
const candidates = (
  await Promise.all(
    ['chunks', 'css'].map(async (directory) => {
      const cssRoot = resolve(root, '.next/static', directory);
      const names = await readdir(cssRoot).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      return Promise.all(
        names
          .filter((name) => name.endsWith('.css'))
          .map(async (name) => {
            const path = resolve(cssRoot, name);
            return { path, size: (await stat(path)).size };
          }),
      );
    }),
  )
).flat();
const css = candidates.sort((a, b) => b.size - a.size)[0];
if (!css) throw new Error('Build the app before previewing its actual styles.');
// Fonts are emitted in a separate chunk. Include them and the layout's font
// variables so screenshots exercise production typography, not fallback fonts.
const styles = (await Promise.all(candidates.map((entry) => file(entry.path).text()))).join('\n');
const fontVariables = [...styles.matchAll(/--font-(?:geist-sans|geist-mono|fraunces|averia):[^;}]+/g)]
  .map((match) => match[0])
  .join(';');
// Reuse built font assets, but compile current app/component styles. A saved
// .next stylesheet can predate the editor under review and invalidate visual
// acceptance by silently dropping its new classes.
const cssPath = resolve(root, 'app/globals.css');
const currentCss = await postcss([tailwindcss({ base: root })]).process(await readFile(cssPath, 'utf8'), {
  from: cssPath,
});
const fontFaces = [...styles.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]).join('\n');
const previewStyles = `${fontFaces}\n${currentCss.css}\n${componentCss}\n:root{${fontVariables}}`;
const server = serve({
  hostname: '127.0.0.1',
  port: Number(process.env.NARRATIVE_PREVIEW_PORT || (process.argv.includes('--controls') ? 18840 : 18839)),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css')
      return new Response(previewStyles, { headers: { 'content-type': 'text/css' } });
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Narrative tools · synthetic preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Synthetic-only preview: ${server.url}`);
