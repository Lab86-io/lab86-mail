/** Run `bun run build` first, then `bun scripts/preview-narrative-tools.mjs`.
 * Bundles the real components against synthetic responses on loopback only.
 */
import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, file, serve } from 'bun';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({
  entrypoints: [
    resolve(
      root,
      process.argv.includes('--today')
        ? 'scripts/fixtures/today-workspace-preview.tsx'
        : 'scripts/fixtures/narrative-tools-preview.tsx',
    ),
  ],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
});
if (!built.success) throw new Error(built.logs.map(String).join('\n'));
const script = await built.outputs[0].text();
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
const server = serve({
  hostname: '127.0.0.1',
  port: 18839,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css') return new Response(file(css.path));
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Narrative tools · synthetic preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Synthetic-only preview: ${server.url}`);
