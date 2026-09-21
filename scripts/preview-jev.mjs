/** Loopback-only synthetic transport; uses the real Jev Settings and reader components. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import preview from './fixtures/jev-preview.html';

const root = process.cwd();
const styles = (
  await postcss([tailwindcss({ base: root })]).process(
    await readFile(resolve(root, 'app/globals.css'), 'utf8'),
    { from: resolve(root, 'app/globals.css') },
  )
).css;
const initial = () => ({
  preferences: { ...DEFAULT_JEV_PREFERENCES },
  corrections: [],
  revision: 0,
  configured: true,
  configurationMessage: null,
  model: 'typesafe/jev-1.13',
  counts: { accepted: 321, uncertain: 7, pending: 2, unavailable: 0 },
  sampledThreads: 330,
  sampleLimit: 500,
  lastEvaluatedAt: Date.parse('2026-09-21T12:00:00Z'),
});
let state = initial();
const calls = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18848,
  development: true,
  routes: { '/': preview },
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/preview.css') return new Response(styles, { headers: { 'content-type': 'text/css' } });
    if (path === '/__preview/reset') {
      state = initial();
      calls.length = 0;
      return Response.json({ ok: true });
    }
    if (path === '/__preview/state') return Response.json({ state, calls });
    if (path !== '/api/jev/settings') return new Response('Synthetic preview only', { status: 404 });
    if (request.method === 'GET') return Response.json(state);
    const body = await request.json();
    calls.push(body);
    if (body.action === 'save') {
      if (body.revision !== state.revision)
        return Response.json({ error: 'Settings changed.' }, { status: 409 });
      state = {
        ...state,
        preferences: body.preferences,
        corrections: body.corrections,
        revision: state.revision + 1,
      };
    }
    return Response.json({ ...state, ok: true });
  },
});
console.log(`Synthetic Jev preview: ${server.url}`);
