import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BriefCanvas, briefGridRowSpan } from '../components/report/brief-canvas/BriefCanvas';
import { type BriefNodeContext, BriefNodeView } from '../components/report/brief-canvas/BriefNodeView';
import { briefRefKey } from '../lib/brief/hydration';
import type {
  BriefActionV2,
  BriefDocumentV2,
  BriefNode,
  BriefSourceRefV2,
} from '../lib/shared/brief-document';
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
    expect(html).toContain('The Monday Brief');
    expect(html).toContain('Footer slot content');
    // A stale/model-authored title never displaces the stable edition name.
    expect(html).not.toContain('Thursday Brief');
    expect(html).toContain('first-letter:text-5xl');
    expect(html).not.toContain('Native live brief');
  });

  test('typography follows the customizer display face, not a fixed serif', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).toContain('font-display');
    expect(html).not.toContain('font-serif');
  });

  test('regions use a responsive packed editorial grid without fixed feature height', () => {
    const html = render(richBriefDocumentFixture);
    expect(html).toContain('@[840px]:grid-cols-2');
    expect(html).toContain('@[1200px]:grid-cols-3');
    expect(html).toContain('@[840px]:col-span-2');
    expect(html).toContain('@[1200px]:col-span-3');
    expect(html).toContain('--brief-grid-row:8px');
    expect(html).toContain('data-brief-editorial-grid');
    expect(html).toContain('data-brief-story-card');
    expect(html).not.toContain('grid-flow-dense');
    expect(html).not.toContain('@[840px]:row-span-2');
    expect(html).not.toContain('min-h-[420px]');
  });

  test('packed row spans follow actual measured height', () => {
    expect(briefGridRowSpan(0)).toBe(1);
    expect(briefGridRowSpan(8)).toBe(1);
    expect(briefGridRowSpan(9)).toBe(2);
    expect(briefGridRowSpan(420)).toBe(53);
    expect(briefGridRowSpan(Number.NaN)).toBe(1);
  });

  test('measures story rows after the client layout mounts', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const document: BriefDocumentV2 = {
      version: 2,
      title: 'Measured brief',
      summary: 'One measured story.',
      generatedAt: 1_790_000_000_000,
      regions: [
        {
          id: 'measured',
          summary: 'Measured.',
          tree: {
            kind: 'text',
            emphasis: 'standard',
            tone: 'neutral',
            role: 'body',
            text: 'Measured story',
          },
        },
      ],
    };
    const originalResizeObserver = globalThis.ResizeObserver;
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <QueryClientProvider client={queryClient}>
            <BriefCanvas value={document} />
          </QueryClientProvider>,
          {
            createNodeMock: () => ({
              getBoundingClientRect: () => ({ height: 80 }),
            }),
          },
        );
      });
      const grid = renderer.root.find((node) => node.props['data-brief-editorial-grid'] === true);
      const item = renderer.root.find((node) => node.props['data-brief-grid-span'] === 10);
      expect(grid.props['data-packed']).toBe('true');
      expect(grid.props.className).toContain('auto-rows-[var(--brief-grid-row)]');
      expect(grid.props.className).not.toContain('grid-flow-dense');
      expect(item.props.style).toEqual({ gridRowEnd: 'span 10' });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      renderer?.unmount();
    }
  });

  test('flattened stacks preserve their density and parent presentation', () => {
    const document: BriefDocumentV2 = {
      version: 2,
      title: 'Stack presentation',
      summary: 'Three densities.',
      generatedAt: 1_790_000_000_000,
      regions: [
        {
          id: 'airy',
          summary: 'Airy',
          tree: {
            kind: 'stack',
            emphasis: 'primary',
            tone: 'warning',
            density: 'airy',
            children: [
              { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: 'Airy child' },
            ],
          },
        },
        {
          id: 'standard',
          summary: 'Standard',
          tree: {
            kind: 'stack',
            emphasis: 'standard',
            tone: 'neutral',
            density: 'standard',
            children: [
              {
                kind: 'text',
                emphasis: 'standard',
                tone: 'neutral',
                role: 'body',
                text: 'Standard child',
              },
            ],
          },
        },
        {
          id: 'dense',
          summary: 'Dense',
          tree: {
            kind: 'stack',
            emphasis: 'muted',
            tone: 'urgent',
            density: 'dense',
            children: [
              { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: 'Dense child' },
            ],
          },
        },
      ],
    };

    const html = render(document);
    expect(html).toContain('brief-emphasis-primary border-amber-500/30');
    expect(html).toContain('pb-6');
    expect(html).toContain('pb-4');
    expect(html).toContain('pb-2.5');
    expect(html).toContain('opacity-75 border-destructive/35');
  });

  test('the three voices and the depth ladder reach the rendered document', () => {
    const html = render(richBriefDocumentFixture);
    // Editorial voice on kickers, highlight voice on lanes/badges/deltas.
    expect(html).toContain('--color-accent-2');
    expect(html).toContain('--color-accent-3');
    // Every top-level story climbs to the shared float rung; nested cards keep
    // the ordinary card rung.
    expect(html).toContain('--color-surface-float');
    expect(html).toContain('--color-bg-elevated');
    expect(html.match(/data-brief-story-card/g)?.length).toBeGreaterThan(2);
  });

  test('renders grounded table and progress leaves through Tool UI', () => {
    const document: BriefDocumentV2 = {
      version: 2,
      title: 'Release brief',
      summary: 'One release episode.',
      generatedAt: 1_790_000_000_000,
      regions: [
        {
          id: 'release',
          summary: 'Builds and release progress.',
          tree: {
            kind: 'stack',
            emphasis: 'standard',
            tone: 'neutral',
            density: 'standard',
            children: [
              {
                kind: 'data_table',
                emphasis: 'primary',
                tone: 'neutral',
                footprint: 'wide',
                title: 'Xcode Cloud builds',
                columns: [
                  { key: 'build', label: 'Build', format: 'number' },
                  { key: 'state', label: 'State', format: 'status' },
                ],
                rows: [
                  { build: 84, state: 'ready' },
                  { build: 85, state: 'processing' },
                  { build: 86, state: 'unapproved' },
                  { build: 87, state: 'incomplete' },
                  { build: 88, state: 'not completed' },
                  { build: 89, state: 'not done' },
                  { build: 90, state: 'not shipped' },
                  { build: 91, state: 'not passed' },
                ],
                sourceRefs: [{ kind: 'mcp', id: 'xcode-builds' }],
              },
              {
                kind: 'progress',
                emphasis: 'standard',
                tone: 'positive',
                title: 'Release path',
                steps: [
                  { id: 'archive', label: 'Archive', status: 'completed' },
                  { id: 'testflight', label: 'TestFlight', status: 'in-progress' },
                ],
                sourceRefs: [{ kind: 'mcp', id: 'xcode-release' }],
              },
              {
                kind: 'stat',
                emphasis: 'standard',
                tone: 'neutral',
                label: 'Builds',
                queryValue: { name: 'tasks_due_today' },
                unit: 'tasks',
              },
            ],
          },
        },
      ],
    };

    const html = render(document);
    expect(html).toContain('data-slot="data-table"');
    expect(html).toContain('Xcode Cloud builds');
    expect(html).toContain('data-slot="progress-tracker"');
    expect(html).toContain('data-slot="progress-card" class="flex w-full flex-col gap-4"');
    expect(html).toContain('Release path');
    expect(html).toContain('data-slot="stats-display"');
    expect(html).toContain('— tasks');
    for (const status of [
      'unapproved',
      'incomplete',
      'not completed',
      'not done',
      'not shipped',
      'not passed',
    ]) {
      expect(html).toMatch(new RegExp(`bg-red-100[^>]*>${status}<`));
    }
  });

  test('renders the rich brief Tool UI vocabulary on web', () => {
    const evidence: BriefSourceRefV2[] = [{ kind: 'mcp', id: 'rich-tools' }];
    const open: BriefActionV2 = {
      action: 'open_view',
      label: 'Open inbox',
      payload: { view: 'inbox' },
      style: 'secondary',
    };
    const document: BriefDocumentV2 = {
      version: 2,
      title: 'Tool brief',
      summary: 'Rich grounded tools.',
      generatedAt: 1_790_000_000_000,
      regions: [
        {
          id: 'tools',
          summary: 'Weather, runway, evidence, and technical state.',
          tree: {
            kind: 'stack',
            emphasis: 'standard',
            tone: 'neutral',
            density: 'standard',
            children: [
              {
                kind: 'weather',
                emphasis: 'primary',
                tone: 'neutral',
                title: 'Lake weather',
                location: 'Lake George, New York',
                latitude: 43.4262,
                longitude: -73.7123,
                timezone: 'America/New_York',
                unit: 'fahrenheit',
                current: {
                  conditionCode: 'clear',
                  temperature: 78,
                  tempMin: 61,
                  tempMax: 81,
                },
                hourly: [],
                daily: [{ label: 'Today', conditionCode: 'clear', tempMin: 61, tempMax: 81 }],
                source: 'Apple Weather',
                attributionURL: 'https://weatherkit.apple.com/legal-attribution.html',
                sourceRefs: evidence,
              },
              {
                kind: 'plan',
                emphasis: 'primary',
                tone: 'neutral',
                title: 'Today’s runway',
                items: [{ id: 'focus', label: 'One hour of Card Hunt', status: 'in_progress' }],
                actions: [],
                sourceRefs: evidence,
              },
              {
                kind: 'email_preview',
                emphasis: 'standard',
                tone: 'neutral',
                channel: 'email',
                title: 'Confirm the date',
                sender: 'Maya',
                recipients: ['Jakob'],
                snippet: 'Can we confirm the launch date?',
                attachmentCount: 1,
                messageCount: 2,
                ref: { kind: 'thread', id: 'thread-rich', account: 'mail@example.com' },
                actions: [open],
                sourceRefs: evidence,
              },
              {
                kind: 'decision',
                emphasis: 'standard',
                tone: 'warning',
                title: 'Choose a release path',
                options: [
                  { id: 'stage', label: 'Stage first', action: open },
                  { id: 'hold', label: 'Hold', action: { ...open, label: 'Hold' } },
                ],
                sourceRefs: evidence,
              },
              {
                kind: 'citations',
                emphasis: 'muted',
                tone: 'neutral',
                title: 'Sources',
                citations: [
                  {
                    id: 'release',
                    href: 'https://example.com/release',
                    title: 'Release notes',
                    type: 'document',
                  },
                ],
                sourceRefs: evidence,
              },
              {
                kind: 'geo_map',
                emphasis: 'standard',
                tone: 'neutral',
                title: 'Lake plan',
                markers: [{ id: 'lake', lat: 43.4262, lng: -73.7123, label: 'Lake George' }],
                routes: [],
                sourceRefs: evidence,
              },
              {
                kind: 'code_diff',
                emphasis: 'standard',
                tone: 'neutral',
                title: 'Notification change',
                filename: 'Push.swift',
                language: 'swift',
                oldCode: 'let enabled = false',
                newCode: 'let enabled = true',
                sourceRefs: evidence,
              },
              {
                kind: 'terminal',
                emphasis: 'standard',
                tone: 'positive',
                title: 'Build verification',
                command: 'xcodebuild test',
                stdout: 'TEST SUCCEEDED',
                stderr: '',
                exitCode: 0,
                truncated: false,
                sourceRefs: evidence,
              },
              {
                kind: 'chart',
                emphasis: 'standard',
                tone: 'neutral',
                title: 'Build duration',
                variant: 'area',
                data: [
                  { label: '84', value: 9, group: 'iOS' },
                  { label: '85', value: 7, group: 'iOS' },
                ],
                sourceRefs: evidence,
              },
            ],
          },
        },
      ],
    };

    const html = render(document);
    for (const slot of [
      'weather-widget',
      'plan',
      'brief-email-preview',
      'option-list',
      'citation-list',
      'brief-geo-map',
      'code-diff',
      'terminal',
      'chart',
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain('Weather data by Apple Weather');
    expect(html).toContain('One hour of Card Hunt');
    expect(html).toContain('Can we confirm the launch date?');
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
    expect(html).not.toContain('Open merged');
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
