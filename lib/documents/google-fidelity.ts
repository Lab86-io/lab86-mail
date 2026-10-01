import {
  DOC_LINK_PATTERN,
  type DocBlock,
  type DocRun,
  type DocumentKind,
  MAX_DOC_LINK_LENGTH,
  MAX_DOC_LIST_LEVEL,
} from './model';

export class GoogleDocumentFidelityError extends Error {
  constructor(
    message = 'This file contains content Albatross cannot safely preserve. Open it in Google to edit the original.',
  ) {
    super(message);
    this.name = 'GoogleDocumentFidelityError';
  }
}

// The quote style the writer (lib/documents/google.ts) applies.
export const GOOGLE_QUOTE_COLOR = '#52606D';
export const GOOGLE_QUOTE_INDENT_PT = 24;
/** The color Google Docs gives to a new link. */
export const GOOGLE_LINK_COLOR = '#1155CC';
/** The font the writer gives to new code text. */
export const GOOGLE_CODE_FONT = 'Courier New';

/** Monospace fonts from the Docs font menu. A run in one of them reads as code. */
const MONOSPACE_FONTS = new Set(
  [
    'Courier New',
    'Courier Prime',
    'Cousine',
    'Roboto Mono',
    'Source Code Pro',
    'Inconsolata',
    'Ubuntu Mono',
    'Fira Code',
    'Fira Mono',
    'JetBrains Mono',
    'IBM Plex Mono',
    'Space Mono',
    'Noto Sans Mono',
    'PT Mono',
    'Anonymous Pro',
    'Overpass Mono',
    'Red Hat Mono',
    'DM Mono',
    'Consolas',
  ].map((font) => font.toLowerCase()),
);

/**
 * `plain` is the text-only subset: text, headings 1 to 3, one-level lists and
 * the writer's quotes. Clients that do not know inline formatting (the iOS
 * app) use it, so they can never drop formatting that they do not show.
 * `rich` adds bold, italic, underline, strikethrough, code (a monospace font),
 * links, nested lists, and the title and subtitle styles.
 */
export type GoogleDocMode = 'plain' | 'rich';

export function googleDocMode(value: unknown): GoogleDocMode {
  return value === 'rich' ? 'rich' : 'plain';
}

export interface GoogleCharStyle {
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  code?: true;
  link?: string;
}

export type GoogleListKind = 'bullet' | 'numbered';

export interface GoogleDocListState {
  listId: string;
  kind: GoogleListKind;
  level: number;
}

/** A run of one paragraph with the same style. `font` is the family of a code run. */
export interface GoogleDocSpan {
  text: string;
  style: GoogleCharStyle;
  font?: string;
}

export interface GoogleDocParagraph {
  /** UTF-16 index of the first character. */
  startIndex: number;
  /** UTF-16 index after the closing newline. */
  endIndex: number;
  namedStyleType: string;
  /** The editor block, without an id. `text` uses `\n` for a line break. */
  block: Omit<DocBlock, 'id'>;
  spans: GoogleDocSpan[];
  list?: GoogleDocListState;
  quote: boolean;
  /** Explicit paragraph properties that only repeat the named style. */
  redundantKeys: string[];
}

export interface GoogleDocProjection {
  paragraphs: GoogleDocParagraph[];
  /** Why the Doc cannot be edited; empty when it can. */
  reasons: string[];
  lists: Record<string, any>;
  revisionId?: string;
}

const REASON = {
  unreadable: 'content that Albatross cannot read',
  tabs: 'more than one tab',
  suggestions: 'suggested edits',
  tables: 'tables',
  toc: 'a table of contents',
  sectionBreaks: 'section breaks',
  images: 'images or drawings',
  positioned: 'positioned images',
  pageBreaks: 'page breaks',
  columnBreaks: 'column breaks',
  footnotes: 'footnotes',
  rules: 'horizontal lines',
  equations: 'equations',
  autoText: 'page numbers or other automatic text',
  chips: 'smart chips',
  namedRanges: 'named ranges',
  colors: 'text colors',
  highlights: 'highlight colors',
  sizes: 'font sizes',
  fonts: 'fonts',
  offsets: 'superscript or subscript text',
  smallCaps: 'small caps',
  textStyles: 'text styles that Albatross cannot keep',
  layout: 'paragraph alignment, spacing or indents',
  borders: 'paragraph borders or shading',
  paragraphStyles: 'paragraph styles that Albatross cannot keep',
  deepHeadings: 'headings below level 3',
  listHeadings: 'headings in lists',
  rtl: 'right-to-left text',
  listStyles: 'list styles that Albatross cannot keep',
  checklists: 'checklists',
  internalLinks: 'links to places in the document',
  linkStyles: 'links that Albatross cannot keep',
  // Only the plain subset refuses these.
  formatting: 'text formatting',
  links: 'links',
  nestedLists: 'nested lists',
  titles: 'title or subtitle styles',
} as const;

export const GOOGLE_DOC_OPEN_COMMENTS_REASON = 'open comments';
export const GOOGLE_DOC_UNCHECKED_COMMENTS_REASON = 'comments that Albatross cannot check';

/** The notice for a Doc that opens as a preview. `reasons` are short noun phrases. */
export function googlePreviewReason(reasons: readonly string[]) {
  const unique = [...new Set(reasons)];
  if (!unique.length) return GOOGLE_PREVIEW_ONLY;
  const shown = unique.slice(0, 4);
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  const more = unique.length > shown.length ? ', and other content' : '';
  return `Preview only: this Doc has ${list}${more}. Albatross cannot edit ${
    unique.length > 1 ? 'these' : 'this'
  } safely here. Open the original in Google to edit it.`;
}

const GOOGLE_PREVIEW_ONLY =
  'Preview only: this file’s formatting or content cannot yet be safely round-tripped. Open the original in Google to edit it.';

// The Docs editor defaults, used when a Doc does not send its named styles.
const DEFAULT_TEXT_STYLE: Record<string, unknown> = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  smallCaps: false,
  baselineOffset: 'NONE',
  backgroundColor: {},
  foregroundColor: { color: { rgbColor: {} } },
  fontSize: { magnitude: 11, unit: 'PT' },
  weightedFontFamily: { fontFamily: 'Arial', weight: 400 },
};
const DEFAULT_PARAGRAPH_STYLE: Record<string, unknown> = {
  alignment: 'START',
  direction: 'LEFT_TO_RIGHT',
  lineSpacing: 115,
  spacingMode: 'COLLAPSE_LISTS',
  spaceAbove: { unit: 'PT' },
  spaceBelow: { unit: 'PT' },
  indentStart: { unit: 'PT' },
  indentFirstLine: { unit: 'PT' },
  indentEnd: { unit: 'PT' },
  keepLinesTogether: false,
  keepWithNext: false,
  avoidWidowAndOrphan: true,
  pageBreakBefore: false,
};

const LAYOUT_KEYS = new Set([
  'alignment',
  'lineSpacing',
  'spacingMode',
  'spaceAbove',
  'spaceBelow',
  'indentStart',
  'indentFirstLine',
  'indentEnd',
  'keepLinesTogether',
  'keepWithNext',
  'avoidWidowAndOrphan',
  'tabStops',
]);
const BORDER_KEYS = new Set([
  'borderBetween',
  'borderTop',
  'borderBottom',
  'borderLeft',
  'borderRight',
  'shading',
]);
const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN']);
const CHECKBOX_GLYPH = '❏';

/** Comparable form of a Docs value: missing magnitudes and color parts are 0. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'number') return Math.round(value * 1000) / 1000;
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if ('rgbColor' in object && Object.keys(object).length === 1) {
    const rgb = (object.rgbColor || {}) as Record<string, number>;
    return { rgbColor: [rgb.red || 0, rgb.green || 0, rgb.blue || 0].map((part) => Math.round(part * 100)) };
  }
  if ('unit' in object && Object.keys(object).every((key) => key === 'unit' || key === 'magnitude')) {
    return { magnitude: canonical(Number(object.magnitude) || 0), unit: object.unit };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) out[key] = canonical(object[key]);
  return out;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function hexRgb(hex: string) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

export function googleRgbColor(hex: string) {
  const [red, green, blue] = hexRgb(hex);
  return { color: { rgbColor: { red, green, blue } } };
}

function isColor(optionalColor: any, hex: string) {
  const rgb = optionalColor?.color?.rgbColor;
  if (!rgb) return false;
  const expected = hexRgb(hex);
  return [rgb.red ?? 0, rgb.green ?? 0, rgb.blue ?? 0].every(
    (value: number, index: number) => Math.abs(value - expected[index]) < 0.01,
  );
}

function isPoints(dimension: any, points: number) {
  return dimension?.unit === 'PT' && Math.abs(Number(dimension.magnitude) - points) < 0.01;
}

/** Text and paragraph styles of each named style, with the normal text style and editor defaults under them. */
function namedStyleTable(tab: any) {
  const styles = new Map<string, { text: Record<string, unknown>; paragraph: Record<string, unknown> }>();
  const source = Array.isArray(tab?.namedStyles?.styles) ? tab.namedStyles.styles : [];
  const byType = new Map<string, any>(source.map((style: any) => [String(style?.namedStyleType), style]));
  const normal = byType.get('NORMAL_TEXT') || {};
  const resolve = (type: string) => {
    const cached = styles.get(type);
    if (cached) return cached;
    const own = type === 'NORMAL_TEXT' ? {} : byType.get(type) || {};
    const resolved = {
      text: { ...DEFAULT_TEXT_STYLE, ...(normal.textStyle || {}), ...(own.textStyle || {}) },
      paragraph: {
        ...DEFAULT_PARAGRAPH_STYLE,
        ...(normal.paragraphStyle || {}),
        ...(own.paragraphStyle || {}),
      },
    };
    styles.set(type, resolved);
    return resolved;
  };
  return resolve;
}

/** True when an object, at any depth, has a `suggested…` key (an open suggestion). */
function hasSuggestions(value: unknown) {
  const stack: unknown[] = [value];
  while (stack.length) {
    const next = stack.pop();
    if (!next || typeof next !== 'object') continue;
    if (Array.isArray(next)) {
      for (const item of next) if (item && typeof item === 'object') stack.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(next)) {
      if (key.startsWith('suggested')) return true;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

/** The one document tab, in the shape with or without `includeTabsContent`. */
export function googleDocumentTab(source: any): { tab: any; tabCount: number } {
  const tabs = Array.isArray(source?.tabs) ? source.tabs : [];
  if (!tabs.length) return { tab: source ?? {}, tabCount: 1 };
  const nested = tabs.some((tab: any) => Array.isArray(tab?.childTabs) && tab.childTabs.length);
  return { tab: tabs[0]?.documentTab ?? {}, tabCount: nested ? Math.max(2, tabs.length) : tabs.length };
}

function listKindAt(list: any, level: number): GoogleListKind | 'checklist' | null {
  const nesting = list?.listProperties?.nestingLevels?.[level];
  if (!nesting) return null;
  if (typeof nesting.glyphSymbol === 'string' && nesting.glyphSymbol) {
    return nesting.glyphSymbol === CHECKBOX_GLYPH ? 'checklist' : 'bullet';
  }
  if (ORDERED_GLYPHS.has(nesting.glyphType)) return 'numbered';
  return null;
}

/** The bullet preset that makes the same glyphs as a list, so a new item can join it. */
export function googleListPreset(list: any, kind: GoogleListKind): string | null {
  const levels = list?.listProperties?.nestingLevels;
  if (!Array.isArray(levels) || levels.length < 3) return null;
  const glyph = (level: any) => {
    if (typeof level?.glyphSymbol === 'string' && level.glyphSymbol) {
      return (
        {
          '●': 'DISC',
          '○': 'CIRCLE',
          '■': 'SQUARE',
          '❖': 'DIAMONDX',
          '➢': 'ARROW3D',
          '➔': 'ARROW',
          '◆': 'DIAMOND',
          '★': 'STAR',
          '◄': 'LEFTTRIANGLE',
          '◇': 'HOLLOWDIAMOND',
        } as Record<string, string>
      )[level.glyphSymbol];
    }
    return {
      DECIMAL: 'DECIMAL',
      ZERO_DECIMAL: 'ZERODECIMAL',
      ALPHA: 'ALPHA',
      UPPER_ALPHA: 'UPPERALPHA',
      ROMAN: 'ROMAN',
      UPPER_ROMAN: 'UPPERROMAN',
    }[String(level?.glyphType)];
  };
  const glyphs = levels.slice(0, 3).map(glyph);
  if (glyphs.some((value) => !value)) return null;
  const name = glyphs.join('_');
  if (kind === 'bullet') {
    const preset = `BULLET_${name}`;
    return [
      'BULLET_DISC_CIRCLE_SQUARE',
      'BULLET_DIAMONDX_ARROW3D_SQUARE',
      'BULLET_ARROW_DIAMOND_DISC',
      'BULLET_STAR_CIRCLE_SQUARE',
      'BULLET_ARROW3D_CIRCLE_SQUARE',
      'BULLET_LEFTTRIANGLE_DIAMOND_DISC',
      'BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE',
      'BULLET_DIAMOND_CIRCLE_SQUARE',
    ].includes(preset)
      ? preset
      : null;
  }
  const format = String(levels[0]?.glyphFormat || '');
  if (name === 'DECIMAL_DECIMAL_DECIMAL') return 'NUMBERED_DECIMAL_NESTED';
  if (name === 'DECIMAL_ALPHA_ROMAN')
    return format.endsWith(')') ? 'NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS' : 'NUMBERED_DECIMAL_ALPHA_ROMAN';
  if (name === 'UPPERALPHA_ALPHA_ROMAN') return 'NUMBERED_UPPERALPHA_ALPHA_ROMAN';
  if (name === 'UPPERROMAN_UPPERALPHA_DECIMAL') return 'NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL';
  if (name === 'ZERODECIMAL_ALPHA_ROMAN') return 'NUMBERED_ZERODECIMAL_ALPHA_ROMAN';
  return null;
}

/** Same style, with links compared as parsed addresses. A link is always underlined in Docs. */
export function sameCharStyle(left: GoogleCharStyle, right: GoogleCharStyle) {
  return (
    Boolean(left.bold) === Boolean(right.bold) &&
    Boolean(left.italic) === Boolean(right.italic) &&
    Boolean(left.underline || left.link) === Boolean(right.underline || right.link) &&
    Boolean(left.strike) === Boolean(right.strike) &&
    Boolean(left.code) === Boolean(right.code) &&
    normalizeLink(left.link) === normalizeLink(right.link)
  );
}

export function normalizeLink(link: string | undefined) {
  if (!link) return '';
  try {
    return new URL(link).href;
  } catch {
    return link;
  }
}

/** Merge equal neighbors; drop runs and flags with no formatting. */
export function googleRunsFromSpans(spans: readonly GoogleDocSpan[]): DocRun[] | undefined {
  const runs: DocRun[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = runs.at(-1);
    const style = span.style;
    if (last && sameCharStyle(last as GoogleCharStyle, style) && last.link === style.link) {
      last.text += span.text;
      continue;
    }
    runs.push({ text: span.text, ...style });
  }
  return runs.some((run) => run.bold || run.italic || run.underline || run.strike || run.code || run.link)
    ? runs
    : undefined;
}

interface ParagraphContext {
  mode: GoogleDocMode;
  lists: Record<string, any>;
  named: ReturnType<typeof namedStyleTable>;
  reasons: Set<string>;
}

function analyzeTextStyle(
  raw: any,
  defaults: Record<string, unknown>,
  context: ParagraphContext,
): { style: GoogleCharStyle; font?: string } {
  const style: GoogleCharStyle = {};
  const textStyle = raw && typeof raw === 'object' ? raw : {};
  let font: string | undefined;
  const link = textStyle.link;
  if (link && typeof link === 'object' && Object.keys(link).length) {
    const url = typeof link.url === 'string' ? link.url : '';
    if (!url) context.reasons.add(REASON.internalLinks);
    else if (url.length > MAX_DOC_LINK_LENGTH || !DOC_LINK_PATTERN.test(url))
      context.reasons.add(REASON.linkStyles);
    else style.link = url;
  }
  for (const [key, value] of Object.entries(textStyle)) {
    if (key === 'link') continue;
    // A link without its underline: the writer always underlines a link.
    if (key === 'underline' && value === false && style.link) {
      context.reasons.add(REASON.linkStyles);
      continue;
    }
    if (sameValue(value, defaults[key])) continue;
    switch (key) {
      case 'bold':
      case 'italic':
      case 'strikethrough':
        if (value === true && !defaults[key]) {
          if (key === 'bold') style.bold = true;
          else if (key === 'italic') style.italic = true;
          else style.strike = true;
        } else if (value !== false || defaults[key]) context.reasons.add(REASON.textStyles);
        break;
      case 'underline':
        // A link is underlined; the underline is part of it.
        if (value === true && !defaults[key]) {
          if (!style.link) style.underline = true;
        } else context.reasons.add(REASON.textStyles);
        break;
      case 'smallCaps':
        context.reasons.add(REASON.smallCaps);
        break;
      case 'baselineOffset':
        if (value !== 'NONE' && value !== 'BASELINE_OFFSET_UNSPECIFIED') context.reasons.add(REASON.offsets);
        break;
      case 'foregroundColor':
        if (!(style.link && isColor(value, GOOGLE_LINK_COLOR))) context.reasons.add(REASON.colors);
        break;
      case 'backgroundColor':
        if (value && typeof value === 'object' && Object.keys(value).length)
          context.reasons.add(REASON.highlights);
        break;
      case 'fontSize':
        context.reasons.add(REASON.sizes);
        break;
      case 'weightedFontFamily': {
        const family = String((value as any)?.fontFamily || '');
        const weight = (value as any)?.weight;
        const defaultFamily = String((defaults.weightedFontFamily as any)?.fontFamily || '');
        if (family.toLowerCase() === defaultFamily.toLowerCase() && (weight ?? 400) === 400) break;
        if (MONOSPACE_FONTS.has(family.toLowerCase()) && (weight ?? 400) === 400) {
          style.code = true;
          font = family;
        } else context.reasons.add(REASON.fonts);
        break;
      }
      default:
        context.reasons.add(REASON.textStyles);
    }
  }
  if (context.mode === 'plain') {
    if (style.link) context.reasons.add(REASON.links);
    if (style.bold || style.italic || style.underline || style.strike || style.code)
      context.reasons.add(REASON.formatting);
  }
  return font ? { style, font } : { style };
}

/** True when every character of the paragraph has exactly the writer's quote style. */
function hasQuoteText(elements: any[], defaults: Record<string, unknown>) {
  for (const element of elements) {
    const content = String(element.textRun.content || '').replace(/\n$/u, '');
    if (!content) continue;
    const textStyle = element.textRun.textStyle || {};
    if (textStyle.italic !== true || !isColor(textStyle.foregroundColor, GOOGLE_QUOTE_COLOR)) return false;
    for (const [key, value] of Object.entries(textStyle)) {
      if (key === 'italic' || key === 'foregroundColor') continue;
      if (!sameValue(value, defaults[key])) return false;
    }
  }
  return true;
}

const ELEMENT_REASONS: Record<string, string> = {
  inlineObjectElement: REASON.images,
  pageBreak: REASON.pageBreaks,
  columnBreak: REASON.columnBreaks,
  footnoteReference: REASON.footnotes,
  horizontalRule: REASON.rules,
  equation: REASON.equations,
  autoText: REASON.autoText,
  person: REASON.chips,
  richLink: REASON.chips,
  dateElement: REASON.chips,
};

function projectParagraph(
  paragraph: any,
  startIndex: number,
  context: ParagraphContext,
): { result: GoogleDocParagraph; length: number } {
  const reasons = context.reasons;
  for (const key of Object.keys(paragraph)) {
    if (key === 'positionedObjectIds') {
      if (Array.isArray(paragraph[key]) ? paragraph[key].length : paragraph[key])
        reasons.add(REASON.positioned);
    } else if (!['elements', 'paragraphStyle', 'bullet'].includes(key) && !key.startsWith('suggested')) {
      reasons.add(REASON.unreadable);
    }
  }
  const style =
    paragraph.paragraphStyle && typeof paragraph.paragraphStyle === 'object' ? paragraph.paragraphStyle : {};
  const namedStyleType = String(style.namedStyleType || 'NORMAL_TEXT');
  const named = context.named(namedStyleType);
  const elements: any[] = Array.isArray(paragraph.elements) ? paragraph.elements : [];
  let raw = '';
  let length = 0;
  const textElements: any[] = [];
  for (const element of elements) {
    if (element?.textRun && typeof element.textRun === 'object') {
      const runContent = String(element.textRun.content ?? '');
      raw += runContent;
      length += runContent.length;
      textElements.push(element);
      for (const key of Object.keys(element.textRun))
        if (!['content', 'textStyle'].includes(key) && !key.startsWith('suggested'))
          reasons.add(REASON.unreadable);
      continue;
    }
    const kind = Object.keys(element || {}).find((key) => key !== 'startIndex' && key !== 'endIndex');
    reasons.add((kind && ELEMENT_REASONS[kind]) || REASON.unreadable);
    // A non-text element is left out of the preview text but keeps its width in the index math.
    const width = Number(element?.endIndex) - Number(element?.startIndex);
    length += Number.isFinite(width) && width > 0 ? width : 1;
  }
  if (!raw.endsWith('\n')) reasons.add(REASON.unreadable);
  const content = raw.replace(/\n$/u, '');
  const text = content.replaceAll('\u000b', '\n');

  // Paragraph style.
  const redundantKeys: string[] = [];
  let list: GoogleDocListState | undefined;
  if (paragraph.bullet) {
    const bullet = paragraph.bullet;
    if (Object.keys(bullet).some((key) => !['listId', 'nestingLevel', 'textStyle'].includes(key)))
      reasons.add(REASON.listStyles);
    const level = Number(bullet.nestingLevel) || 0;
    const kind = listKindAt(context.lists?.[bullet.listId], level);
    if (kind === 'checklist') reasons.add(REASON.checklists);
    else if (!kind || level > MAX_DOC_LIST_LEVEL) reasons.add(REASON.listStyles);
    else list = { listId: String(bullet.listId), kind, level };
    if (level > 0 && context.mode === 'plain') reasons.add(REASON.nestedLists);
    // Docs mirrors the text style of a whole item on its glyph; other glyph styles are kept from view.
    for (const [key, value] of Object.entries(bullet.textStyle || {})) {
      if (typeof value === 'boolean' || sameValue(value, named.text[key])) continue;
      reasons.add(REASON.listStyles);
    }
    if (namedStyleType !== 'NORMAL_TEXT') reasons.add(REASON.listHeadings);
  }
  const quote =
    !paragraph.bullet &&
    namedStyleType === 'NORMAL_TEXT' &&
    isPoints(style.indentStart, GOOGLE_QUOTE_INDENT_PT) &&
    (!style.indentFirstLine || sameValue(style.indentFirstLine, named.paragraph.indentFirstLine)) &&
    hasQuoteText(textElements, named.text);
  for (const [key, value] of Object.entries(style)) {
    if (key === 'namedStyleType' || key === 'headingId') continue;
    if (key === 'direction') {
      if (value === 'RIGHT_TO_LEFT') reasons.add(REASON.rtl);
      continue;
    }
    // Docs sets the indents of a list item; the writer's quote has its own indent.
    if ((paragraph.bullet || quote) && (key === 'indentStart' || key === 'indentFirstLine')) continue;
    if (key === 'pageBreakBefore' && value === true) {
      reasons.add(REASON.pageBreaks);
      continue;
    }
    if (sameValue(value, named.paragraph[key])) {
      redundantKeys.push(key);
      continue;
    }
    reasons.add(
      LAYOUT_KEYS.has(key) ? REASON.layout : BORDER_KEYS.has(key) ? REASON.borders : REASON.paragraphStyles,
    );
  }

  // Block type.
  const block: Omit<DocBlock, 'id'> = { type: 'paragraph', text };
  const heading = /^HEADING_([1-6])$/u.exec(namedStyleType);
  if (list) {
    block.type = list.kind;
    if (list.level) block.listLevel = list.level;
  } else if (paragraph.bullet) {
    // A list that cannot be read still shows as a list in the preview.
    block.type = 'bullet';
  } else if (quote) block.type = 'quote';
  else if (heading) {
    const level = Number(heading[1]);
    if (level > 3) reasons.add(REASON.deepHeadings);
    block.type = 'heading';
    block.level = Math.min(level, 3) as 1 | 2 | 3;
  } else if (namedStyleType === 'TITLE' || namedStyleType === 'SUBTITLE') {
    if (context.mode === 'plain') reasons.add(REASON.titles);
    block.type = 'heading';
    block.level = namedStyleType === 'TITLE' ? 1 : 2;
    block.variant = namedStyleType === 'TITLE' ? 'title' : 'subtitle';
  } else if (namedStyleType !== 'NORMAL_TEXT') reasons.add(REASON.paragraphStyles);

  // Text runs. The closing newline has no visible style.
  const spans: GoogleDocSpan[] = [];
  let consumed = 0;
  for (const element of textElements) {
    const runContent = String(element.textRun.content ?? '');
    const visible = runContent.slice(0, Math.max(0, Math.min(runContent.length, content.length - consumed)));
    consumed += runContent.length;
    if (!visible) continue;
    const analyzed = quote ? { style: {} } : analyzeTextStyle(element.textRun.textStyle, named.text, context);
    spans.push({ text: visible.replaceAll('\u000b', '\n'), ...analyzed });
  }
  const runs = quote ? undefined : googleRunsFromSpans(spans);
  if (runs) block.runs = runs;
  return {
    result: {
      startIndex,
      endIndex: startIndex + length,
      namedStyleType,
      block,
      spans: quote ? [{ text, style: {} }] : spans,
      ...(list ? { list } : {}),
      quote,
      redundantKeys,
    },
    length,
  };
}

/**
 * Reads a Google Doc (the JSON of `documents.get`) into editor paragraphs and
 * lists every reason it cannot be edited without loss. The reader, the
 * editability check, and the writer all use this, so a Doc the writer saved
 * opens as editable again (DOC-1).
 */
export function projectGoogleDoc(source: any, mode: GoogleDocMode = 'plain'): GoogleDocProjection {
  const reasons = new Set<string>();
  const { tab, tabCount } = googleDocumentTab(source);
  if (tabCount > 1) reasons.add(REASON.tabs);
  if (hasSuggestions(source)) reasons.add(REASON.suggestions);
  if (tab?.namedRanges && Object.keys(tab.namedRanges).length) reasons.add(REASON.namedRanges);
  if (tab?.footnotes && Object.keys(tab.footnotes).length) reasons.add(REASON.footnotes);
  const lists = tab?.lists && typeof tab.lists === 'object' ? tab.lists : {};
  const content = tab?.body?.content;
  const paragraphs: GoogleDocParagraph[] = [];
  if (!Array.isArray(content)) {
    reasons.add(REASON.unreadable);
    return { paragraphs, reasons: [...reasons], lists, revisionId: source?.revisionId };
  }
  const context: ParagraphContext = { mode, lists, named: namedStyleTable(tab), reasons };
  let cursor = 1;
  for (const [index, item] of content.entries()) {
    if (!item || typeof item !== 'object') {
      reasons.add(REASON.unreadable);
      continue;
    }
    if (item.paragraph) {
      const startIndex = Number.isInteger(item.startIndex) ? item.startIndex : cursor;
      const { result, length } = projectParagraph(item.paragraph, startIndex, context);
      if (Number.isInteger(item.endIndex) && item.endIndex !== startIndex + length)
        reasons.add(REASON.unreadable);
      paragraphs.push(result);
      cursor = startIndex + length;
      continue;
    }
    if (item.sectionBreak) {
      // The first section's geometry is kept; a later section boundary is not.
      if (index !== 0 || (item.endIndex ?? 1) !== 1) reasons.add(REASON.sectionBreaks);
    } else if (item.table) reasons.add(REASON.tables);
    else if (item.tableOfContents) reasons.add(REASON.toc);
    else reasons.add(REASON.unreadable);
    if (Number.isInteger(item.endIndex)) cursor = item.endIndex;
  }
  if (!paragraphs.length) reasons.add(REASON.unreadable);
  return { paragraphs, reasons: [...reasons], lists, revisionId: source?.revisionId };
}

/** Only a Doc that reads back without loss may use the semantic editor's writer. */
export function googleFileEditability(
  kind: DocumentKind,
  source?: any,
  mode: GoogleDocMode = 'plain',
): { editable: boolean; reason?: string } {
  // Spreadsheet/deck imports are bounded projections, not lossless provider models.
  if (kind !== 'doc') return { editable: false, reason: GOOGLE_PREVIEW_ONLY };
  const { reasons } = projectGoogleDoc(source, mode);
  return reasons.length ? { editable: false, reason: googlePreviewReason(reasons) } : { editable: true };
}

export function assertGoogleFileEditable(
  kind: DocumentKind,
  source?: unknown,
  mode: GoogleDocMode = 'plain',
) {
  const permission = googleFileEditability(kind, source, mode);
  if (!permission.editable) throw new GoogleDocumentFidelityError(permission.reason);
}
