/** Actual-app development server with Bun React Fast Refresh and synthetic data. */
import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { file, serve } from 'bun';
import postcss from 'postcss';
import preview from './fixtures/app-workspace-preview.html';

const root = process.cwd();
const chunks = resolve(root, '.next/static/chunks');
const compiledCss = (
  await Promise.all(
    (
      await readdir(chunks)
    )
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFile(resolve(chunks, name), 'utf8')),
  )
).join('\n');
const fontFaces = [...compiledCss.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]).join('\n');
const fontVariables = [
  ...compiledCss.matchAll(/--font-(?:geist-sans|geist-mono|fraunces|averia|instrument):[^;}]+/g),
]
  .map((match) => match[0])
  .join(';');

const cssPath = resolve(root, 'app/globals.css');
let styles = '';
let cssVersion = 0;
const clients = new Set();
async function rebuildStyles() {
  const css = await postcss([tailwindcss({ base: root })]).process(await readFile(cssPath, 'utf8'), {
    from: cssPath,
  });
  styles = `${fontFaces}\n${css.css}\n:root{${fontVariables}}`;
  cssVersion += 1;
  for (const controller of clients) controller.enqueue(new TextEncoder().encode(`data: ${cssVersion}\n\n`));
}
await rebuildStyles();
let pending;
let building = false;
let queued = false;
async function updateStyles() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  try {
    await rebuildStyles();
  } catch (error) {
    console.error('[preview css]', error.message);
  } finally {
    building = false;
    if (queued) {
      queued = false;
      void updateStyles();
    }
  }
}
for (const directory of ['app', 'components', 'lib', 'scripts/fixtures']) {
  watch(resolve(root, directory), { recursive: true }, (_event, filename) => {
    if (!filename || !/\.(css|tsx?|jsx?)$/.test(filename)) return;
    clearTimeout(pending);
    pending = setTimeout(updateStyles, 150);
  });
}
const server = serve({
  hostname: process.env.ALBATROSS_PREVIEW_HOST || '127.0.0.1',
  port: Number(process.env.ALBATROSS_PREVIEW_PORT || 18847),
  development: { hmr: true, console: false },
  idleTimeout: 0,
  routes: { '/': preview },
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.css')
      return new Response(styles, { headers: { 'content-type': 'text/css', 'cache-control': 'no-store' } });
    if (path === '/preview-css-events') {
      let controller;
      return new Response(
        new ReadableStream({
          start(value) {
            controller = value;
            clients.add(value);
            value.enqueue(new TextEncoder().encode(`data: ${cssVersion}\n\n`));
          },
          cancel() {
            clients.delete(controller);
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
      );
    }
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (/^\/frames\/[a-z0-9-]+\.(png|svg)$/.test(path) || /^\/art\/fallback-[123]\.jpg$/.test(path))
      return new Response(file(resolve(root, 'public', path.slice(1))));
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Albatross dev preview (React Fast Refresh): ${server.url}`);
