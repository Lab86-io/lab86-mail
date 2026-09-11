import { z } from 'zod';
import type { DeckElement } from './model';

// Content and art direction are generated together; geometry is deterministic
// so long prose cannot turn into overlapping, unstyled boxes.
export const presentationBriefSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  palette: z.enum(['ink', 'forest', 'clay']),
  slides: z
    .array(
      z.object({
        layout: z.enum(['cover', 'statement', 'metrics', 'columns', 'timeline']),
        title: z.string().min(1).max(90),
        kicker: z.string().max(40),
        body: z.string().max(240),
        items: z
          .array(
            z.object({
              label: z.string().min(1).max(50),
              detail: z.string().max(150),
            }),
          )
          .max(3),
        notes: z.string().max(4000),
      }),
    )
    .min(1)
    .max(30),
});
export type PresentationBrief = z.infer<typeof presentationBriefSchema>;
const palettes = {
  ink: {
    dark: '#182C40',
    paper: '#F5F2EA',
    accent: '#B6533A',
    muted: '#536170',
    panel: '#E7E3D9',
    soft: '#CAD3DB',
  },
  forest: {
    dark: '#183C32',
    paper: '#F3F3E9',
    accent: '#856019',
    muted: '#52665B',
    panel: '#E2E6D8',
    soft: '#CBD9CD',
  },
  clay: {
    dark: '#492E37',
    paper: '#FAF1E8',
    accent: '#A34731',
    muted: '#75605B',
    panel: '#EFDFD3',
    soft: '#E2CBC8',
  },
};

export function composePresentation(brief: PresentationBrief) {
  const colors = palettes[brief.palette];
  const slides = brief.slides.map((source, index) => {
    const id = `slide-${index + 1}`;
    const dark = source.layout === 'cover' || source.layout === 'statement';
    const foreground = dark ? colors.paper : colors.dark;
    const muted = dark ? colors.soft : colors.muted;
    const elements: DeckElement[] = [];
    const text = (
      value: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
      role: DeckElement['role'] = 'body',
      color = foreground,
    ) => {
      if (value.trim())
        elements.push({
          id: `${id}-e${elements.length}`,
          type: 'text',
          text: value,
          x,
          y,
          width,
          height,
          fontSize,
          role,
          color,
        });
    };
    const shape = (x: number, y: number, width: number, height: number, fill: string) =>
      elements.push({
        id: `${id}-e${elements.length}`,
        type: 'shape',
        role: 'shape',
        x,
        y,
        width,
        height,
        fill,
        color: fill,
      });
    shape(6, 8, 5, 1, dark ? colors.soft : colors.accent);
    text(source.kicker, 6, 11, 88, 6, 12, 'caption', muted);
    text(
      `${String(index + 1).padStart(2, '0')} / ${String(brief.slides.length).padStart(2, '0')}`,
      85,
      91,
      9,
      4,
      10,
      'caption',
      muted,
    );
    if (dark) {
      text(source.title, 6, 26, 85, 31, source.title.length > 60 ? 38 : 46, 'title');
      text(source.body, 6, 62, 76, 20, 20, 'subtitle', muted);
    } else {
      text(source.title, 6, 21, 88, 18, source.title.length > 65 ? 28 : 34, 'title');
      text(source.body, 6, 40, 88, 12, 17, 'subtitle', muted);
    }
    // Cover/statement copy belongs in notes, not hidden in unrendered items.
    if (!dark && source.items.length) {
      const count = source.items.length;
      const width = (88 - (count - 1) * 3) / count;
      source.items.forEach((item, itemIndex) => {
        const x = 6 + itemIndex * (width + 3);
        shape(x, 57, width, 29, colors.panel);
        if (source.layout === 'timeline')
          text(String(itemIndex + 1).padStart(2, '0'), x + 2, 59, width - 4, 5, 12, 'caption', colors.accent);
        text(
          item.label,
          x + 2,
          source.layout === 'timeline' ? 65 : 60,
          width - 4,
          10,
          source.layout === 'metrics' && item.label.length <= 12 ? 32 : 19,
          'title',
          colors.accent,
        );
        text(item.detail, x + 2, 73, width - 4, 11, 13, 'body', colors.muted);
      });
    }
    return {
      id,
      title: source.title,
      background: dark ? colors.dark : colors.paper,
      notes: [source.notes, ...(dark ? source.items.map((item) => `${item.label}: ${item.detail}`) : [])]
        .filter(Boolean)
        .join('\n'),
      elements,
    };
  });
  return { kind: 'deck' as const, version: 1 as const, activeSlideId: slides[0].id, slides };
}

export const PRESENTATION_DESIGN_GUIDANCE = `Design a complete presentation as 16:9 slides. Return finished slide copy, not instructions to create it.
Choose one coherent palette: ink (navy, cream, rust), forest (green, cream, ochre), or clay (plum, ivory, terracotta), matching the user's direction.
Build a narrative: an evocative cover, evidence and outcomes, then a clear takeaway. Vary layouts: cover/statement use a large headline and body; metrics/columns/timeline use up to three label/detail items. Use at least three different layouts for decks of five or more slides. Use metrics for verified numbers, columns for comparisons, timeline for ordered steps. Never invent statistics to fill a layout.
Respect the requested slide count. Write short headlines, concise labels, and supporting details that fit their bounds. Put source attribution, nuances, exact dates/timezones, and fuller explanation in speaker notes. Each slide must contain actual content, never placeholders or a restatement of the user's request. Only attribute events to a date when source timestamps in the user's timezone support it.`;

/** Honor an explicit slide count even when a provider returns a valid but incomplete outline. */
export interface PresentationSlideConstraints {
  min: number;
  max: number;
  exact?: number;
}

/** Interpret bounded requests without turning their endpoints into exact counts. */
export function requestedPresentationSlideConstraints(
  instruction: string,
): PresentationSlideConstraints | undefined {
  const words = [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  const number = '(\\d{1,2}|' + words.join('|') + ')';
  const pattern = new RegExp(
    '\\b(?:(up to|at most|no more than|at least|no fewer than|more than|less than|fewer than|exactly|between)\\s+)?' +
      number +
      '(?:\\s*(?:[-–—]|to|and)\\s*' +
      number +
      ')?[ -]+slides?\\b',
    'g',
  );
  const matches = [...instruction.toLowerCase().matchAll(pattern)];
  if (!matches.length) return undefined;
  let min = 1,
    max = 30;
  for (const match of matches) {
    const value = (raw: string) => Number(raw) || words.indexOf(raw) + 1;
    const count = value(match[2]);
    if (count < 1 || count > 30) continue;
    if (match[3]) {
      min = count;
      max = value(match[3]);
    } else if (['up to', 'at most', 'no more than'].includes(match[1])) max = count;
    else if (['at least', 'no fewer than'].includes(match[1])) min = count;
    else if (match[1] === 'more than') min = count + 1;
    else if (['less than', 'fewer than'].includes(match[1])) max = count - 1;
    else {
      min = count;
      max = count;
    }
  }
  return { min, max, ...(min === max ? { exact: min } : {}) };
}

export function requestedPresentationSlideCount(instruction: string) {
  return requestedPresentationSlideConstraints(instruction)?.exact;
}

export function presentationSlideCountMatches(instruction: string, count: number) {
  const constraint = requestedPresentationSlideConstraints(instruction);
  return !constraint || (count >= constraint.min && count <= constraint.max);
}
