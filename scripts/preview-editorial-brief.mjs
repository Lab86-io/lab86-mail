import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { NextRequest } from 'next/server';
import postcss from 'postcss';
import { createBriefComponentRoutes } from '../app/api/briefs/components/route';
import { createBriefComponentStore } from '../lib/brief/component-state';
import { composeEditorialDocument, defaultEditorialPlan } from '../lib/brief/editorial';
import { briefComponentFixtures } from '../tests/fixtures/brief-components';
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
const sourceId = modules.find((module) => module.id.startsWith('thread:')).id;
const component = (name, id, sources = [sourceId], props = briefComponentFixtures[name]) => ({
  kind: 'component',
  id,
  component: name,
  props,
  sources,
  summary:
    name === 'option-list'
      ? 'How should we prepare the review?'
      : String(props.title || name.replaceAll('-', ' ')),
});
const remainder = modules.filter((module) => !['lede', sourceId].includes(module.id));
const authoredPlan = {
  version: 1,
  regions: [
    {
      id: 'opening',
      summary: 'The support decision',
      tree: component('editorial-text', 'lead-story', ['lede', sourceId]),
    },
    {
      id: 'comparison',
      summary: 'Compare the quoted costs',
      tree: {
        kind: 'split',
        ratio: 'balanced',
        children: [component('data-table', 'quotes'), component('chart', 'quote-chart')],
      },
    },
    {
      id: 'prepare',
      summary: 'Choose how to prepare the review',
      tree: {
        kind: 'split',
        ratio: 'balanced',
        children: [component('option-list', 'review-choice'), component('parameter-slider', 'review-time')],
      },
    },
    { id: 'draft', summary: 'Prepare a response', tree: component('message-draft', 'review-draft') },
    ...defaultEditorialPlan(remainder).regions,
  ],
};
const authored = composeEditorialDocument(letter, modules, authoredPlan);
const names = Object.keys(briefComponentFixtures);
const cataloguePlan = {
  version: 1,
  regions: Array.from({ length: Math.ceil(names.length / 4) }, (_, i) => ({
    id: `catalogue-${i}`,
    summary: 'Synthetic component catalogue',
    tree: {
      kind: 'stack',
      children: names.slice(i * 4, i * 4 + 4).map((name) => component(name, `example-${name}`, ['lede'])),
    },
  })),
};
cataloguePlan.regions.push({
  id: 'remaining',
  summary: 'Existing sources',
  tree: {
    kind: 'stack',
    children: modules.filter((m) => m.id !== 'lede').map((m) => ({ kind: 'module', id: m.id })),
  },
});
const catalogue = composeEditorialDocument(letter, modules, cataloguePlan);
const reports = new Map([
  [
    'preview',
    { ...edition, _id: 'preview', document: authored, editorial: { plan: authoredPlan, mode: 'generated' } },
  ],
  [
    'catalogue',
    {
      ...edition,
      _id: 'catalogue',
      document: catalogue,
      editorial: { plan: cataloguePlan, mode: 'generated' },
    },
  ],
]);
const answers = new Map();
const store = createBriefComponentStore({
  report: async (id) => reports.get(id) ?? null,
  get: async (_, key) => answers.get(key) ?? null,
  save: async (_, key, revision, value) => {
    if ((answers.get(key)?.revision ?? null) !== revision) return false;
    answers.set(key, value);
    return true;
  },
});
const routes = createBriefComponentRoutes({
  user: async () => ({ userId: 'synthetic-preview' }),
  store,
  rate: async () => {},
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PREVIEW_PORT || 18863),
  development: true,
  routes: { '/': preview },
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__reset' && request.method === 'POST') {
      answers.clear();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/briefs/components')
      return routes[request.method === 'POST' ? 'POST' : 'GET'](new NextRequest(request));
    if (url.pathname === '/fonts/Fraunces-Variable.woff2' || url.pathname === '/fonts/Geist-Regular.woff2')
      return new Response(Bun.file(`public${url.pathname}`));
    if (url.pathname === '/__document')
      return Response.json(
        url.searchParams.has('fallback')
          ? composeEditorialDocument(letter, modules, defaultEditorialPlan(modules))
          : url.searchParams.has('catalogue')
            ? catalogue
            : authored,
      );
    if (url.pathname === '/preview.css')
      return new Response(styles, { headers: { 'content-type': 'text/css' } });
    return new Response('Synthetic preview only', { status: 404 });
  },
});
console.log(`Editorial brief preview: ${server.url}`);
