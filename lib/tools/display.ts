// Display tools — the agent's rich in-chat rendering surface.
//
// Each tool accepts a forgiving, model-facing payload, validates and CLAMPS it
// server-side (pure builders below, unit-tested against the actual tool-ui
// component parsers), and returns { ok, component, payload }. The chat client
// (components/ai-elements/tool-ui-part.tsx) renders the payload with the
// matching tool-ui component; running/failed states keep the shared quiet
// ToolActivityRow treatment.
//
// show_weather is the only display tool that fetches data itself (Open-Meteo,
// free, no key — lib/weather/open-meteo.ts). Everything else renders what the
// model already has, so well-shaped series from corpus_count, task boards,
// project summaries, or web research can go straight to a designed component.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAiRequestContext } from '../ai/context';
import {
  briefWeather,
  type FetchLike,
  toWeatherWidgetPayload,
  weatherSummaryLine,
} from '../weather/open-meteo';
import { defineTool } from './registry';

// ---------------------------------------------------------------------------
// Bounds — every list the model can send is clamped, never rejected for size.
// ---------------------------------------------------------------------------

export const DISPLAY_LIMITS = {
  chartRows: 300,
  chartSeries: 6,
  tableRows: 100,
  tableColumns: 12,
  stats: 8,
  codeChars: 40_000,
  terminalChars: 20_000,
  galleryImages: 24,
  carouselItems: 20,
  citations: 10,
  mapMarkers: 100,
  planTodos: 30,
  progressSteps: 20,
  orderItems: 30,
} as const;

function displayId(component: string): string {
  return `${component}-${randomUUID().slice(0, 8)}`;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… (truncated)` : value;
}

// ---------------------------------------------------------------------------
// Pure payload builders (exported for tests — each output must satisfy the
// matching tool-ui Serializable* parser)
// ---------------------------------------------------------------------------

export interface ChartInput {
  type: 'bar' | 'line';
  title?: string;
  description?: string;
  xKey: string;
  series: Array<{ key: string; label: string; color?: string }>;
  data: Array<Record<string, unknown>>;
  showLegend?: boolean;
}

// The app defines no --chart-N tokens (the tool-ui default), so charts are
// re-themed onto the live accent system: accent + the editorial second accent,
// then relative-OKLCH variants. Light/dark both resolve through the app vars.
export const CHART_SERIES_COLORS = [
  'var(--color-accent)',
  'var(--color-accent-2, var(--color-accent))',
  'oklch(from var(--color-accent) calc(l + 0.18) calc(c * 0.7) h)',
  'oklch(from var(--color-accent-2, var(--color-accent)) calc(l + 0.18) calc(c * 0.7) h)',
  'oklch(from var(--color-accent) calc(l - 0.12) c h)',
  'oklch(from var(--color-accent-2, var(--color-accent)) calc(l - 0.12) c h)',
];

export function buildChartPayload(input: ChartInput, id = displayId('chart')) {
  const series = input.series.slice(0, DISPLAY_LIMITS.chartSeries);
  const seriesKeys = series.map((s) => s.key);
  // Keep only rows that carry the x value and coercible numbers for every
  // series — the component's schema hard-fails otherwise.
  const data = input.data
    .slice(0, DISPLAY_LIMITS.chartRows)
    .map((row) => {
      const x = row[input.xKey];
      if (typeof x !== 'string' && typeof x !== 'number') return null;
      const out: Record<string, unknown> = { [input.xKey]: x };
      for (const key of seriesKeys) {
        const value = row[key];
        if (value === null || value === undefined) {
          out[key] = null;
          continue;
        }
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        out[key] = num;
      }
      return out;
    })
    .filter((row): row is Record<string, unknown> => row !== null);
  if (!data.length)
    throw new Error('No chartable rows: every row must carry the xKey and numeric series values.');
  if (!series.length) throw new Error('At least one series is required.');
  return {
    id,
    type: input.type,
    title: input.title,
    description: input.description,
    data,
    xKey: input.xKey,
    series,
    colors: CHART_SERIES_COLORS,
    showLegend: input.showLegend ?? series.length > 1,
    showGrid: true,
  };
}

export interface TableInput {
  title?: string;
  columns: Array<{
    key: string;
    label: string;
    align?: 'left' | 'right' | 'center';
    format?: 'text' | 'number' | 'currency' | 'percent' | 'date';
    currency?: string;
  }>;
  rows: Array<Record<string, unknown>>;
}

export function buildTablePayload(input: TableInput, id = displayId('data-table')) {
  const columns = input.columns.slice(0, DISPLAY_LIMITS.tableColumns).map((col) => ({
    key: col.key,
    label: col.label,
    align: col.align,
    sortable: true,
    format:
      col.format === 'currency'
        ? ({ kind: 'currency', currency: col.currency || 'USD' } as const)
        : col.format === 'number'
          ? ({ kind: 'number' } as const)
          : col.format === 'percent'
            ? ({ kind: 'percent' } as const)
            : col.format === 'date'
              ? ({ kind: 'date' } as const)
              : undefined,
  }));
  const keys = columns.map((col) => col.key);
  const data = input.rows.slice(0, DISPLAY_LIMITS.tableRows).map((row) => {
    const out: Record<string, string | number | boolean | null> = {};
    for (const key of keys) {
      const value = row[key];
      out[key] =
        value === null || value === undefined
          ? null
          : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? value
            : String(value);
    }
    return out;
  });
  if (!columns.length) throw new Error('At least one column is required.');
  if (!data.length) throw new Error('At least one row is required.');
  return { id, columns, data, title: input.title } as {
    id: string;
    columns: typeof columns;
    data: typeof data;
    title?: string;
  };
}

export interface StatsInput {
  title?: string;
  stats: Array<{
    label: string;
    value: number | string;
    unit?: string;
    format?: 'number' | 'currency' | 'percent';
    currency?: string;
    delta?: number;
    sparkline?: number[];
  }>;
}

export function buildStatsPayload(input: StatsInput, id = displayId('stats')) {
  const stats = input.stats.slice(0, DISPLAY_LIMITS.stats).map((stat, index) => {
    const numeric = typeof stat.value === 'number' ? stat.value : Number(stat.value);
    const isNumber = Number.isFinite(numeric);
    return {
      key: `stat-${index + 1}`,
      label: stat.label,
      value: isNumber ? numeric : String(stat.value),
      format:
        isNumber && stat.format === 'currency'
          ? ({ kind: 'currency' as const, currency: stat.currency || 'USD' } as const)
          : isNumber && stat.format === 'percent'
            ? ({ kind: 'percent' as const } as const)
            : isNumber
              ? ({ kind: 'number' as const } as const)
              : ({ kind: 'text' as const } as const),
      diff: stat.delta !== undefined && Number.isFinite(stat.delta) ? { value: stat.delta } : undefined,
      sparkline:
        stat.sparkline && stat.sparkline.length >= 2 ? { data: stat.sparkline.slice(0, 50) } : undefined,
    };
  });
  if (!stats.length) throw new Error('At least one stat is required.');
  return { id, title: input.title, stats };
}

export interface CodeInput {
  code: string;
  language?: string;
  filename?: string;
  highlightLines?: number[];
}

export function buildCodePayload(input: CodeInput, id = displayId('code')) {
  return {
    id,
    code: clip(input.code, DISPLAY_LIMITS.codeChars),
    language: (input.language || 'text').trim() || 'text',
    lineNumbers: 'visible' as const,
    filename: input.filename,
    highlightLines: input.highlightLines?.filter((n) => Number.isInteger(n) && n > 0),
  };
}

export interface CodeDiffInput {
  filename: string;
  oldCode: string;
  newCode: string;
  language?: string;
}

export function buildCodeDiffPayload(input: CodeDiffInput, id = displayId('code-diff')) {
  return {
    id,
    filename: input.filename,
    oldCode: clip(input.oldCode, DISPLAY_LIMITS.codeChars),
    newCode: clip(input.newCode, DISPLAY_LIMITS.codeChars),
    language: input.language,
  };
}

export interface TerminalInput {
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cwd?: string;
  durationMs?: number;
}

export function buildTerminalPayload(input: TerminalInput, id = displayId('terminal')) {
  return {
    id,
    command: input.command,
    stdout: input.stdout !== undefined ? clip(input.stdout, DISPLAY_LIMITS.terminalChars) : undefined,
    stderr: input.stderr !== undefined ? clip(input.stderr, DISPLAY_LIMITS.terminalChars) : undefined,
    exitCode:
      Number.isInteger(input.exitCode) && (input.exitCode as number) >= 0 ? (input.exitCode as number) : 0,
    cwd: input.cwd,
    durationMs: input.durationMs,
  };
}

export interface PlanDisplayInput {
  title: string;
  description?: string;
  steps: Array<{
    label: string;
    description?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }>;
}

export function buildPlanPayload(input: PlanDisplayInput, id = displayId('plan')) {
  const todos = input.steps.slice(0, DISPLAY_LIMITS.planTodos).map((step, index) => ({
    id: `step-${index + 1}`,
    label: step.label,
    status: step.status ?? ('pending' as const),
    description: step.description,
  }));
  if (!todos.length) throw new Error('At least one step is required.');
  return { id, title: input.title, description: input.description, todos };
}

export interface ProgressInput {
  title?: string;
  steps: Array<{
    label: string;
    description?: string;
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
  }>;
}

export function buildProgressPayload(input: ProgressInput, id = displayId('progress')) {
  const steps = input.steps.slice(0, DISPLAY_LIMITS.progressSteps).map((step, index) => ({
    id: `step-${index + 1}`,
    label: step.label,
    description: step.description,
    status: step.status,
  }));
  if (!steps.length) throw new Error('At least one step is required.');
  return { id, steps };
}

const HTTP_URL = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'http(s) URLs only');

export interface CitationsInput {
  citations: Array<{
    url: string;
    title: string;
    snippet?: string;
    author?: string;
    type?: 'webpage' | 'document' | 'article' | 'api' | 'code' | 'other';
  }>;
}

export function buildCitationsPayload(input: CitationsInput, idPrefix = displayId('citation')) {
  const citations = input.citations.slice(0, DISPLAY_LIMITS.citations).map((cite, index) => ({
    id: `${idPrefix}-${index + 1}`,
    href: cite.url,
    title: cite.title,
    snippet: cite.snippet,
    domain: domainOf(cite.url),
    author: cite.author,
    type: cite.type,
  }));
  if (!citations.length) throw new Error('At least one citation is required.');
  return citations;
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export interface LinkPreviewInput {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
}

export function buildLinkPreviewPayload(input: LinkPreviewInput, id = displayId('link')) {
  return {
    id,
    href: input.url,
    title: input.title,
    description: input.description,
    image: input.imageUrl,
    domain: domainOf(input.url),
  };
}

export interface ImageInput {
  url: string;
  alt: string;
  title?: string;
  description?: string;
  linkUrl?: string;
}

export function buildImagePayload(input: ImageInput, id = displayId('image')) {
  return {
    id,
    assetId: id,
    src: input.url,
    alt: input.alt,
    title: input.title,
    description: input.description,
    href: input.linkUrl,
    domain: input.linkUrl ? domainOf(input.linkUrl) : undefined,
  };
}

export interface ImageGalleryInput {
  title?: string;
  description?: string;
  images: Array<{ url: string; alt: string; title?: string; width?: number; height?: number }>;
}

export function buildImageGalleryPayload(input: ImageGalleryInput, id = displayId('gallery')) {
  const images = input.images.slice(0, DISPLAY_LIMITS.galleryImages).map((image, index) => ({
    id: `${id}-${index + 1}`,
    src: image.url,
    alt: image.alt,
    title: image.title,
    // The gallery lays out by aspect ratio; when the model has no real
    // dimensions a 4:3 placeholder keeps the grid stable.
    width: image.width && image.width > 0 ? image.width : 1200,
    height: image.height && image.height > 0 ? image.height : 900,
  }));
  if (!images.length) throw new Error('At least one image is required.');
  return { id, title: input.title, description: input.description, images };
}

export interface VideoInput {
  url: string;
  title?: string;
  description?: string;
  posterUrl?: string;
}

export function buildVideoPayload(input: VideoInput, id = displayId('video')) {
  return {
    id,
    assetId: id,
    src: input.url,
    poster: input.posterUrl,
    title: input.title,
    description: input.description,
  };
}

export interface AudioInput {
  url: string;
  title?: string;
  description?: string;
  artworkUrl?: string;
}

export function buildAudioPayload(input: AudioInput, id = displayId('audio')) {
  return {
    id,
    assetId: id,
    src: input.url,
    title: input.title,
    description: input.description,
    artwork: input.artworkUrl,
  };
}

export interface MapInput {
  title?: string;
  markers: Array<{
    latitude: number;
    longitude: number;
    label?: string;
    description?: string;
  }>;
}

export function buildMapPayload(input: MapInput, id = displayId('map')) {
  const markers = input.markers
    .slice(0, DISPLAY_LIMITS.mapMarkers)
    .filter(
      (marker) =>
        Number.isFinite(marker.latitude) &&
        Math.abs(marker.latitude) <= 90 &&
        Number.isFinite(marker.longitude) &&
        Math.abs(marker.longitude) <= 180,
    )
    .map((marker, index) => ({
      id: `${id}-marker-${index + 1}`,
      lat: marker.latitude,
      lng: marker.longitude,
      label: marker.label,
      description: marker.description,
      tooltip: marker.label ? ('hover' as const) : undefined,
    }));
  if (!markers.length) throw new Error('At least one valid marker (lat -90..90, lng -180..180) is required.');
  return { id, title: input.title, markers };
}

export interface CarouselInput {
  title?: string;
  description?: string;
  items: Array<{ name: string; subtitle?: string; imageUrl?: string }>;
}

export function buildCarouselPayload(input: CarouselInput, id = displayId('carousel')) {
  const items = input.items.slice(0, DISPLAY_LIMITS.carouselItems).map((item, index) => ({
    id: `${id}-item-${index + 1}`,
    name: item.name,
    subtitle: item.subtitle,
    image: item.imageUrl,
  }));
  if (!items.length) throw new Error('At least one item is required.');
  return { id, title: input.title, description: input.description, items };
}

export interface OrderSummaryInput {
  title?: string;
  items: Array<{
    name: string;
    description?: string;
    quantity?: number;
    unitPrice: number;
    imageUrl?: string;
  }>;
  currency?: string;
  tax?: number;
  shipping?: number;
  discount?: number;
}

export function buildOrderSummaryPayload(input: OrderSummaryInput, id = displayId('order')) {
  const items = input.items.slice(0, DISPLAY_LIMITS.orderItems).map((item, index) => ({
    id: `${id}-item-${index + 1}`,
    name: item.name,
    description: item.description,
    imageUrl: item.imageUrl,
    quantity:
      item.quantity && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : undefined,
    unitPrice: item.unitPrice,
  }));
  if (!items.length) throw new Error('At least one item is required.');
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * (item.quantity ?? 1), 0);
  const total = subtotal + (input.tax ?? 0) + (input.shipping ?? 0) - (input.discount ?? 0);
  return {
    id,
    title: input.title,
    variant: 'summary' as const,
    items,
    pricing: {
      subtotal: round2(subtotal),
      tax: input.tax,
      shipping: input.shipping,
      discount: input.discount,
      total: round2(total),
      currency: input.currency || 'USD',
    },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface SocialPostInput {
  network: 'x' | 'linkedin' | 'instagram';
  authorName: string;
  authorHandle?: string;
  authorAvatarUrl?: string;
  authorHeadline?: string;
  text?: string;
  imageUrl?: string;
  imageAlt?: string;
  likes?: number;
  createdAt?: string;
}

const FALLBACK_AVATAR = 'https://api.dicebear.com/9.x/initials/png?seed=';

export function buildSocialPostPayload(input: SocialPostInput, id = displayId('post')) {
  const avatar = input.authorAvatarUrl || `${FALLBACK_AVATAR}${encodeURIComponent(input.authorName)}`;
  const media =
    input.imageUrl !== undefined
      ? { type: 'image' as const, url: input.imageUrl, alt: input.imageAlt || 'Post image' }
      : undefined;
  if (input.network === 'x') {
    return {
      network: 'x' as const,
      post: {
        id,
        author: {
          name: input.authorName,
          handle: input.authorHandle || input.authorName.toLowerCase().replace(/\s+/g, ''),
          avatarUrl: avatar,
        },
        text: input.text,
        media,
        stats: input.likes !== undefined ? { likes: input.likes } : undefined,
        createdAt: input.createdAt,
      },
    };
  }
  if (input.network === 'linkedin') {
    return {
      network: 'linkedin' as const,
      post: {
        id,
        author: { name: input.authorName, avatarUrl: avatar, headline: input.authorHeadline },
        text: input.text,
        media,
        stats: input.likes !== undefined ? { likes: input.likes } : undefined,
        createdAt: input.createdAt,
      },
    };
  }
  return {
    network: 'instagram' as const,
    post: {
      id,
      author: {
        name: input.authorName,
        handle: input.authorHandle || input.authorName.toLowerCase().replace(/\s+/g, ''),
        avatarUrl: avatar,
      },
      text: input.text,
      media: media ? [media] : undefined,
      stats: input.likes !== undefined ? { likes: input.likes } : undefined,
      createdAt: input.createdAt,
    },
  };
}

export interface MessageDraftInput {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  from?: string;
}

export function buildMessageDraftPayload(input: MessageDraftInput, id = displayId('draft')) {
  if (!input.to.length) throw new Error('At least one recipient is required.');
  return {
    id,
    channel: 'email' as const,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    bcc: input.bcc?.length ? input.bcc : undefined,
    from: input.from,
    subject: input.subject,
    body: input.body,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const displayOutput = z.object({
  ok: z.boolean(),
  component: z.string(),
  payload: z.any(),
  summary: z.string().optional(),
  error: z.string().optional(),
});

type DisplayOutput = z.infer<typeof displayOutput>;

function displayResult(component: string, build: () => unknown, summary?: string): DisplayOutput {
  try {
    return { ok: true, component, payload: build(), summary };
  } catch (err: any) {
    return { ok: false, component, payload: null, error: err?.message || 'Invalid display payload.' };
  }
}

// Weather fetch seam for tests.
let weatherFetchOverride: FetchLike | undefined;
export function setWeatherFetchForTests(fetchImpl: FetchLike | undefined) {
  weatherFetchOverride = fetchImpl;
}

export const showWeather = defineTool({
  name: 'show_weather',
  description:
    "Fetch real current weather and a 7-day forecast (Open-Meteo, no key needed) and render it as a designed weather card in the chat. Pass a place name ('Rochester NY'), or coordinates, or NOTHING — with no location it falls back to the user's timezone city. Also returns a text summary you can reference.",
  category: 'web',
  mutating: false,
  input: z.object({
    place: z.string().optional().describe("Place name, e.g. 'Rochester NY' or 'Paris'."),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    unit: z.enum(['celsius', 'fahrenheit']).optional().describe('Defaults from the user timezone.'),
  }),
  output: displayOutput,
  async handler(args) {
    const timezone = getAiRequestContext().userTimezone;
    try {
      const weather = await briefWeather(
        {
          place: args.place,
          latitude: args.latitude,
          longitude: args.longitude,
          unit: args.unit,
          timezone,
        },
        weatherFetchOverride ? { fetchImpl: weatherFetchOverride } : {},
      );
      if (!weather) {
        return {
          ok: false,
          component: 'weather-widget',
          payload: null,
          error: 'Could not resolve a location — pass a place name.',
        };
      }
      const payload = toWeatherWidgetPayload({
        id: displayId('weather'),
        locationName: weather.locationName,
        forecast: {
          timezone: weather.timezone,
          unit: weather.unit,
          current: weather.current,
          hourly: weather.hourly,
          daily: weather.daily,
        },
      });
      return { ok: true, component: 'weather-widget', payload, summary: weatherSummaryLine(weather) };
    } catch (err: any) {
      return {
        ok: false,
        component: 'weather-widget',
        payload: null,
        error: err?.message || 'Weather lookup failed.',
      };
    }
  },
});

export const showChart = defineTool({
  name: 'show_chart',
  description:
    'Render a designed bar or line chart in the chat from data you already have (mail counts, task throughput, calendar load, research numbers). Rows are objects; xKey names the x-axis field; each series key must be a numeric field on every row.',
  category: 'meta',
  mutating: false,
  input: z.object({
    type: z.enum(['bar', 'line']),
    title: z.string().optional(),
    description: z.string().optional(),
    xKey: z.string().min(1),
    series: z
      .array(z.object({ key: z.string().min(1), label: z.string().min(1), color: z.string().optional() }))
      .min(1)
      .max(DISPLAY_LIMITS.chartSeries),
    data: z.array(z.record(z.string(), z.unknown())).min(1),
    showLegend: z.boolean().optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('chart', () => buildChartPayload(args));
  },
});

export const showStats = defineTool({
  name: 'show_stats',
  description:
    'Render key metrics as compact stat cards (value, optional delta and sparkline). Use for "how many / how much" answers with a few headline numbers.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    stats: z
      .array(
        z.object({
          label: z.string().min(1),
          value: z.union([z.number(), z.string()]),
          format: z.enum(['number', 'currency', 'percent']).optional(),
          currency: z.string().optional(),
          delta: z.number().optional().describe('Change vs the prior period, in the same unit.'),
          sparkline: z.array(z.number()).optional(),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.stats),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('stats-display', () => buildStatsPayload(args));
  },
});

export const showTable = defineTool({
  name: 'show_table',
  description:
    'Render a sortable data table in the chat. Columns declare key/label and an optional format (number, currency, percent, date); rows are plain objects keyed by column key.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    columns: z
      .array(
        z.object({
          key: z.string().min(1),
          label: z.string().min(1),
          align: z.enum(['left', 'right', 'center']).optional(),
          format: z.enum(['text', 'number', 'currency', 'percent', 'date']).optional(),
          currency: z.string().optional(),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.tableColumns),
    rows: z.array(z.record(z.string(), z.unknown())).min(1),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('data-table', () => buildTablePayload(args));
  },
});

export const showCode = defineTool({
  name: 'show_code',
  description:
    'Render a syntax-highlighted code block (with copy button and line numbers). Use whenever you present code, a config, a query, or a script.',
  category: 'meta',
  mutating: false,
  input: z.object({
    code: z.string().min(1),
    language: z.string().optional().describe("e.g. 'typescript', 'python', 'sql', 'json', 'bash'."),
    filename: z.string().optional(),
    highlightLines: z.array(z.number().int().positive()).optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('code-block', () => buildCodePayload(args));
  },
});

export const showCodeDiff = defineTool({
  name: 'show_code_diff',
  description:
    'Render a before/after code diff with syntax highlighting. Use when proposing edits to code or config.',
  category: 'meta',
  mutating: false,
  input: z.object({
    filename: z.string().min(1),
    oldCode: z.string(),
    newCode: z.string(),
    language: z.string().optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('code-diff', () => buildCodeDiffPayload(args));
  },
});

export const showTerminal = defineTool({
  name: 'show_terminal',
  description: 'Render command-line output (command, stdout/stderr, exit code) as a terminal card.',
  category: 'meta',
  mutating: false,
  input: z.object({
    command: z.string().min(1),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().min(0).optional(),
    cwd: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('terminal', () => buildTerminalPayload(args));
  },
});

export const showPlan = defineTool({
  name: 'show_plan',
  description:
    'Render a step-by-step plan/checklist card with per-step statuses (pending, in_progress, completed, cancelled). Use instead of plain Markdown whenever you present a proposed or in-flight multi-step approach.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    steps: z
      .array(
        z.object({
          label: z.string().min(1),
          description: z.string().optional(),
          status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.planTodos),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('plan', () => buildPlanPayload(args));
  },
});

export const showProgress = defineTool({
  name: 'show_progress',
  description:
    'Render a progress tracker for a multi-step operation with per-step status (pending, in-progress, completed, failed). Use to recap how a long operation went.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    steps: z
      .array(
        z.object({
          label: z.string().min(1),
          description: z.string().optional(),
          status: z.enum(['pending', 'in-progress', 'completed', 'failed']),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.progressSteps),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('progress-tracker', () => buildProgressPayload(args));
  },
});

export const showCitations = defineTool({
  name: 'show_citations',
  description:
    'Render source citations (title, domain, snippet) as designed reference cards. Use after web research to attribute where facts came from.',
  category: 'meta',
  mutating: false,
  input: z.object({
    citations: z
      .array(
        z.object({
          url: HTTP_URL,
          title: z.string().min(1),
          snippet: z.string().optional(),
          author: z.string().optional(),
          type: z.enum(['webpage', 'document', 'article', 'api', 'code', 'other']).optional(),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.citations),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('citation', () => buildCitationsPayload(args));
  },
});

export const showLinkPreview = defineTool({
  name: 'show_link_preview',
  description: 'Render one link as a rich preview card (title, description, image, domain).',
  category: 'meta',
  mutating: false,
  input: z.object({
    url: HTTP_URL,
    title: z.string().optional(),
    description: z.string().optional(),
    imageUrl: HTTP_URL.optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('link-preview', () => buildLinkPreviewPayload(args));
  },
});

export const showImage = defineTool({
  name: 'show_image',
  description: 'Render one image with caption/attribution. alt text is required.',
  category: 'meta',
  mutating: false,
  input: z.object({
    url: HTTP_URL,
    alt: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    linkUrl: HTTP_URL.optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('image', () => buildImagePayload(args));
  },
});

export const showImageGallery = defineTool({
  name: 'show_image_gallery',
  description: 'Render a grid gallery of images (each needs url + alt).',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    images: z
      .array(
        z.object({
          url: HTTP_URL,
          alt: z.string().min(1),
          title: z.string().optional(),
          width: z.number().positive().optional().describe('Pixel width, if known.'),
          height: z.number().positive().optional().describe('Pixel height, if known.'),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.galleryImages),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('image-gallery', () => buildImageGalleryPayload(args));
  },
});

export const showVideo = defineTool({
  name: 'show_video',
  description: 'Render a video player for a direct video file URL (mp4/webm), with optional poster.',
  category: 'meta',
  mutating: false,
  input: z.object({
    url: HTTP_URL,
    title: z.string().optional(),
    description: z.string().optional(),
    posterUrl: HTTP_URL.optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('video', () => buildVideoPayload(args));
  },
});

export const showAudio = defineTool({
  name: 'show_audio',
  description: 'Render an audio player for a direct audio file URL, with optional artwork and metadata.',
  category: 'meta',
  mutating: false,
  input: z.object({
    url: HTTP_URL,
    title: z.string().optional(),
    description: z.string().optional(),
    artworkUrl: HTTP_URL.optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('audio', () => buildAudioPayload(args));
  },
});

export const showMap = defineTool({
  name: 'show_map',
  description:
    'Render an interactive map with labeled markers (latitude/longitude). Use for places found in research, event locations, or itineraries.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    markers: z
      .array(
        z.object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          label: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.mapMarkers),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('geo-map', () => buildMapPayload(args));
  },
});

export const showCarousel = defineTool({
  name: 'show_carousel',
  description:
    'Render a horizontal carousel of items (name, subtitle, optional image). Use for browsable collections — options, products, articles.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    items: z
      .array(
        z.object({ name: z.string().min(1), subtitle: z.string().optional(), imageUrl: HTTP_URL.optional() }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.carouselItems),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('item-carousel', () => buildCarouselPayload(args));
  },
});

export const showOrderSummary = defineTool({
  name: 'show_order_summary',
  description:
    'Render an itemized purchase/receipt summary with pricing (subtotal, tax, shipping, discount, total). Use for receipts found in mail or purchase breakdowns.',
  category: 'meta',
  mutating: false,
  input: z.object({
    title: z.string().optional(),
    items: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          quantity: z.number().int().positive().optional(),
          unitPrice: z.number(),
          imageUrl: HTTP_URL.optional(),
        }),
      )
      .min(1)
      .max(DISPLAY_LIMITS.orderItems),
    currency: z.string().optional(),
    tax: z.number().optional(),
    shipping: z.number().optional(),
    discount: z.number().nonnegative().optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('order-summary', () => buildOrderSummaryPayload(args));
  },
});

export const showSocialPost = defineTool({
  name: 'show_social_post',
  description:
    'Render a social post preview (X, LinkedIn, or Instagram) — for showing a post found in research or drafting one for review.',
  category: 'meta',
  mutating: false,
  input: z.object({
    network: z.enum(['x', 'linkedin', 'instagram']),
    authorName: z.string().min(1),
    authorHandle: z.string().optional(),
    authorAvatarUrl: HTTP_URL.optional(),
    authorHeadline: z.string().optional().describe('LinkedIn only.'),
    text: z.string().optional(),
    imageUrl: HTTP_URL.optional(),
    imageAlt: z.string().optional(),
    likes: z.number().optional(),
    createdAt: z.string().optional(),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('social-post', () => buildSocialPostPayload(args));
  },
});

export const showMessageDraft = defineTool({
  name: 'show_message_draft',
  description:
    'Render an email draft as a designed review card in the chat (to/cc/subject/body). The card offers "Open in composer" — the user reviews and sends themselves. Prefer this over pasting a draft as plain text.',
  category: 'meta',
  mutating: false,
  input: z.object({
    to: z.array(z.string().min(1)).min(1),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    from: z.string().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  output: displayOutput,
  async handler(args) {
    return displayResult('message-draft', () => buildMessageDraftPayload(args));
  },
});

export const DISPLAY_TOOLS = [
  showWeather,
  showChart,
  showStats,
  showTable,
  showCode,
  showCodeDiff,
  showTerminal,
  showPlan,
  showProgress,
  showCitations,
  showLinkPreview,
  showImage,
  showImageGallery,
  showVideo,
  showAudio,
  showMap,
  showCarousel,
  showOrderSummary,
  showSocialPost,
  showMessageDraft,
];

export const DISPLAY_TOOL_NAMES = DISPLAY_TOOLS.map((tool) => tool.name);
