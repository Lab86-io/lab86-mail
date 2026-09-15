'use client';

import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent, Ref } from 'react';
import { deckFontStack, deckTextSlot } from '@/lib/documents/deck-versions';
import type { DeckElementV2, DeckSlideV2, DeckTheme } from '@/lib/documents/model';
import { fontSizeForCanvas, pointsForCanvas, slideColor } from './deck-model';

/**
 * The one renderer for a slide: editor canvas, filmstrip thumbnail,
 * presentation mode and the dev preview all draw through here, so what is
 * reviewed is what ships. Slide colors and fonts come from the deck theme,
 * never from the application theme; dark mode does not touch a slide.
 */

export function deckThemeStyle(theme: DeckTheme): CSSProperties {
  return {
    '--deck-display': deckFontStack(theme, 'display'),
    '--deck-body': deckFontStack(theme, 'body'),
    '--deck-mono': deckFontStack(theme, 'mono'),
    '--deck-bg': slideColor(theme.colors.background, '#FFFFFF'),
    '--deck-surface': slideColor(theme.colors.surface, '#DCE6F2'),
    '--deck-ink': slideColor(theme.colors.ink, '#17202A'),
    '--deck-muted': slideColor(theme.colors.muted, '#94A3B8'),
    '--deck-accent': slideColor(theme.colors.accent, '#17202A'),
    '--deck-accent-ink': slideColor(theme.colors.accentInk, '#FFFFFF'),
  } as CSSProperties;
}

/** Default type size by role; the export uses the same table. */
export function textSizeFor(element: Extract<DeckElementV2, { type: 'text' }>) {
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

function boxStyle(element: DeckElementV2): CSSProperties {
  return {
    left: `${element.x}%`,
    top: `${element.y}%`,
    width: `${element.width}%`,
    height: `${element.height}%`,
    ...(element.rotation ? { transform: `rotate(${element.rotation}deg)` } : {}),
    ...(element.opacity !== undefined ? { opacity: element.opacity } : {}),
  };
}

export function elementStyle(element: DeckElementV2): CSSProperties {
  const base = boxStyle(element);
  if (element.type === 'text') {
    const slot = deckTextSlot(element);
    const weight = element.fontWeight ?? (element.role === 'title' || element.role === 'number' ? 650 : 400);
    return {
      ...base,
      fontFamily: `var(--deck-${slot})`,
      fontSize: fontSizeForCanvas(textSizeFor(element)),
      fontWeight: weight,
      fontStyle: element.italic ? 'italic' : 'normal',
      lineHeight: element.lineHeight ?? (slot === 'display' ? 1.05 : 1.3),
      letterSpacing: element.letterSpacing !== undefined ? `${element.letterSpacing}em` : undefined,
      textAlign: element.align ?? 'left',
      color: element.color ? slideColor(element.color, 'var(--deck-ink)') : 'var(--deck-ink)',
      backgroundColor: element.fill ? slideColor(element.fill, 'transparent') : undefined,
      display: 'flex',
      flexDirection: 'column',
      justifyContent:
        element.valign === 'top' ? 'flex-start' : element.valign === 'bottom' ? 'flex-end' : 'center',
    };
  }
  if (element.type === 'shape') {
    return {
      ...base,
      backgroundColor: element.fill ? slideColor(element.fill, 'var(--deck-surface)') : 'var(--deck-surface)',
      border: element.stroke
        ? `${pointsForCanvas(element.stroke.width)} ${element.stroke.dash === 'dash' ? 'dashed' : element.stroke.dash === 'dot' ? 'dotted' : 'solid'} ${slideColor(element.stroke.color, '#94A3B8')}`
        : undefined,
      borderRadius:
        element.shape === 'ellipse'
          ? '50%'
          : element.shape === 'roundRect'
            ? pointsForCanvas(element.radius ?? 12)
            : undefined,
    };
  }
  if (element.type === 'image') {
    return {
      ...base,
      borderRadius: element.radius ? pointsForCanvas(element.radius) : undefined,
      overflow: 'hidden',
    };
  }
  return base;
}

/**
 * A line fills its box corner to corner. A flat box (height 0) or an upright
 * box (width 0) has no area, so the SVG for those is positioned around the
 * box edge with the stroke's own thickness; otherwise nothing would paint.
 */
function LineArt({ element }: { element: Extract<DeckElementV2, { type: 'line' }> }) {
  const flat = element.height === 0;
  const upright = element.width === 0;
  const strokeWidth = pointsForCanvas(element.stroke.width);
  const dashPattern =
    element.stroke.dash === 'dash' ? [3, 2] : element.stroke.dash === 'dot' ? [1, 1.5] : undefined;
  const lineProps = {
    stroke: slideColor(element.stroke.color, '#17202A'),
    strokeLinecap: 'butt' as const,
    vectorEffect: 'non-scaling-stroke' as const,
    style: {
      strokeWidth,
      ...(dashPattern
        ? {
            strokeDasharray: dashPattern
              .map((unit) => pointsForCanvas(unit * element.stroke.width))
              .join(' '),
          }
        : {}),
    },
  };
  if (flat || upright) {
    const style: CSSProperties = flat
      ? {
          position: 'absolute',
          left: 0,
          width: '100%',
          top: `calc(${strokeWidth} / -2)`,
          height: strokeWidth,
          minHeight: '1px',
          overflow: 'visible',
        }
      : {
          position: 'absolute',
          top: 0,
          height: '100%',
          left: `calc(${strokeWidth} / -2)`,
          width: strokeWidth,
          minWidth: '1px',
          overflow: 'visible',
        };
    return (
      <svg className="deck-line" data-line={flat ? 'flat' : 'upright'} aria-hidden="true" style={style}>
        <line
          x1={flat ? '0' : '50%'}
          y1={flat ? '50%' : '0'}
          x2={flat ? '100%' : '50%'}
          y2={flat ? '50%' : '100%'}
          {...lineProps}
        />
      </svg>
    );
  }
  return (
    <svg
      className="deck-line"
      data-line="diagonal"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ overflow: 'visible' }}
    >
      <line x1={0} y1={element.flip ? 100 : 0} x2={100} y2={element.flip ? 0 : 100} {...lineProps} />
    </svg>
  );
}

const CHART_PALETTE_FALLBACK = [
  'var(--deck-accent)',
  'var(--deck-ink)',
  'var(--deck-muted)',
  'var(--deck-surface)',
];

/** Charts draw in SVG from grounded data, with the same palette the export uses. */
function ChartArt({ element }: { element: Extract<DeckElementV2, { type: 'chart' }> }) {
  const colors = element.colors?.length
    ? element.colors.map((color) => slideColor(color, '#17202A'))
    : CHART_PALETTE_FALLBACK;
  const width = 400;
  const height = Math.max(120, 400 * (element.height / Math.max(1, element.width)) * (9 / 16));
  const labelSize = 9;
  const showLegend = element.legend ?? element.series.length > 1;
  const legendHeight = showLegend ? 14 : 0;
  const unit = element.unit ?? '';
  if (element.chart === 'pie' || element.chart === 'doughnut') {
    const values = element.series[0]?.values ?? [];
    const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
    const radius = Math.max(4, Math.min(width, height - legendHeight) / 2 - 6);
    const cx = width / 2;
    const cy = (height - legendHeight) / 2;
    let angle = -Math.PI / 2;
    const arcs = values.map((value, index) => {
      const share = Math.max(0, value) / total;
      const start = angle;
      angle += share * Math.PI * 2;
      const large = share > 0.5 ? 1 : 0;
      const sx = cx + radius * Math.cos(start);
      const sy = cy + radius * Math.sin(start);
      const ex = cx + radius * Math.cos(angle);
      const ey = cy + radius * Math.sin(angle);
      return (
        <path
          key={element.categories[index] ?? index}
          d={`M ${cx} ${cy} L ${sx} ${sy} A ${radius} ${radius} 0 ${large} 1 ${ex} ${ey} Z`}
          fill={colors[index % colors.length]}
          stroke="var(--deck-bg)"
          strokeWidth={1.5}
        />
      );
    });
    return (
      <svg className="deck-chart" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {arcs}
        {element.chart === 'doughnut' ? (
          <circle cx={cx} cy={cy} r={radius * 0.55} fill="var(--deck-bg)" />
        ) : null}
        {showLegend
          ? element.categories.map((category, index) => (
              <g
                key={`${category}-${index}`}
                transform={`translate(${8 + index * (width / element.categories.length)}, ${height - 6})`}
              >
                <rect width={8} height={8} y={-7} fill={colors[index % colors.length]} />
                <text x={12} fontSize={labelSize} fill="var(--deck-ink)" fontFamily="var(--deck-body)">
                  {category}
                </text>
              </g>
            ))
          : null}
      </svg>
    );
  }
  const max = Math.max(1, ...element.series.flatMap((series) => series.values));
  const padLeft = 30;
  // Value labels sit above the tallest mark, so the plot leaves room for them.
  const padTop = element.values ? 8 + labelSize + 4 : 8;
  const padBottom = 18 + legendHeight;
  const plotW = width - padLeft - 8;
  const plotH = Math.max(10, height - padBottom - padTop);
  const ticks = [0, 0.5, 1];
  const grid = ticks.map((tick) => (
    <g key={tick}>
      <line
        x1={padLeft}
        x2={padLeft + plotW}
        y1={padTop + plotH - tick * plotH}
        y2={padTop + plotH - tick * plotH}
        stroke="var(--deck-muted)"
        strokeWidth={0.5}
        strokeDasharray={tick === 0 ? undefined : '2 2'}
        opacity={tick === 0 ? 0.9 : 0.5}
      />
      <text
        x={padLeft - 4}
        y={padTop + plotH - tick * plotH + 3}
        fontSize={labelSize - 1}
        textAnchor="end"
        fill="var(--deck-muted)"
        fontFamily="var(--deck-body)"
      >
        {Math.round(max * tick)}
        {unit}
      </text>
    </g>
  ));
  const groups = element.categories.length;
  const slot = plotW / groups;
  const marks: ReactNode[] = [];
  const categoryKey = (index: number) => `${element.categories[index] ?? 'c'}-${index}`;
  if (element.chart === 'line') {
    for (const [seriesIndex, series] of element.series.entries()) {
      const points = series.values
        .map((value, index) => `${padLeft + slot * (index + 0.5)},${padTop + plotH - (value / max) * plotH}`)
        .join(' ');
      marks.push(
        <polyline
          key={series.name}
          points={points}
          fill="none"
          stroke={colors[seriesIndex % colors.length]}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      );
      for (const [index, value] of series.values.entries())
        marks.push(
          <circle
            key={`${series.name}-${categoryKey(index)}`}
            cx={padLeft + slot * (index + 0.5)}
            cy={padTop + plotH - (value / max) * plotH}
            r={2.5}
            fill={colors[seriesIndex % colors.length]}
          />,
        );
    }
  } else {
    const barW = (slot * 0.6) / element.series.length;
    for (const [seriesIndex, series] of element.series.entries()) {
      for (const [index, value] of series.values.entries()) {
        const h = (Math.max(0, value) / max) * plotH;
        const x = padLeft + slot * index + slot * 0.2 + barW * seriesIndex;
        marks.push(
          <rect
            key={`${series.name}-${categoryKey(index)}`}
            x={x}
            y={padTop + plotH - h}
            width={barW - 1}
            height={h}
            fill={colors[seriesIndex % colors.length]}
          />,
        );
        if (element.values)
          marks.push(
            <text
              key={`${series.name}-${categoryKey(index)}-v`}
              x={x + (barW - 1) / 2}
              y={padTop + plotH - h - 3}
              fontSize={labelSize}
              textAnchor="middle"
              fill="var(--deck-ink)"
              fontFamily="var(--deck-body)"
            >
              {value}
              {unit}
            </text>,
          );
      }
    }
  }
  const labels = element.categories.map((category, index) => (
    <text
      key={`${category}-${index}`}
      x={padLeft + slot * (index + 0.5)}
      y={padTop + plotH + 11}
      fontSize={labelSize}
      textAnchor="middle"
      fill="var(--deck-ink)"
      fontFamily="var(--deck-body)"
    >
      {category}
    </text>
  ));
  const legend = showLegend
    ? element.series.map((series, index) => (
        <g key={`${series.name}-${index}`} transform={`translate(${padLeft + index * 80}, ${height - 5})`}>
          <rect width={8} height={8} y={-7} fill={colors[index % colors.length]} />
          <text x={12} fontSize={labelSize} fill="var(--deck-ink)" fontFamily="var(--deck-body)">
            {series.name}
          </text>
        </g>
      ))
    : null;
  const content = (
    <>
      {grid}
      {marks}
      {labels}
      {legend}
    </>
  );
  return (
    <svg className="deck-chart" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {element.chart === 'bar' ? (
        <g transform={`rotate(90 ${width / 2} ${width / 2}) scale(1 -1) translate(0 ${-height})`}>
          {content}
        </g>
      ) : (
        content
      )}
    </svg>
  );
}

export function ElementContent({ element }: { element: DeckElementV2 }) {
  if (element.type === 'text') {
    if (element.text) return <span className="deck-text">{element.text}</span>;
    return (
      <span className="deck-text opacity-40">
        {element.role === 'title' ? 'Title' : element.role === 'number' ? '00' : 'Text'}
      </span>
    );
  }
  if (element.type === 'line') return <LineArt element={element} />;
  if (element.type === 'chart') return <ChartArt element={element} />;
  if (element.type === 'image') {
    if (!element.src) return <span className="deck-image-missing">{element.alt || 'Image'}</span>;
    return (
      // biome-ignore lint/performance/noImgElement: slide assets are owned files at native size
      <img
        className="deck-image"
        src={element.src}
        alt={element.alt}
        draggable={false}
        style={{
          objectFit: element.fit ?? 'cover',
          objectPosition: element.focal ? `${element.focal.x * 100}% ${element.focal.y * 100}%` : '50% 50%',
        }}
      />
    );
  }
  return null;
}

export function SlideSurface({
  slide,
  theme,
  interactive = false,
  selected,
  onSelect,
  onEdit,
  readOnly = false,
  children,
  editing,
  onTextChange,
  onEditEnd,
  onElementPointerDown,
  textFieldRef,
}: {
  slide: DeckSlideV2;
  theme: DeckTheme;
  interactive?: boolean;
  selected?: string | null;
  onSelect?: (id: string) => void;
  onEdit?: (id: string) => void;
  readOnly?: boolean;
  children?: ReactNode;
  /** Text element edited in place; a textarea replaces its box. */
  editing?: string | null;
  onTextChange?: (id: string, text: string) => void;
  onEditEnd?: () => void;
  /** Press on an element; the editor turns it into a drag. */
  onElementPointerDown?: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  textFieldRef?: Ref<HTMLTextAreaElement>;
}) {
  const label = (element: DeckElementV2, index: number) =>
    element.type === 'text'
      ? `${element.role || 'Text'} object ${index + 1}`
      : `${element.type} object ${index + 1}`;
  return (
    <div
      className="deck-slide w-full"
      style={{
        ...deckThemeStyle(theme),
        backgroundColor: slide.background ? slideColor(slide.background, 'var(--deck-bg)') : 'var(--deck-bg)',
      }}
      data-slide-canvas
    >
      {slide.backgroundImage?.src ? (
        // biome-ignore lint/performance/noImgElement: slide assets are owned files at native size
        <img
          className="deck-slide-background"
          src={slide.backgroundImage.src}
          alt=""
          draggable={false}
          style={{
            opacity: slide.backgroundImage.opacity ?? 1,
            objectPosition: slide.backgroundImage.focal
              ? `${slide.backgroundImage.focal.x * 100}% ${slide.backgroundImage.focal.y * 100}%`
              : '50% 50%',
          }}
        />
      ) : null}
      {slide.elements.map((element, index) =>
        interactive && editing === element.id && element.type === 'text' ? (
          <textarea
            key={element.id}
            ref={textFieldRef}
            className="deck-element"
            data-element-id={element.id}
            data-element-type="text"
            data-editing="true"
            aria-label={`${label(element, index)} text`}
            style={elementStyle(element)}
            value={element.text}
            onChange={(event) => onTextChange?.(element.id, event.target.value)}
            onBlur={() => onEditEnd?.()}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
                event.preventDefault();
                event.stopPropagation();
                onEditEnd?.();
              }
            }}
          />
        ) : interactive ? (
          <button
            key={element.id}
            type="button"
            className="deck-element"
            data-element-id={element.id}
            data-element-type={element.type}
            aria-label={label(element, index)}
            aria-pressed={selected === element.id}
            disabled={readOnly}
            data-selected={selected === element.id}
            data-locked={element.locked ? 'true' : undefined}
            style={elementStyle(element)}
            onPointerDown={(event) => onElementPointerDown?.(element.id, event)}
            onClick={() => onSelect?.(element.id)}
            onFocus={() => onSelect?.(element.id)}
            onDoubleClick={() => onEdit?.(element.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onEdit?.(element.id);
              }
            }}
          >
            <ElementContent element={element} />
          </button>
        ) : (
          <div
            key={element.id}
            className="deck-element"
            data-element-type={element.type}
            style={elementStyle(element)}
          >
            <ElementContent element={element} />
          </div>
        ),
      )}
      {children}
    </div>
  );
}
