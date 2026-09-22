import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { composeEditorialDocument, defaultEditorialPlan } from '../lib/brief/editorial';
import { editorialFixture } from '../tests/fixtures/editorial';
import preview from './fixtures/editorial-brief-preview.html';

const styles =
  (
    await postcss([tailwindcss({ base: process.cwd() })]).process(await readFile('app/globals.css', 'utf8'), {
      from: resolve('app/globals.css'),
    })
  ).css +
  `
@font-face { font-family: 'Preview Fraunces'; src: url('/fonts/Fraunces-Variable.woff2') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Preview Geist'; src: url('/fonts/Geist-Regular.woff2') format('woff2'); }
:root { --font-fraunces: 'Preview Fraunces'; --font-geist-sans: 'Preview Geist'; }
`;
const { edition, letter, modules } = editorialFixture();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18863,
  development: true,
  routes: { '/': preview },
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/fonts/Fraunces-Variable.woff2' || url.pathname === '/fonts/Geist-Regular.woff2')
      return new Response(Bun.file(`public${url.pathname}`));
    if (url.pathname === '/__document')
      return Response.json(
        url.searchParams.has('fallback')
          ? composeEditorialDocument(letter, modules, defaultEditorialPlan(modules))
          : edition.document,
      );
    if (url.pathname === '/preview.css')
      return new Response(styles, { headers: { 'content-type': 'text/css' } });
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Editorial brief preview: ${server.url}`);
