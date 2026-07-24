import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import { type BriefNodeContext, BriefNodeView } from '../components/report/brief-canvas/BriefNodeView';
import { briefRefKey } from '../lib/brief/hydration';
import type { BriefActionV2, BriefNode, BriefSourceRefV2 } from '../lib/shared/brief-document';
import {
  degenerateBriefDocumentFixture,
  futureBriefDocumentFixture,
  richBriefDocumentFixture,
} from '../lib/shared/brief-document-fixtures';

function render(value: unknown, extras?: { masthead?: boolean; footer?: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BriefCanvas value={value} masthead={extras?.masthead} footer={extras?.footer} />
    </QueryClientProvider>,
  );
}

describe('BriefCanvas degradation', () => {
  test('renders the complete native vocabulary without a full-page iframe', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).toContain('Thursday Brief');
    expect(html).toContain('Product review');
    expect(html).toContain('Review prep');
    expect(html).toContain('Shape of the day');
    expect(html).not.toContain('lab86-daily-report');
  });

  test('keeps fallback copy and hides unknown actions', () => {
    const html = render(degenerateBriefDocumentFixture);
    expect(html).toContain('A future leaf becomes a readable card.');
    expect(html).toContain('Tasks');
    expect(html).not.toContain('Dead action');
  });

  test('masthead hero and footer slot render around the document', () => {
    const html = render(richBriefDocumentFixture, {
      masthead: true,
      footer: <div>Footer slot content</div>,
    });
    expect(html).toContain('The Daily Brief');
    expect(html).toContain('Footer slot content');
    // The masthead owns the title; the plain header h1 must not duplicate it.
    expect(html.split('Thursday Brief').length - 1).toBe(1);
  });

  test('typography follows the customizer display face, not a fixed serif', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).toContain('font-display');
    expect(html).not.toContain('font-serif');
  });

  test('regions flow as newspaper columns of unbreakable, self-measuring blocks', () => {
    const html = render(richBriefDocumentFixture);
    // Wide containers get the 2- then 3-column flow; a rail-closed 16:9
    // display lands past the 1200px threshold.
    expect(html).toContain('@[840px]:columns-2');
    expect(html).toContain('@[1200px]:columns-3');
    // Column units never split mid-card and query their own column width.
    expect(html).toContain('break-inside-avoid');
    expect(html).toContain('@container mb-6 break-inside-avoid');
  });

  test('the three voices and the depth ladder reach the rendered document', () => {
    const html = render(richBriefDocumentFixture);
    // Editorial voice on kickers, highlight voice on lanes/badges/deltas.
    expect(html).toContain('--color-accent-2');
    expect(html).toContain('--color-accent-3');
    // The elevated hero climbs to the float rung; cards sit on the card rung.
    expect(html).toContain('--color-surface-float');
    expect(html).toContain('--color-bg-elevated');
  });

  test('the masthead title is bold and carries the editorial accent', () => {
    const html = render(richBriefDocumentFixture, { masthead: true });
    expect(html).toContain('font-bold');
    expect(html).toContain('--accent-2-hue');
  });

  test('future documents reduce to an accessible title and summary', () => {
    const html = render(futureBriefDocumentFixture);
    expect(html).toContain('A future brief');
    expect(html).toContain('Update Albatross');
  });
});

describe('BriefCanvas SBAR handoff rows', () => {
  test('renders singular and merged moves, reveals the evidence trail, and scopes actions to the merged handoff', async () => {
    const actionCalls: Array<{
      action: BriefActionV2;
      payload: Record<string, unknown>;
      sourceRef?: BriefSourceRefV2;
    }> = [];
    const context: BriefNodeContext = {
      entities: new Map(),
      hiddenRefs: new Set(),
      completedRefs: new Map(),
      onAction: (action, payload, sourceRef) => actionCalls.push({ action, payload, sourceRef }),
      onCanvasAction: () => {},
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<BriefNodeView node={handoffRows()} context={context} regionSummary="Needs you" />);
    });

    const initial = JSON.stringify(renderer.toJSON());
    expect(initial).toContain('My read: ');
    expect(initial).toContain('Merged assessment');
    expect(initial).toContain('Your moves');
    expect(initial).toContain('Reply to Maya');
    expect(initial).toContain('Update launch task');
    expect(initial).toContain('Your move');
    expect(initial).toContain('Confirm the date');
    expect(initial).not.toContain('Unique why-now trail');

    const whyButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-expanded'] === false);
    expect(whyButton).toBeDefined();
    await act(async () => whyButton?.props.onClick());
    const expanded = JSON.stringify(renderer.toJSON());
    expect(expanded).toContain('Unique why-now trail');
    expect(expanded).toContain('Source conversation');

    const openButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Open merged'));
    expect(openButton).toBeDefined();
    await act(async () => openButton?.props.onClick());
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]?.sourceRef).toEqual({
      kind: 'derived',
      id: 'handoff-merged:open_thread',
      label: 'Unique why-now trail',
    });
  });

  test('gone entities suppress stale handoff advice and show the unavailable notice', () => {
    const node = handoffRows();
    if (node.kind !== 'entity_list') throw new Error('Expected entity list fixture');
    const goneRef = node.items[0]!.ref;
    const context: BriefNodeContext = {
      entities: new Map([
        [
          briefRefKey(goneRef),
          {
            kind: 'thread',
            id: goneRef.id,
            account: goneRef.account,
            title: 'Merged item',
            gone: true,
          },
        ],
      ]),
      hiddenRefs: new Set(),
      completedRefs: new Map(),
      onAction: () => {},
      onCanvasAction: () => {},
    };

    const html = renderToStaticMarkup(
      <BriefNodeView
        node={{ ...node, items: [node.items[0]!] }}
        context={context}
        regionSummary="Needs you"
      />,
    );
    expect(html).toContain('This item is no longer available.');
    expect(html).not.toContain('Merged assessment');
    expect(html).not.toContain('Your moves');
  });
});

function handoffRows(): BriefNode {
  return {
    kind: 'entity_list',
    emphasis: 'standard',
    tone: 'neutral',
    variant: 'rows',
    items: [
      {
        ref: { kind: 'thread', id: 'thread-merged', account: 'jakob@example.com', label: 'Merged item' },
        framing: { lane: 'reply_owed' },
        handoff: {
          handoffId: 'handoff-merged',
          itemCount: 2,
          situation: 'Unique why-now trail',
          background: ['Maya asked for a date'],
          assessment: 'Merged assessment',
          recommendation: 'Reply to Maya',
          recommendations: [
            { label: 'Reply to Maya' },
            { label: 'Update launch task', ref: { kind: 'task', id: 'task-1' } },
          ],
          evidence: [{ label: 'Source conversation' }],
        },
        actions: [
          {
            action: 'open_thread',
            label: 'Open merged',
            payload: { account: 'jakob@example.com', threadId: 'thread-merged' },
            style: 'secondary',
          },
        ],
      },
      {
        ref: { kind: 'task', id: 'task-solo', label: 'Solo item' },
        framing: {},
        handoff: {
          itemCount: 1,
          situation: 'Date still open',
          background: [],
          assessment: 'Solo assessment',
          recommendation: 'Confirm the date',
          recommendations: [{ label: 'Confirm the date' }],
          evidence: [],
        },
        actions: [],
      },
    ],
  };
}
