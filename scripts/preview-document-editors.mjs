/** Actual UI + actual Office exports; isolated in-memory fixtures, loopback only. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { build, file, serve } from 'bun';
import postcss from 'postcss';
import { exportDocument } from '../lib/documents/export';
import { parseDocumentModel } from '../lib/documents/model';

const root = process.cwd();
const built = await build({
  entrypoints: [resolve(root, 'scripts/fixtures/document-editors-preview.tsx')],
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
const cssPath = resolve(root, 'app/globals.css');
const css = await postcss([tailwindcss({ base: root })]).process(await readFile(cssPath, 'utf8'), {
  from: cssPath,
});
const chunks = resolve(root, '.next/static/chunks');
const fonts = (
  await Promise.all(
    (
      await readdir(chunks)
    )
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFile(resolve(chunks, name), 'utf8')),
  )
).join('\n');
const fontFaces = [...fonts.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]).join('\n');
const fontVariables = [
  ...fonts.matchAll(/--font-(?:geist-sans|geist-mono|fraunces|averia|instrument):[^;}]+/g),
]
  .map((match) => match[0])
  .join(';');
const styles = `${fontFaces}\n${css.css}\n${componentCss}\n:root{${fontVariables}}`;
const record = (id, model) => ({
  documentId: id,
  title: id === 'doc' ? 'A clearer launch plan' : 'A calmer workspace',
  kind: model.kind,
  model,
  currentRevision: 1,
  sourceRefs: [],
  suggestions: [],
  createdAt: 1,
  updatedAt: 1,
});
const seeds = {
  doc: record('doc', {
    kind: 'doc',
    version: 1,
    blocks: [
      { id: 'heading', type: 'heading', level: 1, text: 'Make room for the work' },
      {
        id: 'body',
        type: 'paragraph',
        text: 'A useful workspace connects the decision, its evidence, and the next step.',
      },
      { id: 'bullet', type: 'bullet', text: 'Keep the details together' },
      { id: 'number', type: 'numbered', text: 'Start with one clear next step' },
    ],
  }),
  deck: record('deck', {
    kind: 'deck',
    version: 1,
    activeSlideId: 'intro',
    slides: [
      {
        id: 'intro',
        title: 'Make room for the work',
        background: '#F3F6F1',
        notes: 'Introduce the working loop.',
        elements: [
          {
            id: 'accent',
            type: 'shape',
            x: 8,
            y: 18,
            width: 2,
            height: 60,
            fill: '#266449',
            color: '#266449',
          },
          {
            id: 'title',
            type: 'text',
            role: 'title',
            x: 15,
            y: 22,
            width: 76,
            height: 24,
            text: 'Make room for the work',
            fontSize: 42,
            color: '#163328',
          },
          {
            id: 'body',
            type: 'text',
            role: 'body',
            x: 15,
            y: 53,
            width: 70,
            height: 22,
            text: 'One clear next step.\nThe context to move it forward.',
            fontSize: 24,
            color: '#405B4D',
          },
        ],
      },
      {
        id: 'next',
        title: 'The next step',
        elements: [
          {
            id: 'next-title',
            type: 'text',
            role: 'title',
            x: 10,
            y: 20,
            width: 80,
            height: 30,
            text: 'The next step',
            fontSize: 38,
          },
        ],
      },
    ],
  }),
};
let records = structuredClone(seeds);
const json = (value, status = 200) => Response.json(value, { status });
const server = serve({
  hostname: '127.0.0.1',
  port: 18848,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture-reset' && request.method === 'POST') {
      records = structuredClone(seeds);
      return json({ ok: true });
    }
    if (path === '/preview.js')
      return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path === '/preview.css') return new Response(styles, { headers: { 'content-type': 'text/css' } });
    if (/^\/media\/[a-zA-Z0-9._~-]+\.(woff2?|ttf|otf)$/.test(path))
      return new Response(file(resolve(root, '.next/static', path.slice(1))));
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/files/google/editor') {
      const saved = records.doc;
      if (request.method === 'PATCH') {
        const input = await request.json();
        saved.model = parseDocumentModel(input.model);
        saved.currentRevision++;
      }
      return json({
        ok: true,
        file: {
          ...saved,
          source: 'google_drive',
          connectionId: 'synthetic',
          fileId: 'google',
          mimeType: 'application/vnd.google-apps.document',
          providerVersion: String(saved.currentRevision),
          editability: { editable: true },
        },
      });
    }
    const match = /^\/api\/documents\/(doc|deck)(\/export)?$/.exec(path);
    if (match) {
      const saved = records[match[1]];
      if (match[2]) {
        const output = await exportDocument(saved);
        return new Response(output.bytes, {
          headers: {
            'content-type': output.contentType,
            'content-disposition': `attachment; filename="synthetic.${output.extension}"`,
          },
        });
      }
      if (request.method === 'PATCH') {
        const input = await request.json();
        if (input.expectedRevision !== saved.currentRevision)
          return json({ ok: false, error: 'Synthetic conflict' }, 409);
        records[match[1]] = {
          ...saved,
          title: input.title,
          model: parseDocumentModel(input.model, saved.kind),
          currentRevision: saved.currentRevision + 1,
        };
      }
      return json({ ok: true, document: records[match[1]] });
    }
    if (path === '/')
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document editors · synthetic acceptance</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    return json({ ok: false, error: 'Synthetic preview: endpoint unavailable' }, 404);
  },
});
console.log(`Synthetic document editing: ${server.url}`);
