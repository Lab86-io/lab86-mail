import type { DeckElementV2, DeckModelV2, DeckSlideV2, DeckTheme } from './model';

/**
 * Measurable quality checks for a version 2 deck. These run before a deck is
 * reported finished and again after a bounded repair. They are necessary,
 * not sufficient: a clean report does not mean a slide looks good.
 */

export type DeckIssueKind =
  | 'off-canvas'
  | 'overlap'
  | 'overflow'
  | 'small-type'
  | 'low-contrast'
  | 'missing-image'
  | 'too-much-copy'
  | 'empty-slide';

export interface DeckIssue {
  kind: DeckIssueKind;
  severity: 'error' | 'warning';
  slideId: string;
  elementIds: string[];
  message: string;
}

export interface DeckQualityReport {
  ok: boolean;
  issues: DeckIssue[];
}

const SLIDE_WIDTH_PT = 960;
const SLIDE_HEIGHT_PT = 540;
const MAX_WORDS_PER_SLIDE = 90;
const MIN_FONT_PT = 10;
/** Average glyph advance as a fraction of the font size, per font slot. */
const GLYPH_WIDTH = { display: 0.52, body: 0.5, mono: 0.6 } as const;

type TextElement = Extract<DeckElementV2, { type: 'text' }>;

function textSize(element: TextElement) {
  if (element.fontSize) return element.fontSize;
  switch (element.role) {
    case 'title':
      return 28;
    case 'number':
      return 64;
    case 'subtitle':
      return 20;
    case 'caption':
    case 'kicker':
      return 12;
    default:
      return 16;
  }
}

function slot(element: TextElement): keyof typeof GLYPH_WIDTH {
  if (element.font) return element.font;
  return element.role === 'title' || element.role === 'number' ? 'display' : 'body';
}

function lineHeight(element: TextElement) {
  return element.lineHeight ?? (slot(element) === 'display' ? 1.05 : 1.3);
}

/** Estimated lines the text needs in its box, from average glyph widths. */
export function estimateTextLines(element: TextElement) {
  const size = textSize(element);
  const boxWidthPt = (element.width / 100) * SLIDE_WIDTH_PT;
  const glyph = size * GLYPH_WIDTH[slot(element)] * (1 + (element.letterSpacing ?? 0));
  const perLine = Math.max(1, Math.floor(boxWidthPt / glyph));
  let lines = 0;
  for (const paragraph of element.text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines += 1;
      continue;
    }
    let used = 0;
    let count = 1;
    for (const word of words) {
      const length = word.length + (used ? 1 : 0);
      if (used + length > perLine && used > 0) {
        count += 1;
        used = word.length;
      } else used += length;
    }
    lines += count;
  }
  return lines;
}

/** Does the text fit its box height at its size and line height? */
export function textFits(element: TextElement) {
  const needed = estimateTextLines(element) * textSize(element) * lineHeight(element);
  const available = (element.height / 100) * SLIDE_HEIGHT_PT;
  return needed <= available * 1.02;
}

function hexToRgb(value: string) {
  const hex = value.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function luminance(rgb: [number, number, number]) {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors; null when a color is not hex. */
export function contrastRatio(foreground: string, background: string) {
  const a = hexToRgb(foreground);
  const b = hexToRgb(background);
  if (!a || !b) return null;
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type Box = { x: number; y: number; width: number; height: number };

function overlapArea(a: Box, b: Box) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(outer: Box, inner: Box) {
  return (
    inner.x >= outer.x - 0.01 &&
    inner.y >= outer.y - 0.01 &&
    inner.x + inner.width <= outer.x + outer.width + 0.01 &&
    inner.y + inner.height <= outer.y + outer.height + 0.01
  );
}

/** Elements that carry content; decorative shapes and lines may sit under them. */
function isContent(element: DeckElementV2) {
  if (element.type === 'text') return element.text.trim().length > 0;
  if (element.type === 'image') return !element.decorative;
  return element.type === 'chart';
}

/** The color under a text element: the topmost filled shape that contains it, else the slide. */
function backgroundUnder(slide: DeckSlideV2, theme: DeckTheme, element: DeckElementV2, index: number) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const below = slide.elements[i];
    if (below.type === 'shape' && contains(below, element)) return below.fill ?? theme.colors.surface;
    if (below.type === 'image' && contains(below, element)) return null;
    if (below.type === 'text' && below.fill && contains(below, element)) return below.fill;
  }
  return slide.background ?? theme.colors.background;
}

export function checkSlide(slide: DeckSlideV2, theme: DeckTheme): DeckIssue[] {
  const issues: DeckIssue[] = [];
  const push = (
    kind: DeckIssueKind,
    severity: DeckIssue['severity'],
    elementIds: string[],
    message: string,
  ) => issues.push({ kind, severity, slideId: slide.id, elementIds, message });
  if (!slide.elements.some(isContent) && !slide.backgroundImage)
    push('empty-slide', 'error', [], 'The slide has no content.');
  let words = 0;
  slide.elements.forEach((element, index) => {
    if (
      element.x < 0 ||
      element.y < 0 ||
      element.x + element.width > 100.01 ||
      element.y + element.height > 100.01
    )
      push('off-canvas', 'error', [element.id], `${element.type} "${element.id}" leaves the slide.`);
    if (element.type === 'image' && !element.src)
      push(
        'missing-image',
        'error',
        [element.id],
        `Image "${element.alt || element.id}" has no owned source.`,
      );
    if (element.type === 'text') {
      words += element.text.split(/\s+/).filter(Boolean).length;
      if (element.text.trim() && textSize(element) < MIN_FONT_PT)
        push('small-type', 'warning', [element.id], `Text "${element.id}" is set under ${MIN_FONT_PT} pt.`);
      if (element.text.trim() && !textFits(element))
        push('overflow', 'error', [element.id], `Text "${element.id}" does not fit its box.`);
      const background = backgroundUnder(slide, theme, element, index);
      if (element.text.trim() && background) {
        const ratio = contrastRatio(element.color ?? theme.colors.ink, element.fill ?? background);
        const needed = slot(element) === 'display' && textSize(element) >= 24 ? 3 : 4.5;
        if (ratio !== null && Math.round(ratio * 100) / 100 < needed)
          push(
            'low-contrast',
            'error',
            [element.id],
            `Text "${element.id}" has ${ratio.toFixed(1)}:1 contrast; ${needed}:1 is the floor.`,
          );
      }
    }
  });
  if (words > MAX_WORDS_PER_SLIDE)
    push(
      'too-much-copy',
      'warning',
      [],
      `The slide holds ${words} words; ${MAX_WORDS_PER_SLIDE} is the ceiling.`,
    );
  const content = slide.elements.filter(isContent);
  for (let i = 0; i < content.length; i += 1)
    for (let j = i + 1; j < content.length; j += 1) {
      const a = content[i];
      const b = content[j];
      if (a.overlapAllowed || b.overlapAllowed) continue;
      const area = overlapArea(a, b);
      if (area > 0.5) push('overlap', 'error', [a.id, b.id], `"${a.id}" and "${b.id}" overlap.`);
    }
  return issues;
}

export function checkDeck(model: DeckModelV2): DeckQualityReport {
  const issues = model.slides.flatMap((slide) => checkSlide(slide, model.theme));
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

const round = (value: number) => Math.round(value * 100) / 100;

function clampBox<T extends Box>(element: T): T {
  const width = Math.min(100, Math.max(0, element.width));
  const height = Math.min(100, Math.max(0, element.height));
  return {
    ...element,
    width: round(width),
    height: round(height),
    x: round(Math.min(100 - width, Math.max(0, element.x))),
    y: round(Math.min(100 - height, Math.max(0, element.y))),
  };
}

/**
 * Bounded automatic repair: pull elements back on canvas and step overflowing
 * text down in size, never below the readable floor. Returns the repaired deck
 * and the report after the last pass. Overlap, contrast and missing images are
 * not repaired here; they need a design decision.
 */
export function repairDeck(
  model: DeckModelV2,
  passes = 3,
): { model: DeckModelV2; report: DeckQualityReport } {
  let current = model;
  let report = checkDeck(current);
  for (let pass = 0; pass < passes && !report.ok; pass += 1) {
    const overflowing = new Set(
      report.issues.filter((issue) => issue.kind === 'overflow').flatMap((issue) => issue.elementIds),
    );
    const offCanvas = new Set(
      report.issues.filter((issue) => issue.kind === 'off-canvas').flatMap((issue) => issue.elementIds),
    );
    if (!overflowing.size && !offCanvas.size) break;
    current = {
      ...current,
      slides: current.slides.map((slide) => ({
        ...slide,
        elements: slide.elements.map((element) => {
          let next = element;
          if (offCanvas.has(element.id)) next = clampBox(next);
          if (next.type === 'text' && overflowing.has(next.id)) {
            const size = textSize(next);
            const smaller = Math.max(MIN_FONT_PT, Math.round(size * 0.9));
            if (smaller < size) next = { ...next, fontSize: smaller };
          }
          return next;
        }),
      })),
    };
    report = checkDeck(current);
  }
  return { model: current, report };
}
