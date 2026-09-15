import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlideSurface } from '@/components/files/editors/SlideRenderer';
import type { DeckModelV2 } from './model';

/**
 * Server-side rendering of a deck for the visual quality check: one
 * self-contained HTML page per deck (fonts inlined) and one PNG per slide
 * from a pinned browser. Local runs use the installed Playwright Chromium;
 * deployments use a Browserbase session over CDP so no browser ships in the
 * image. Fonts are the packaged files under public/fonts.
 */

export const RENDER_WIDTH = 1920;
export const RENDER_HEIGHT = 1080;

const FONT_FILES = [
  { family: 'Fraunces', file: 'Fraunces-Variable.woff2', style: 'normal', weight: '300 900' },
  { family: 'Fraunces', file: 'Fraunces-Variable-ext.woff2', style: 'normal', weight: '300 900' },
  { family: 'Fraunces', file: 'Fraunces-Italic-Variable.woff2', style: 'italic', weight: '300 900' },
  { family: 'Fraunces', file: 'Fraunces-Italic-Variable-ext.woff2', style: 'italic', weight: '300 900' },
  { family: 'Geist', file: 'Geist-Regular.woff2', style: 'normal', weight: '400' },
  { family: 'Geist', file: 'Geist-Medium.woff2', style: 'normal', weight: '500' },
  { family: 'Geist', file: 'Geist-SemiBold.woff2', style: 'normal', weight: '600' },
  { family: 'Geist', file: 'Geist-Bold.woff2', style: 'normal', weight: '700' },
  { family: 'Geist Mono', file: 'GeistMono-Regular.woff2', style: 'normal', weight: '400' },
] as const;

const SLIDE_CSS = `
html,body{margin:0;padding:0;background:#000}
.deck-slide{container-type:inline-size;position:relative;aspect-ratio:16/9;overflow:hidden;background:#fff;width:${RENDER_WIDTH}px;font-optical-sizing:none;font-variation-settings:"opsz" 14}
.deck-slide .deck-element{position:absolute;box-sizing:border-box;line-height:1.2;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap}
.deck-slide .deck-element .deck-text{display:block;width:100%}
.deck-slide .deck-element[data-element-type="line"],.deck-slide .deck-element[data-element-type="chart"],.deck-slide .deck-element[data-element-type="image"]{overflow:visible;padding:0;background:transparent;border:0}
.deck-slide .deck-line,.deck-slide .deck-chart{display:block;width:100%;height:100%}
.deck-slide .deck-image{display:block;width:100%;height:100%}
.deck-slide .deck-image-missing{display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:var(--deck-surface);color:var(--deck-muted);font-family:var(--deck-body);font-size:1.5cqw}
.deck-slide .deck-slide-background{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none}
.slide-frame{width:${RENDER_WIDTH}px;height:${RENDER_HEIGHT}px;overflow:hidden}
`;

async function fontFaces(publicDir: string) {
  const faces: string[] = [];
  for (const font of FONT_FILES) {
    try {
      const bytes = await readFile(path.join(publicDir, 'fonts', font.file));
      faces.push(
        `@font-face{font-family:"${font.family}";font-style:${font.style};font-weight:${font.weight};font-display:block;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2")}`,
      );
    } catch {
      // A missing packaged font falls back to the stack's next family.
    }
  }
  // The renderer's CSS variables resolve to these names when the app variables are absent.
  faces.push(
    ':root{--font-fraunces:"Fraunces";--font-geist-sans:"Geist";--font-geist-mono:"Geist Mono";--font-instrument:"Instrument Serif"}',
  );
  return faces.join('\n');
}

/** Absolute image sources so a remote browser can load owned assets. */
function absolutize(model: DeckModelV2, origin: string | undefined): DeckModelV2 {
  if (!origin) return model;
  const fix = (src?: string) => (src?.startsWith('/') ? `${origin}${src}` : src);
  return {
    ...model,
    slides: model.slides.map((slide) => ({
      ...slide,
      ...(slide.backgroundImage
        ? { backgroundImage: { ...slide.backgroundImage, src: fix(slide.backgroundImage.src) } }
        : {}),
      elements: slide.elements.map((element) =>
        element.type === 'image' ? { ...element, src: fix(element.src) } : element,
      ),
    })),
  };
}

export interface RenderDeckHtmlOptions {
  /** Origin for relative asset paths, e.g. the app URL. */
  assetOrigin?: string;
  publicDir?: string;
}

/** One page with every slide stacked, each inside a fixed 1920 by 1080 frame. */
export async function renderDeckHtml(model: DeckModelV2, options: RenderDeckHtmlOptions = {}) {
  const publicDir = options.publicDir ?? path.resolve(process.cwd(), 'public');
  const deck = absolutize(model, options.assetOrigin);
  const slides = deck.slides
    .map(
      (slide, index) =>
        `<div class="slide-frame" data-slide-index="${index}" data-slide-id="${slide.id}">${renderToStaticMarkup(
          createElement(SlideSurface, { slide, theme: deck.theme }),
        )}</div>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${await fontFaces(publicDir)}\n${SLIDE_CSS}</style></head><body>${slides}</body></html>`;
}

export interface RenderedSlide {
  slideId: string;
  index: number;
  png: Buffer;
}

export interface RenderDeckOptions extends RenderDeckHtmlOptions {
  /** `local` launches the installed Playwright Chromium; `browserbase` connects over CDP. */
  browser?: 'local' | 'browserbase';
  timeoutMs?: number;
}

async function connectBrowser(kind: 'local' | 'browserbase') {
  const { chromium } = await import('playwright-core');
  if (kind === 'browserbase') {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) throw new Error('Browserbase is not configured for slide rendering.');
    const response = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'x-bb-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Browserbase session failed (${response.status}).`);
    const session = (await response.json()) as { connectUrl?: string; id: string };
    if (!session.connectUrl) throw new Error('Browserbase returned no connect URL.');
    const browser = await chromium.connectOverCDP(session.connectUrl);
    return { browser, close: () => browser.close() };
  }
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  });
  return { browser, close: () => browser.close() };
}

/** Which browser the environment can offer, or null when none is available. */
export function availableRenderBrowser(): 'local' | 'browserbase' | null {
  if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) return 'browserbase';
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.NODE_ENV !== 'production') return 'local';
  return null;
}

const defaultDependencies = { connectBrowser };
let dependencies = defaultDependencies;
export function __setDeckRenderDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

/** Render every slide to PNG. Throws when no browser is available or a slide fails. */
export async function renderDeckSlides(
  model: DeckModelV2,
  options: RenderDeckOptions = {},
): Promise<RenderedSlide[]> {
  const kind = options.browser ?? availableRenderBrowser();
  if (!kind) throw new Error('No render browser is available.');
  const html = await renderDeckHtml(model, options);
  const { browser, close } = await dependencies.connectBrowser(kind);
  try {
    const context = await browser.newContext({
      viewport: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? 60_000);
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForTimeout(150);
    const rendered: RenderedSlide[] = [];
    for (const [index, slide] of model.slides.entries()) {
      const png = await page.locator(`[data-slide-index="${index}"]`).screenshot({ type: 'png' });
      rendered.push({ slideId: slide.id, index, png });
    }
    await context.close();
    return rendered;
  } finally {
    await close().catch(() => undefined);
  }
}
