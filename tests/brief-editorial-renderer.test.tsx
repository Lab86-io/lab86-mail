import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import { type BriefNodeContext, BriefNodeView } from '../components/report/brief-canvas/BriefNodeView';
import { briefRefKey } from '../lib/brief/hydration';
import { BriefNodeSchema } from '../lib/shared/brief-document';
import { editorialFixture } from './fixtures/editorial';

test('email and hydrated event times use the edition timezone consistently', () => {
  const at = Date.parse('2026-09-22T15:00:00Z');
  const ref = { kind: 'event' as const, id: 'review', account: 'owner' };
  const context: BriefNodeContext = {
    timezone: 'America/Los_Angeles',
    entities: new Map([[briefRefKey(ref), { ...ref, title: 'Review', startAt: at, gone: false }]]),
    hiddenRefs: new Set(),
    completedRefs: new Map(),
    onAction: () => {},
    onCanvasAction: () => {},
  };
  for (const input of [
    {
      kind: 'email_preview',
      title: 'Message',
      sender: 'Maya',
      snippet: 'Review',
      sentAt: at,
      ref: { kind: 'thread', id: 'message', account: 'owner' },
      sourceRefs: [{ kind: 'thread', id: 'message', account: 'owner' }],
    },
    { kind: 'entity_list', items: [{ ref, framing: {}, actions: [] }] },
  ]) {
    const node = BriefNodeSchema.parse(input);
    const html = renderToStaticMarkup(<BriefNodeView node={node} context={context} />);
    expect(html).toContain('Tue 8:00 AM');
    expect(html).not.toContain('3:00 PM');
  }
});

function render(liveSections: boolean, enabled = true, legacy = false) {
  const { edition, letter } = editorialFixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(
    ['narrative', 'brief', edition.generatedAt],
    enabled
      ? {
          enabled: true,
          entry: {
            _id: 'private-entry',
            text: 'Private personal context.',
            sourceIds: ['observed'],
            updatedAt: 1,
            model: 'writer',
          },
        }
      : { enabled: false },
  );
  client.setQueryData(['narrative', 'workspace', edition.generatedAt, 1], {
    enabled: true,
    mode: 'generated',
    threads: [],
  });
  client.setQueryData(
    ['brief-preparations'],
    enabled
      ? {
          items: [
            {
              _id: 'prep',
              revision: 1,
              userNotes: '',
              needsRefresh: false,
              updatedAt: 1,
              sources: [],
              draft: {
                title: 'Support preparation',
                shape: 'project',
                situation: 'Review the support plan.',
                files: [],
                questions: [],
                steps: [],
                evidence: [],
              },
            },
          ],
        }
      : { items: [] },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BriefCanvas value={legacy ? letter : edition.document} embedded liveSections={liveSections} />
    </QueryClientProvider>,
  );
}

test('authored daily layouts preserve groups and avoid duplicated ledes and outer cards', () => {
  const html = render(false);
  expect(html).toContain('Before the review');
  expect(html).toContain('On the calendar');
  expect(html).toContain('Mon 9:00 AM');
  expect(html).toContain('Since yesterday');
  expect(html).toContain('The week ahead');
  expect(html).toContain('brief-emphasis-primary');
  expect(html).toContain('Complete Review the support handoff');
  expect(html.match(/Make room for the launch review/g)).toHaveLength(1);
  expect(html).toContain('brief-canvas--authored');
  expect(html).not.toContain('data-brief-letter=');
  expect(html).not.toContain('ring-1 ring-white/35');
});

test('current editions retain context actions and exactly one prepared-work module', () => {
  const html = render(true);
  expect(html).toContain('rivate personal context.');
  expect(html).toContain('data-today-workspace');
  expect(html.match(/id="prepared-work-heading"/g)).toHaveLength(1);
  expect(html).toContain('Support preparation');
});

test('history does not mount live private modules, and permission revocation removes current personal content', () => {
  for (const html of [render(false), render(true, false)]) {
    expect(html).not.toContain('rivate personal context.');
    expect(html).not.toContain('Support preparation');
    expect(html).not.toContain('data-today-workspace');
    expect(html).toContain('Confirm the launch budget');
  }
});

test('the same historical boundary applies to older letter editions', () => {
  expect(render(true, true, true)).toContain('rivate personal context.');
  expect(render(false, true, true)).not.toContain('rivate personal context.');
  expect(render(false, true, true)).toContain('Make room for the launch review.');
});
