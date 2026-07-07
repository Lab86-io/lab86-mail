import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import './tools/harness';
import { SerializableAudioSchema } from '../components/tool-ui/audio/schema';
import { SerializableChartSchema } from '../components/tool-ui/chart/schema';
import { SerializableCitationSchema } from '../components/tool-ui/citation/schema';
import { SerializableCodeBlockSchema } from '../components/tool-ui/code-block/schema';
import { SerializableCodeDiffSchema } from '../components/tool-ui/code-diff/schema';
import { SerializableDataTableSchema } from '../components/tool-ui/data-table/schema';
import { SerializableGeoMapSchema } from '../components/tool-ui/geo-map/schema';
import { SerializableImageSchema } from '../components/tool-ui/image/schema';
import { SerializableImageGallerySchema } from '../components/tool-ui/image-gallery/schema';
import { SerializableInstagramPostSchema } from '../components/tool-ui/instagram-post/schema';
import { SerializableItemCarouselSchema } from '../components/tool-ui/item-carousel/schema';
import { SerializableLinkPreviewSchema } from '../components/tool-ui/link-preview/schema';
import { SerializableLinkedInPostSchema } from '../components/tool-ui/linkedin-post/schema';
import { SerializableMessageDraftSchema } from '../components/tool-ui/message-draft/schema';
import { SerializableOrderSummarySchema } from '../components/tool-ui/order-summary/schema';
import { SerializablePlanSchema } from '../components/tool-ui/plan/schema';
import { SerializableProgressTrackerSchema } from '../components/tool-ui/progress-tracker/schema';
import { SerializableStatsDisplaySchema } from '../components/tool-ui/stats-display/schema';
import { SerializableTerminalSchema } from '../components/tool-ui/terminal/schema';
import { SerializableVideoSchema } from '../components/tool-ui/video/schema';
import { SerializableXPostSchema } from '../components/tool-ui/x-post/schema';
import {
  buildAudioPayload,
  buildCarouselPayload,
  buildChartPayload,
  buildCitationsPayload,
  buildCodeDiffPayload,
  buildCodePayload,
  buildImageGalleryPayload,
  buildImagePayload,
  buildLinkPreviewPayload,
  buildMapPayload,
  buildMessageDraftPayload,
  buildOrderSummaryPayload,
  buildPlanPayload,
  buildProgressPayload,
  buildSocialPostPayload,
  buildStatsPayload,
  buildTablePayload,
  buildTerminalPayload,
  buildVideoPayload,
  DISPLAY_LIMITS,
  DISPLAY_TOOL_NAMES,
  setWeatherFetchForTests,
  showWeather,
} from '../lib/tools/display';
import { getTool } from '../lib/tools/index';
import { invokeTool } from '../lib/tools/registry';
import { toolContext } from './tools/harness';

function expectParses(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  value: unknown,
) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Payload failed component schema: ${String(result.error)}`);
  expect(result.success).toBe(true);
}

// ---------------------------------------------------------------------------
// Every builder produces a payload the ACTUAL tool-ui component parser accepts.
// ---------------------------------------------------------------------------

describe('display payload builders satisfy the tool-ui component contracts', () => {
  test('chart', () => {
    const payload = buildChartPayload(
      {
        type: 'bar',
        title: 'Mail by day',
        xKey: 'day',
        series: [{ key: 'count', label: 'Messages' }],
        data: [
          { day: 'Mon', count: 12 },
          { day: 'Tue', count: '18' }, // coercible string survives
          { day: 'Wed', count: 'nope' }, // uncoercible row dropped
          { count: 4 }, // missing xKey dropped
          { day: 'Thu', count: null }, // null y-value allowed
        ],
      },
      'chart-test',
    );
    expect(payload.data).toHaveLength(3);
    expect(payload.data[1].count).toBe(18);
    expect(payload.showLegend).toBe(false);
    // Re-themed onto the app accent system — the app defines no --chart-N vars.
    expect(payload.colors?.[0]).toBe('var(--color-accent)');
    expect(payload.colors?.[1]).toContain('--color-accent-2');
    expectParses(SerializableChartSchema, payload);
  });

  test('chart with no usable rows throws', () => {
    expect(() =>
      buildChartPayload(
        { type: 'line', xKey: 'x', series: [{ key: 'y', label: 'Y' }], data: [{ x: 'a', y: 'nope' }] },
        'chart-bad',
      ),
    ).toThrow('No chartable rows');
  });

  test('table clamps rows and coerces cell types', () => {
    const rows = Array.from({ length: DISPLAY_LIMITS.tableRows + 40 }, (_, i) => ({
      name: `Row ${i}`,
      amount: i,
      extra: { nested: true }, // objects stringified
    }));
    const payload = buildTablePayload(
      {
        title: 'Spend',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'amount', label: 'Amount', format: 'currency' },
          { key: 'extra', label: 'Extra' },
        ],
        rows,
      },
      'data-table-test',
    );
    expect(payload.data).toHaveLength(DISPLAY_LIMITS.tableRows);
    expect(payload.data[0].extra).toBe('[object Object]');
    expect(payload.columns[1].format).toEqual({ kind: 'currency', currency: 'USD' });
    expectParses(SerializableDataTableSchema, payload);
  });

  test('stats with deltas, sparklines, and text values', () => {
    const payload = buildStatsPayload(
      {
        title: 'This week',
        stats: [
          { label: 'Replies owed', value: 4, delta: -2, sparkline: [5, 6, 4, 4] },
          { label: 'Budget', value: 120.5, format: 'currency' },
          { label: 'Status', value: 'On track' },
        ],
      },
      'stats-test',
    );
    expect(payload.stats[0].diff).toEqual({ value: -2 });
    expect(payload.stats[0].key).toBe('stat-1');
    expect(payload.stats[2].format).toEqual({ kind: 'text' });
    expectParses(SerializableStatsDisplaySchema, payload);
  });

  test('code block clamps oversized code', () => {
    const payload = buildCodePayload(
      { code: 'x'.repeat(DISPLAY_LIMITS.codeChars + 10), language: 'ts', filename: 'a.ts' },
      'code-test',
    );
    expect(payload.code.endsWith('… (truncated)')).toBe(true);
    expectParses(SerializableCodeBlockSchema, payload);
  });

  test('code diff', () => {
    const payload = buildCodeDiffPayload(
      { filename: 'a.ts', oldCode: 'const a = 1;', newCode: 'const a = 2;', language: 'typescript' },
      'code-diff-test',
    );
    expectParses(SerializableCodeDiffSchema, payload);
  });

  test('terminal defaults exit code and clamps output', () => {
    const payload = buildTerminalPayload({ command: 'ls -la' }, 'terminal-test');
    expect(payload.exitCode).toBe(0);
    expectParses(SerializableTerminalSchema, payload);
  });

  test('plan assigns unique step ids and default status', () => {
    const payload = buildPlanPayload(
      { title: 'Ship it', steps: [{ label: 'One' }, { label: 'Two', status: 'completed' }] },
      'plan-test',
    );
    expect(payload.todos.map((t) => t.id)).toEqual(['step-1', 'step-2']);
    expect(payload.todos[0].status).toBe('pending');
    expectParses(SerializablePlanSchema, payload);
  });

  test('progress tracker', () => {
    const payload = buildProgressPayload(
      {
        steps: [
          { label: 'Fetch', status: 'completed' },
          { label: 'Sort', status: 'failed' },
        ],
      },
      'progress-test',
    );
    expectParses(SerializableProgressTrackerSchema, payload);
  });

  test('citations derive domains and parse individually', () => {
    const citations = buildCitationsPayload(
      {
        citations: [
          { url: 'https://www.example.com/post', title: 'A post', snippet: 'Something', type: 'article' },
          { url: 'https://docs.example.org/api', title: 'API docs' },
        ],
      },
      'citation-test',
    );
    expect(citations[0].domain).toBe('example.com');
    for (const citation of citations) expectParses(SerializableCitationSchema, citation);
  });

  test('link preview / image / gallery / video / audio', () => {
    expectParses(
      SerializableLinkPreviewSchema,
      buildLinkPreviewPayload({ url: 'https://example.com/x', title: 'X' }, 'link-test'),
    );
    expectParses(
      SerializableImageSchema,
      buildImagePayload({ url: 'https://example.com/a.png', alt: 'A chart' }, 'image-test'),
    );
    expectParses(
      SerializableImageGallerySchema,
      buildImageGalleryPayload(
        {
          images: [
            { url: 'https://example.com/a.png', alt: 'A' },
            { url: 'https://example.com/b.png', alt: 'B' },
          ],
        },
        'gallery-test',
      ),
    );
    expectParses(
      SerializableVideoSchema,
      buildVideoPayload({ url: 'https://example.com/v.mp4', title: 'Clip' }, 'video-test'),
    );
    expectParses(
      SerializableAudioSchema,
      buildAudioPayload({ url: 'https://example.com/a.mp3', title: 'Note' }, 'audio-test'),
    );
  });

  test('map filters invalid coordinates', () => {
    const payload = buildMapPayload(
      {
        title: 'Stops',
        markers: [
          { latitude: 43.15, longitude: -77.62, label: 'Rochester' },
          { latitude: 999, longitude: 0 }, // dropped by builder guard
        ],
      },
      'map-test',
    );
    expect(payload.markers).toHaveLength(1);
    expectParses(SerializableGeoMapSchema, payload);
  });

  test('map with only invalid markers throws', () => {
    expect(() => buildMapPayload({ markers: [{ latitude: 91, longitude: 0 }] }, 'map-bad')).toThrow();
  });

  test('carousel', () => {
    const payload = buildCarouselPayload(
      { title: 'Options', items: [{ name: 'One' }, { name: 'Two', subtitle: 'Nice' }] },
      'carousel-test',
    );
    expectParses(SerializableItemCarouselSchema, payload);
  });

  test('order summary computes totals', () => {
    const payload = buildOrderSummaryPayload(
      {
        items: [
          { name: 'Widget', quantity: 2, unitPrice: 10.5 },
          { name: 'Gadget', unitPrice: 5 },
        ],
        tax: 2.1,
        currency: 'USD',
      },
      'order-test',
    );
    expect(payload.pricing.subtotal).toBe(26);
    expect(payload.pricing.total).toBe(28.1);
    expectParses(SerializableOrderSummarySchema, payload);
  });

  test('social posts parse per network', () => {
    const x = buildSocialPostPayload(
      { network: 'x', authorName: 'Jane Dev', text: 'Shipping day', likes: 12 },
      'post-x',
    );
    expect(x.network).toBe('x');
    expectParses(SerializableXPostSchema, x.post);

    const li = buildSocialPostPayload(
      { network: 'linkedin', authorName: 'Jane Dev', authorHeadline: 'Engineer', text: 'Hello' },
      'post-li',
    );
    expectParses(SerializableLinkedInPostSchema, li.post);

    const ig = buildSocialPostPayload(
      {
        network: 'instagram',
        authorName: 'Jane Dev',
        imageUrl: 'https://example.com/pic.jpg',
        text: 'Caption',
      },
      'post-ig',
    );
    expectParses(SerializableInstagramPostSchema, ig.post);
  });

  test('message draft', () => {
    const payload = buildMessageDraftPayload(
      { to: ['sam@example.com'], subject: 'Re: plans', body: 'Sounds good.' },
      'draft-test',
    );
    expectParses(SerializableMessageDraftSchema, payload);
    expect(() => buildMessageDraftPayload({ to: [], subject: 'x', body: 'y' }, 'draft-bad')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tool wiring
// ---------------------------------------------------------------------------

describe('display tool registration', () => {
  test('every display tool is registered and named show_*', () => {
    expect(DISPLAY_TOOL_NAMES.length).toBe(20);
    for (const name of DISPLAY_TOOL_NAMES) {
      expect(name.startsWith('show_')).toBe(true);
      expect(getTool(name)?.name).toBe(name);
      expect(getTool(name)?.mutating).toBe(false);
    }
  });

  test('the agent loop exposes every display tool', async () => {
    const { AGENT_TOOL_NAMES } = await import('../lib/ai/loop');
    for (const name of DISPLAY_TOOL_NAMES) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test('the chat renderer covers every display tool', () => {
    const rendererSource = readFileSync(
      path.join(import.meta.dir, '../components/ai-elements/tool-ui-part.tsx'),
      'utf8',
    );
    for (const name of DISPLAY_TOOL_NAMES) {
      expect(rendererSource).toContain(`'${name}'`);
    }
  });

  test('the system prompt briefs the display and ask tools', async () => {
    const { SYSTEM_PROMPT } = await import('../lib/ai/system-prompt');
    for (const name of [
      'show_weather',
      'show_chart',
      'show_stats',
      'show_table',
      'show_code',
      'show_citations',
      'show_message_draft',
      'ask_approval',
      'ask_parameters',
      'ask_preferences',
      'ask_question_flow',
    ]) {
      expect(SYSTEM_PROMPT).toContain(name);
    }
  });

  test('display tool handlers wrap builders into { ok, component, payload }', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['show_stats', { stats: [{ label: 'Threads', value: 42 }] }, 'stats-display'],
      ['show_table', { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] }, 'data-table'],
      ['show_code', { code: 'SELECT 1;', language: 'sql' }, 'code-block'],
      ['show_code_diff', { filename: 'a.ts', oldCode: 'a', newCode: 'b' }, 'code-diff'],
      ['show_terminal', { command: 'echo hi', stdout: 'hi' }, 'terminal'],
      ['show_plan', { title: 'Plan', steps: [{ label: 'One' }] }, 'plan'],
      ['show_progress', { steps: [{ label: 'One', status: 'completed' }] }, 'progress-tracker'],
      ['show_citations', { citations: [{ url: 'https://example.com/a', title: 'A' }] }, 'citation'],
      ['show_link_preview', { url: 'https://example.com' }, 'link-preview'],
      ['show_image', { url: 'https://example.com/a.png', alt: 'A' }, 'image'],
      ['show_image_gallery', { images: [{ url: 'https://example.com/a.png', alt: 'A' }] }, 'image-gallery'],
      ['show_video', { url: 'https://example.com/v.mp4' }, 'video'],
      ['show_audio', { url: 'https://example.com/a.mp3' }, 'audio'],
      ['show_map', { markers: [{ latitude: 1, longitude: 2 }] }, 'geo-map'],
      ['show_carousel', { items: [{ name: 'One' }] }, 'item-carousel'],
      ['show_order_summary', { items: [{ name: 'Widget', unitPrice: 3 }] }, 'order-summary'],
      ['show_social_post', { network: 'x', authorName: 'Jane' }, 'social-post'],
      ['show_message_draft', { to: ['sam@example.com'], subject: 'Hi', body: 'Hello' }, 'message-draft'],
      [
        'show_chart',
        { type: 'bar', xKey: 'x', series: [{ key: 'y', label: 'Y' }], data: [{ x: 'a', y: 1 }] },
        'chart',
      ],
    ];
    for (const [name, args, component] of cases) {
      const result: any = await invokeTool(getTool(name)!, args, toolContext());
      expect(result.ok).toBe(true);
      expect(result.component).toBe(component);
      expect(result.payload).toBeTruthy();
    }
  });

  test('display tools return ok:false (not a throw) on unbuildable payloads', async () => {
    const result: any = await invokeTool(
      getTool('show_chart')!,
      { type: 'bar', xKey: 'x', series: [{ key: 'y', label: 'Y' }], data: [{ x: 'a', y: 'text' }] },
      toolContext(),
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('No chartable rows');
  });
});

// ---------------------------------------------------------------------------
// show_weather (fetch injected — no network)
// ---------------------------------------------------------------------------

describe('show_weather', () => {
  test('fetches, shapes, and summarizes real forecast data', async () => {
    setWeatherFetchForTests(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('geocoding-api')
          ? {
              results: [
                {
                  name: 'Rochester',
                  latitude: 43.15,
                  longitude: -77.62,
                  timezone: 'America/New_York',
                  admin1: 'New York',
                },
              ],
            }
          : {
              timezone: 'America/New_York',
              current: {
                time: '2026-07-07T09:30',
                temperature_2m: 71.4,
                weather_code: 0,
                wind_speed_10m: 4,
                precipitation: 0,
                relative_humidity_2m: 50,
                is_day: 1,
              },
              hourly: { time: ['2026-07-07T10:00'], temperature_2m: [73], weather_code: [0] },
              daily: {
                time: ['2026-07-07'],
                weather_code: [0],
                temperature_2m_max: [78],
                temperature_2m_min: [61],
                precipitation_probability_max: [5],
              },
            },
    }));
    try {
      const result: any = await invokeTool(showWeather, { place: 'Rochester NY' }, toolContext());
      expect(result.ok).toBe(true);
      expect(result.component).toBe('weather-widget');
      expect(result.payload.version).toBe('3.1');
      expect(result.payload.location.name).toBe('Rochester, New York');
      expect(result.payload.current.conditionCode).toBe('clear');
      expect(result.summary).toContain('Rochester, New York: 71°F, Clear');
    } finally {
      setWeatherFetchForTests(undefined);
    }
  });

  test('reports ok:false when no location resolves', async () => {
    setWeatherFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
    try {
      const result: any = await invokeTool(showWeather, { place: 'Nowhereville' }, toolContext());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Could not resolve a location');
    } finally {
      setWeatherFetchForTests(undefined);
    }
  });
});
