// House style for the Word templates. One type scale, one ink, one restrained accent.
// The templates own every font, size, color, rule, and space; the model sends
// data only. Sizes are half-points; lengths are twips (1/1440 inch).

import { randomUUID } from 'node:crypto';
import {
  AlignmentType,
  BorderStyle,
  LevelFormat,
  Paragraph,
  ShadingType,
  Tab,
  TableCell,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

export const INK = '1F1D1A';
export const MUTED = '6B665D';
export const RULE = 'D9D3C7';
/**
 * The one accent: the app accent, oklch(0.45 0.09 156) in app/globals.css, as sRGB.
 * Only the invoice total rule and the blank underline use it. The page stays white.
 */
export const ACCENT = '216440';
export const SERIF = 'Fraunces Display';
export const SANS = 'Geist';

export const SIZE = {
  title: 64,
  total: 36,
  heading: 30,
  lead: 24,
  body: 19,
  note: 17,
  small: 16,
  footer: 15,
} as const;

/** US Letter with 0.8 inch margins. */
export const PAGE = { width: 12240, height: 15840, margin: 1152 } as const;
export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;

export const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
export const NO_TABLE_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
  insideHorizontal: NO_BORDER,
  insideVertical: NO_BORDER,
} as const;
export const hairline = (color: string = RULE, size = 4) => ({ style: BorderStyle.SINGLE, size, color });

export interface RunStyle {
  size?: number;
  color?: string;
  font?: string;
  bold?: boolean;
}

export type Align = (typeof AlignmentType)[keyof typeof AlignmentType];

export interface ParagraphStyle {
  align?: Align;
  before?: number;
  after?: number;
  keepNext?: boolean;
  style?: string;
  tabRight?: boolean;
  indent?: { left: number; hanging?: number };
  numbering?: { reference: string; level: number };
  /** A rule under the paragraph, in ink. */
  ruleBelow?: boolean;
  line?: number;
}

export const BULLET_REFERENCE = 'house-bullet';

/** A field that the user must still fill. It becomes a Word content control. */
export interface BlankSpec {
  /** The name the user and the model see, for example "Invoice number". */
  label: string;
  slug: string;
  multiLine: boolean;
}

export const BLANK_TAG_PREFIX = 'blank:';

/** A stable short id for a blank label: "Invoice number" -> "invoice-number". */
export function blankSlug(label: string): string {
  return (
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'blank'
  );
}

// XML 1.0 does not allow most control characters. Remove them from all data.
function xmlSafe(value: string) {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const allowed =
      code >= 0x20 ? code !== 0xfffe && code !== 0xffff : code === 0x9 || code === 0xa || code === 0xd;
    if (allowed) out += character;
  }
  return out;
}
export function cleanText(value: unknown): string {
  return typeof value === 'string' ? xmlSafe(value).replace(/\r\n?/g, '\n').trim() : '';
}

/**
 * Collects the runs of one rendered template. A blank or a page field is first
 * a plain marker run; `finalizeTemplatePackage` replaces each marker with the
 * real XML (a content control, or the field runs) after docx packs the file.
 * The nonce makes a marker impossible to type by chance.
 */
export class TemplateCanvas {
  readonly nonce = randomUUID().replace(/-/g, '').slice(0, 12);
  readonly blanks: BlankSpec[] = [];

  run(text: string, style: RunStyle = {}) {
    return new TextRun({
      text,
      font: style.font ?? SANS,
      size: style.size ?? SIZE.body,
      color: style.color ?? INK,
      bold: style.bold,
    });
  }

  /** Text with line breaks: each line after the first starts with a break. */
  lines(text: string, style: RunStyle = {}) {
    return text.split('\n').map(
      (line, index) =>
        new TextRun({
          text: line,
          break: index ? 1 : undefined,
          font: style.font ?? SANS,
          size: style.size ?? SIZE.body,
          color: style.color ?? INK,
          bold: style.bold,
        }),
    );
  }

  /**
   * The value when there is one, else a blank with this label. Two blanks
   * with the same label are one field: filling it fills both places.
   */
  value(
    value: unknown,
    label: string,
    style: RunStyle = {},
    options: { multiLine?: boolean; display?: (text: string) => string } = {},
  ) {
    const text = cleanText(value);
    if (text) return this.lines(options.display ? options.display(text) : text, style);
    return [this.blank(label, style, options.multiLine)];
  }

  blank(label: string, style: RunStyle = {}, multiLine = false) {
    const name = cleanText(label).replace(/\s+/g, ' ').slice(0, 40).trim() || 'Blank';
    const slug = blankSlug(name);
    let index = this.blanks.findIndex((blank) => blank.slug === slug);
    if (index < 0) index = this.blanks.push({ label: name, slug, multiLine }) - 1;
    return new TextRun({
      text: this.marker('blank', String(index)),
      font: style.font ?? SANS,
      size: style.size ?? SIZE.body,
      color: style.color ?? INK,
      bold: style.bold,
    });
  }

  /** A PAGE or NUMPAGES field. Each field run keeps this size (a LibreOffice fix). */
  pageField(field: 'PAGE' | 'NUMPAGES', style: RunStyle = {}) {
    return new TextRun({
      text: this.marker('field', field),
      font: style.font ?? SANS,
      size: style.size ?? SIZE.footer,
      color: style.color ?? MUTED,
    });
  }

  marker(kind: 'blank' | 'field', value: string) {
    return `[[lab86-${this.nonce}-${kind}-${value}]]`;
  }

  markerPattern() {
    return new RegExp(`^\\[\\[lab86-${this.nonce}-(blank|field)-([A-Z0-9]+)\\]\\]$`);
  }

  paragraph(children: TextRun[], style: ParagraphStyle = {}) {
    return new Paragraph({
      children,
      alignment: style.align,
      style: style.style,
      keepNext: style.keepNext,
      indent: style.indent,
      numbering: style.numbering,
      border: style.ruleBelow
        ? { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK, space: 8 } }
        : undefined,
      spacing: { before: style.before ?? 0, after: style.after ?? 0, line: style.line ?? 264 },
      tabStops: style.tabRight ? [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }] : undefined,
    });
  }

  /** A small muted label above a value. Sentence case, never all capitals. */
  label(text: string, after = 60) {
    return this.paragraph([this.run(text, { size: SIZE.small, color: MUTED })], { after });
  }

  /**
   * Body text. A paragraph that starts with "- " or "* " is a bullet. A line
   * break inside a paragraph stays a line break.
   */
  body(paragraphs: readonly string[], style: RunStyle = {}, after = 160) {
    const items = paragraphs
      .map((value) => cleanText(value))
      .filter(Boolean)
      .map((text) => ({ text, bullet: /^[-*\u2022]\s+/.exec(text)?.[0] }));
    return items.map(({ text, bullet }, index) =>
      this.paragraph(this.lines(bullet ? text.slice(bullet.length) : text, style), {
        // Bullets sit close together; the last bullet of a list gets the paragraph space.
        after: bullet && items[index + 1]?.bullet ? 80 : after,
        line: 276,
        ...(bullet ? { numbering: { reference: BULLET_REFERENCE, level: 0 } } : {}),
      }),
    );
  }

  spacer(after: number) {
    return this.paragraph([this.run('')], { after });
  }

  /** The footer line: text on the left, "Page N of M" on the right. */
  footer(text: string) {
    const style = { size: SIZE.footer, color: MUTED };
    return this.paragraph(
      [
        this.run(text, style),
        new TextRun({ children: [new Tab(), 'Page '], font: SANS, size: SIZE.footer, color: MUTED }),
        this.pageField('PAGE', style),
        this.run(' of ', style),
        this.pageField('NUMPAGES', style),
      ],
      { tabRight: true, style: 'Footer' },
    );
  }
}

export function cell(
  children: Paragraph[],
  width: number,
  options: { borders?: object; top?: number; bottom?: number; shade?: string } = {},
) {
  return new TableCell({
    children,
    width: { size: Math.round(width), type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    borders: {
      top: NO_BORDER,
      bottom: NO_BORDER,
      left: NO_BORDER,
      right: NO_BORDER,
      ...(options.borders ?? {}),
    },
    margins: { top: options.top ?? 0, bottom: options.bottom ?? 0, left: 0, right: 0 },
    shading: options.shade ? { type: ShadingType.CLEAR, fill: options.shade, color: 'auto' } : undefined,
  });
}

/** The bullet list of the body text: a muted dot, hanging indent. */
export function houseNumbering() {
  return {
    config: [
      {
        reference: BULLET_REFERENCE,
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: { indent: { left: 300, hanging: 220 } },
              run: { font: SANS, color: MUTED },
            },
          },
        ],
      },
    ],
  };
}

/** The document styles every template shares: Geist body text, a muted footer. */
export function houseStyles() {
  return {
    default: {
      document: { run: { font: SANS, size: SIZE.body, color: INK } },
    },
    paragraphStyles: [
      {
        id: 'Footer',
        name: 'Footer',
        run: { font: SANS, size: SIZE.footer, color: MUTED },
      },
      {
        id: 'Heading',
        name: 'Heading',
        basedOn: 'Normal',
        run: { font: SERIF, size: SIZE.heading, color: INK },
      },
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: SERIF, size: SIZE.heading, color: INK },
        paragraph: { spacing: { before: 360, after: 120 }, keepNext: true },
      },
    ],
  };
}

export const pageProperties = (titlePage = false) => ({
  titlePage,
  page: {
    size: { width: PAGE.width, height: PAGE.height },
    margin: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin, footer: 576 },
  },
});

/** Dates: "2026-10-15" becomes "October 15, 2026". Other text stays as written. */
export function displayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match[3])) return value;
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
