import type { DeckElementV2, DeckModelV2, DeckSlideV2, DeckTheme } from './model';

/**
 * Reference decks for the presentation design system. Every number is
 * synthetic fixture data; the images are the app's own art fallbacks. Two
 * directions carry the same content so the choice is about design, not copy.
 */

export type DeckDirection = 'editorial' | 'signal';

export const DECK_THEMES: Record<DeckDirection, DeckTheme> = {
  editorial: {
    name: 'Editorial',
    colors: {
      background: '#F4F1EA',
      surface: '#E7E1D3',
      ink: '#1E2A38',
      muted: '#6F6A60',
      accent: '#B5502F',
      accentInk: '#FFFFFF',
    },
    fonts: {
      display: { family: 'Fraunces', exportFamily: 'Georgia', fallback: 'serif' },
      body: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
      mono: { family: 'Geist Mono', exportFamily: 'Consolas', fallback: 'monospace' },
    },
  },
  signal: {
    name: 'Signal',
    colors: {
      background: '#F7F7F4',
      surface: '#E4E6E9',
      ink: '#0B0F14',
      muted: '#5B6470',
      accent: '#2F5BFF',
      accentInk: '#FFFFFF',
    },
    fonts: {
      display: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
      body: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
      mono: { family: 'Geist Mono', exportFamily: 'Consolas', fallback: 'monospace' },
    },
  },
};

const ART = {
  hills: {
    assetId: 'dev-art-1',
    src: '/art/fallback-1.jpg',
    aspect: 600 / 449,
    source: 'Albatross art fallback 1',
  },
  valley: {
    assetId: 'dev-art-3',
    src: '/art/fallback-3.jpg',
    aspect: 599 / 395,
    source: 'Albatross art fallback 3',
  },
};

type Text = Extract<DeckElementV2, { type: 'text' }>;

function text(
  id: string,
  value: string,
  box: [number, number, number, number],
  props: Partial<Omit<Text, 'id' | 'type' | 'text' | 'x' | 'y' | 'width' | 'height'>> = {},
): Text {
  return { id, type: 'text', text: value, x: box[0], y: box[1], width: box[2], height: box[3], ...props };
}

function rule(id: string, x: number, y: number, width: number, color: string, weight = 1.25): DeckElementV2 {
  return { id, type: 'line', x, y, width, height: 0, stroke: { color, width: weight } };
}

function dot(
  id: string,
  cx: number,
  cy: number,
  diameterPt: number,
  fill: string,
  stroke?: string,
): DeckElementV2 {
  const w = (diameterPt / 960) * 100;
  const h = (diameterPt / 540) * 100;
  return {
    id,
    type: 'shape',
    shape: 'ellipse',
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    fill,
    ...(stroke ? { stroke: { color: stroke, width: 1.5 } } : {}),
  };
}

function slide(
  id: string,
  title: string,
  elements: DeckElementV2[],
  extra: Partial<DeckSlideV2> = {},
): DeckSlideV2 {
  return { id, title, elements, ...extra };
}

/** The six-slide baseline: cover, statement, image composition, metrics, process, close. */
export function referenceDeck(direction: DeckDirection): DeckModelV2 {
  const theme = DECK_THEMES[direction];
  const c = theme.colors;
  const editorial = direction === 'editorial';
  const display = editorial ? { fontWeight: 500 } : { fontWeight: 700, letterSpacing: -0.03 };
  const paper = c.background;
  const soft = editorial ? '#C9C1AE' : '#9AA3AE';
  const slides: DeckSlideV2[] = [
    slide('cover', 'The Lakeshore Trail', [
      {
        id: 'cover-image',
        type: 'image',
        x: 52,
        y: 0,
        width: 48,
        height: 100,
        ...ART.valley,
        alt: 'Painted valley with a river and low hills',
        fit: 'cover',
        focal: { x: 0.5, y: 0.55 },
      },
      ...(editorial ? [rule('cover-rule', 6, 9, 5, c.accent, 1.5)] : []),
      ...(editorial
        ? []
        : [
            {
              id: 'cover-chip',
              type: 'shape',
              shape: 'rect',
              x: 6,
              y: 10.5,
              width: 1.2,
              height: 5,
              fill: c.accent,
            } as DeckElementV2,
          ]),
      text('cover-kicker', 'Community update · Autumn 2026', [editorial ? 6 : 9, 11, 40, 4.5], {
        role: 'kicker',
        fontSize: 12,
        color: editorial ? c.accent : c.ink,
        letterSpacing: editorial ? 0.04 : 0,
        fontWeight: editorial ? 500 : 600,
      }),
      text('cover-title', 'The Lakeshore Trail', [6, 24, 42, 40], {
        role: 'title',
        fontSize: editorial ? 68 : 62,
        lineHeight: 0.96,
        valign: 'top',
        ...display,
      }),
      text(
        'cover-sub',
        'A community update on the twelve-mile path from Fairhaven to Millbrook.',
        [6, 66, 38, 12],
        { role: 'subtitle', fontSize: 17, color: c.muted, lineHeight: 1.35, valign: 'top' },
      ),
      text('cover-foot', 'Prepared for the Parks Board', [6, 90, 40, 4], {
        role: 'caption',
        fontSize: 11,
        color: c.muted,
        valign: 'bottom',
      }),
    ]),
    slide(
      'statement',
      'Twelve miles, four towns, one path',
      [
        ...(editorial ? [rule('st-rule', 8, 17, 5, c.accent, 1.5)] : []),
        text('st-title', 'Twelve miles, four towns, one continuous path by 2028.', [8, 22, 76, 46], {
          role: 'title',
          fontSize: editorial ? 56 : 58,
          lineHeight: 1.02,
          color: editorial ? paper : c.accentInk,
          valign: 'top',
          ...display,
        }),
        text(
          'st-body',
          'Seven of the twelve miles are open today. The rest follows the old rail bed, which the county deeded to the trust in June.',
          [8, 74, 56, 14],
          { role: 'body', fontSize: 16, color: editorial ? soft : '#DCE3FF', lineHeight: 1.4, valign: 'top' },
        ),
        text('st-num', '02', [86, 90, 8, 4], {
          role: 'caption',
          fontSize: 11,
          color: editorial ? soft : '#DCE3FF',
          align: 'right',
          valign: 'bottom',
          font: 'mono',
        }),
      ],
      { background: editorial ? c.ink : c.accent },
    ),
    slide('image', 'Phase two follows the old rail bed', [
      {
        id: 'img-art',
        type: 'image',
        x: 0,
        y: 0,
        width: 46,
        height: 100,
        ...ART.hills,
        alt: 'Pastel landscape with green hills and a winding road',
        fit: 'cover',
        focal: { x: 0.45, y: 0.5 },
      },
      text('img-kicker', 'Phase two', [52, 12, 40, 4.5], {
        role: 'kicker',
        fontSize: 12,
        color: c.accent,
        fontWeight: editorial ? 500 : 600,
        letterSpacing: editorial ? 0.04 : 0,
      }),
      text('img-title', 'Phase two follows the old rail bed', [52, 18, 42, 24], {
        role: 'title',
        fontSize: 38,
        lineHeight: 1.02,
        valign: 'top',
        ...display,
      }),
      text(
        'img-body',
        'The rail bed gives us a grade under three percent for the whole segment, so the path stays accessible without switchbacks. Grading started in May and the crew reached the Millbrook trestle in August.',
        [52, 44, 40, 24],
        { role: 'body', fontSize: 15, lineHeight: 1.5, valign: 'top' },
      ),
      ...(editorial ? [rule('img-rule', 52, 72, 42, soft, 1)] : []),
      text('img-f1', '4.6 mi', [52, 75, 13, 8], { role: 'number', fontSize: 24, ...display, color: c.ink }),
      text('img-f1c', 'graded this year', [52, 83, 13, 5], {
        role: 'caption',
        fontSize: 11,
        color: c.muted,
        valign: 'top',
      }),
      text('img-f2', '3', [67, 75, 13, 8], { role: 'number', fontSize: 24, ...display, color: c.ink }),
      text('img-f2c', 'bridges rebuilt', [67, 83, 13, 5], {
        role: 'caption',
        fontSize: 11,
        color: c.muted,
        valign: 'top',
      }),
      text('img-f3', 'May 2027', [82, 75, 13, 8], { role: 'number', fontSize: 24, ...display, color: c.ink }),
      text('img-f3c', 'segment opens', [82, 83, 13, 5], {
        role: 'caption',
        fontSize: 11,
        color: c.muted,
        valign: 'top',
      }),
    ]),
    slide('metrics', 'Where the money went', [
      text('m-kicker', 'Where the money went', [6, 10, 40, 4.5], {
        role: 'kicker',
        fontSize: 12,
        color: c.accent,
        fontWeight: editorial ? 500 : 600,
        letterSpacing: editorial ? 0.04 : 0,
      }),
      text('m-title', 'Most of what we raised is already at work on the ground.', [6, 16, 52, 18], {
        role: 'title',
        fontSize: 32,
        lineHeight: 1.06,
        valign: 'top',
        ...display,
      }),
      text('m-n1', '$2.4M', [6, 40, 26, 12], {
        role: 'number',
        fontSize: editorial ? 52 : 56,
        color: c.accent,
        ...display,
        valign: 'bottom',
      }),
      text('m-n1c', 'raised since the 2024 campaign', [6, 52, 26, 5], {
        role: 'caption',
        fontSize: 12,
        color: c.muted,
        valign: 'top',
      }),
      text('m-n2', '68%', [6, 60, 26, 12], {
        role: 'number',
        fontSize: editorial ? 52 : 56,
        ...display,
        valign: 'bottom',
      }),
      text('m-n2c', 'of the budget committed to contracts', [6, 72, 26, 5], {
        role: 'caption',
        fontSize: 12,
        color: c.muted,
        valign: 'top',
      }),
      text('m-n3', '1,900', [6, 80, 26, 12], {
        role: 'number',
        fontSize: editorial ? 52 : 56,
        ...display,
        valign: 'bottom',
      }),
      text('m-n3c', 'volunteer hours logged', [6, 92, 26, 5], {
        role: 'caption',
        fontSize: 12,
        color: c.muted,
        valign: 'top',
      }),
      {
        id: 'm-chart',
        type: 'chart',
        chart: 'column',
        x: 40,
        y: 38,
        width: 54,
        height: 50,
        categories: ['Q1', 'Q2', 'Q3', 'Q4 plan'],
        series: [{ name: 'Spend', values: [180, 240, 310, 420] }],
        colors: [c.accent],
        values: true,
        legend: false,
        unit: 'k',
        source: "Treasurer's report, September 2026 (fixture data)",
      },
      text(
        'm-src',
        "Spend by quarter, thousands. Source: treasurer's report, September 2026. Fixture data.",
        [40, 90, 54, 5],
        {
          role: 'caption',
          fontSize: 10.5,
          color: c.muted,
          valign: 'top',
        },
      ),
    ]),
    slide('process', 'Four steps to opening day', [
      text('p-kicker', 'How we get to opening day', [6, 10, 40, 4.5], {
        role: 'kicker',
        fontSize: 12,
        color: c.accent,
        fontWeight: editorial ? 500 : 600,
        letterSpacing: editorial ? 0.04 : 0,
      }),
      text('p-title', 'Four steps between now and the ribbon.', [6, 16, 60, 16], {
        role: 'title',
        fontSize: 34,
        lineHeight: 1.04,
        valign: 'top',
        ...display,
      }),
      ...(editorial
        ? [rule('p-line', 6, 56, 88, c.ink, 1.25)]
        : [
            {
              id: 'p-track',
              type: 'shape',
              shape: 'roundRect',
              x: 6,
              y: 55,
              width: 88,
              height: 2,
              fill: c.surface,
              radius: 6,
            } as DeckElementV2,
          ]),
      ...[
        ['Survey', 'October 2026', 'Wetland and drainage survey along the last five miles.'],
        ['Permits', 'January 2027', 'County and state review; hearings in Fairhaven and Millbrook.'],
        ['Grading', 'March 2027', 'Crews return once the ground thaws; trestle decking first.'],
        ['Opening', 'May 2027', 'Ribbon at the Millbrook trailhead with all four towns.'],
      ].flatMap(([step, date, detail], index) => {
        const x = 6 + index * 22.4;
        return [
          dot(
            `p-dot-${index}`,
            x + 1.5,
            56,
            editorial ? 14 : 18,
            editorial ? paper : c.accent,
            editorial ? c.ink : undefined,
          ),
          text(`p-n-${index}`, `0${index + 1}`, [x, 36, 20, 5], {
            role: 'caption',
            fontSize: 11,
            color: c.accent,
            font: 'mono',
            valign: 'bottom',
          }),
          text(`p-s-${index}`, step, [x, 41, 20, 10], {
            role: 'subtitle',
            fontSize: 22,
            valign: 'top',
            ...display,
          }),
          text(`p-d-${index}`, date, [x, 62, 20, 5], {
            role: 'caption',
            fontSize: 12,
            color: c.muted,
            valign: 'top',
          }),
          text(`p-t-${index}`, detail, [x, 67, 19.5, 20], {
            role: 'body',
            fontSize: 13.5,
            lineHeight: 1.4,
            valign: 'top',
          }),
        ];
      }),
    ]),
    slide(
      'close',
      'What we ask of the board',
      [
        text('c-title', 'What we ask of the board', [6, 14, 60, 18], {
          role: 'title',
          fontSize: 44,
          lineHeight: 1.02,
          valign: 'top',
          color: editorial ? c.ink : paper,
          ...display,
        }),
        ...[
          [
            'Approve the phase two budget',
            'Two hundred forty thousand for grading and the trestle, drawn from the reserve.',
          ],
          [
            'Name a liaison for Millbrook',
            'One board member to attend the January permit hearing with staff.',
          ],
          ['Set the opening date', 'A firm May date lets the four towns plan the ribbon together.'],
        ].flatMap(([ask, detail], index) => {
          const x = 6 + index * 30;
          return [
            text(`c-n-${index}`, String(index + 1), [x, 44, 8, 12], {
              role: 'number',
              fontSize: 44,
              color: c.accent,
              valign: 'top',
              ...display,
            }),
            text(`c-a-${index}`, ask, [x, 58, 26, 12], {
              role: 'subtitle',
              fontSize: 20,
              lineHeight: 1.15,
              valign: 'top',
              color: editorial ? c.ink : paper,
              ...display,
            }),
            text(`c-d-${index}`, detail, [x, 71, 25, 16], {
              role: 'body',
              fontSize: 13.5,
              lineHeight: 1.4,
              valign: 'top',
              color: editorial ? c.muted : '#B6BEC9',
            }),
          ];
        }),
        rule('c-rule', 6, 90, 88, editorial ? soft : '#2A3140', 1),
        text('c-foot', 'Questions: trail@lakeshore.org · Next review in January', [6, 92, 60, 5], {
          role: 'caption',
          fontSize: 11,
          color: editorial ? c.muted : '#B6BEC9',
          valign: 'top',
        }),
      ],
      { background: editorial ? c.background : c.ink },
    ),
  ];
  return { kind: 'deck', version: 2, activeSlideId: slides[0].id, theme, slides };
}

/** A second, unrelated deck to show the system generalizes: a hiring plan in three slides. */
export function hiringDeck(direction: DeckDirection = 'editorial'): DeckModelV2 {
  const theme = DECK_THEMES[direction];
  const c = theme.colors;
  const editorial = direction === 'editorial';
  const display = editorial ? { fontWeight: 500 } : { fontWeight: 700, letterSpacing: -0.03 };
  const slides: DeckSlideV2[] = [
    slide('h-cover', 'Six hires by June', [
      text('h-kicker', 'Hiring plan · Spring 2027', [8, 12, 40, 4.5], {
        role: 'kicker',
        fontSize: 12,
        color: c.accent,
        fontWeight: editorial ? 500 : 600,
        letterSpacing: editorial ? 0.04 : 0,
      }),
      text('h-big', '6', [8, 22, 30, 44], {
        role: 'number',
        fontSize: 220,
        lineHeight: 0.9,
        color: c.accent,
        valign: 'top',
        ...display,
      }),
      text('h-title', 'hires by June, without moving the burn rate.', [40, 30, 52, 32], {
        role: 'title',
        fontSize: 44,
        lineHeight: 1.02,
        valign: 'top',
        ...display,
      }),
      text(
        'h-sub',
        'Three engineers, two in support, one operations lead. Offers go out in waves of two.',
        [40, 64, 48, 12],
        { role: 'subtitle', fontSize: 16, color: c.muted, lineHeight: 1.4, valign: 'top' },
      ),
    ]),
    slide('h-compare', 'Now and in June', [
      text('cmp-title', 'What changes between now and June', [6, 12, 70, 12], {
        role: 'title',
        fontSize: 34,
        lineHeight: 1.04,
        valign: 'top',
        ...display,
      }),
      {
        id: 'cmp-left',
        type: 'shape',
        shape: editorial ? 'rect' : 'roundRect',
        x: 6,
        y: 30,
        width: 42,
        height: 58,
        fill: c.surface,
        radius: 10,
      },
      {
        id: 'cmp-right',
        type: 'shape',
        shape: editorial ? 'rect' : 'roundRect',
        x: 52,
        y: 30,
        width: 42,
        height: 58,
        fill: c.accent,
        radius: 10,
      },
      text('cmp-l-h', 'Today', [9, 34, 36, 6], {
        role: 'subtitle',
        fontSize: 14,
        color: c.muted,
        valign: 'top',
      }),
      text('cmp-l-1', '11 people', [9, 41, 36, 8], {
        role: 'subtitle',
        fontSize: 24,
        valign: 'top',
        ...display,
      }),
      text(
        'cmp-l-2',
        'Support answers in nine hours on average. Engineering ships one release a month.',
        [9, 52, 36, 20],
        { role: 'body', fontSize: 14, lineHeight: 1.45, valign: 'top' },
      ),
      text('cmp-r-h', 'June', [55, 34, 36, 6], {
        role: 'subtitle',
        fontSize: 14,
        color: '#E6ECFF',
        valign: 'top',
      }),
      text('cmp-r-1', '17 people', [55, 41, 36, 8], {
        role: 'subtitle',
        fontSize: 24,
        color: c.accentInk,
        valign: 'top',
        ...display,
      }),
      text(
        'cmp-r-2',
        'Support answers in two hours. Engineering ships every two weeks with a release owner.',
        [55, 52, 36, 20],
        { role: 'body', fontSize: 14, lineHeight: 1.45, color: c.accentInk, valign: 'top' },
      ),
    ]),
    slide('h-chart', 'Headcount by team in June', [
      text('hc-title', 'Headcount by team in June', [6, 12, 50, 12], {
        role: 'title',
        fontSize: 34,
        lineHeight: 1.04,
        valign: 'top',
        ...display,
      }),
      text(
        'hc-body',
        'Engineering stays the largest team. Support doubles, which is where response time comes from.',
        [6, 28, 36, 24],
        { role: 'body', fontSize: 15, lineHeight: 1.5, valign: 'top', color: c.muted },
      ),
      {
        id: 'hc-chart',
        type: 'chart',
        chart: 'doughnut',
        x: 50,
        y: 20,
        width: 44,
        height: 70,
        categories: ['Engineering', 'Support', 'Operations', 'Leadership'],
        series: [{ name: 'People', values: [8, 4, 3, 2] }],
        colors: [c.accent, c.ink, c.muted, '#C9C1AE'],
        legend: true,
        source: 'Fixture data',
      },
      text('hc-src', 'Seventeen people in total. Fixture data.', [6, 88, 40, 5], {
        role: 'caption',
        fontSize: 11,
        color: c.muted,
        valign: 'top',
      }),
    ]),
  ];
  return { kind: 'deck', version: 2, activeSlideId: slides[0].id, theme, slides };
}
