import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import preview from './fixtures/content-preview.html';

const styles = (
  await postcss([tailwindcss({ base: process.cwd() })]).process(await readFile('app/globals.css', 'utf8'), {
    from: resolve('app/globals.css'),
  })
).css;
const initial = () => ({
  _id: 'proposal-launch',
  revision: 1,
  userNotes: '',
  needsRefresh: false,
  preparedAt: Date.now(),
  updatedAt: Date.now(),
  sources: [
    {
      _id: 'source-1',
      title: 'Launch requirements',
      url: 'https://example.test/requirements',
      source: 'google_drive',
      modifiedAt: Date.now(),
      partial: false,
    },
  ],
  draft: {
    title: 'Prepare the September launch',
    shape: 'project',
    situation: 'Maya needs a launch plan. I found the requirements and prepared a draft for review.',
    background: 'The requirements call for signed approval and a support handoff.',
    assessment: 'The sequence is clear, but an owner for the support handoff is still missing.',
    recommendation: 'Review the draft and confirm the handoff owner before adopting this work.',
    questions: ['Who owns the support handoff?'],
    steps: ['Collect signed approval', 'Confirm support handoff'],
    files: [
      {
        name: 'launch-plan.md',
        content:
          '# September launch plan\n\n## Requirements\n- Obtain signed approval.\n- Confirm the support handoff owner.\n\n## First steps\n1. Review the requirements.\n2. Assign the support handoff.\n3. Confirm a launch date after approval.',
      },
    ],
    evidence: [
      { sourceId: 'source-1', quote: 'Signed approval and a support handoff are required before launch.' },
    ],
  },
});
let item = initial();
let visible = true;
let fail = false;
let preferences = { enabled: true, prepare: true };
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18859,
  development: true,
  routes: { '/': preview },
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/preview.css')
      return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    if (url.pathname === '/__reset') {
      item = initial();
      visible = true;
      fail = false;
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__change') {
      item.needsRefresh = true;
      item.draft = {
        ...item.draft,
        assessment: 'The requirements changed: support needs a walkthrough before launch.',
      };
      item.revision++;
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__fail') {
      fail = true;
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__state') return Response.json({ item, visible });
    if (url.pathname !== '/api/content') return new Response('Synthetic preview only', { status: 404 });
    if (fail)
      return Response.json({ error: 'Source temporarily unavailable. Please retry.' }, { status: 503 });
    if (request.method === 'GET')
      return url.searchParams.get('view') === 'brief'
        ? Response.json({ items: visible ? [item] : [] })
        : Response.json({
            preferences,
            sampleSize: 240,
            counts: { classified: 221, pending: 19, semantic: 233, partial: 7 },
            connections: [
              { connectionId: '__mail', status: 'ready', indexed: 120, updatedAt: Date.now(), skipped: 0 },
              {
                connectionId: 'drive-synthetic',
                displayName: 'Google Drive · Work',
                status: 'indexing',
                indexed: 97,
                skipped: 7,
                updatedAt: Date.now(),
              },
              {
                connectionId: 'slack-synthetic',
                displayName: 'Slack',
                status: 'provider_limited',
                indexed: 23,
                skipped: 0,
                updatedAt: Date.now(),
              },
            ],
          });
    const body = await request.json();
    if (body.operation === 'preferences') preferences = { enabled: body.enabled, prepare: body.prepare };
    else if (body.operation !== 'sync') {
      if (body.revision !== item.revision)
        return Response.json(
          { error: 'This preparation changed. Refresh it before continuing.' },
          { status: 409 },
        );
      if (body.operation === 'edit') {
        if (body.notes !== undefined && body.notes !== item.userNotes) item.needsRefresh = true;
        item.userNotes = body.notes ?? item.userNotes;
        item.userFiles = body.files ?? item.userFiles;
      }
      if (body.operation === 'refresh') {
        item.needsRefresh = false;
        item.draft.files = [
          {
            name: 'launch-plan.md',
            content: 'Updated suggested draft; user edits are preserved separately.',
          },
        ];
      }
      if (body.operation === 'dismiss' || body.operation === 'adopt') visible = false;
      item.revision++;
    }
    return Response.json({
      ok: true,
      result: body.operation === 'adopt' ? { workId: 'synthetic-work' } : { saved: true },
    });
  },
});
console.log(`Synthetic content preview: ${server.url}`);
