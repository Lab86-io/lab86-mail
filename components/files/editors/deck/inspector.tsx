'use client';

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DeckChartElement, DeckImageElement, DeckTheme } from '@/lib/documents/model';
import {
  type DeckElement,
  type DeckModel,
  type DeckSlide,
  type ElementPatch,
  elementLabel,
} from '../deck-model';
import { textSizeFor } from '../SlideRenderer';
import type { UploadedDeckAsset } from './assets';
import { focalFromPointer } from './canvas-math';
import { formatChartRows, parseChartRows } from './chart-data';
import {
  ChoiceField,
  ColorField,
  FieldRow,
  InspectorSection,
  NumberField,
  NumberPair,
  SelectField,
  SwitchField,
  TextField,
} from './fields';
import { ThemePanel } from './theme-panel';

/**
 * The contextual inspector. With nothing selected it edits the slide and
 * the deck theme; with an element selected it edits that element. Rich
 * fields (typography beyond size and color, strokes, rotation, opacity,
 * lock, lines, images, charts, the theme) need version 2 authoring.
 */

export interface DeckInspectorProps {
  model: DeckModel;
  slide: DeckSlide;
  element?: DeckElement;
  rich: boolean;
  readOnly?: boolean;
  onElementPatch: (patch: ElementPatch, key?: string) => void;
  onSlidePatch: (patch: Partial<DeckSlide>, key?: string) => void;
  onBackgroundImage: (image: DeckSlide['backgroundImage'] | null) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onReorder: (direction: -1 | 1) => void;
  onTheme: (theme: DeckTheme) => void;
  upload: (file: File) => Promise<UploadedDeckAsset>;
}

const WEIGHTS = [
  { value: '', label: 'By role' },
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Heavy' },
];

const DASHES = [
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dashed' },
  { value: 'dot', label: 'Dotted' },
] as const;

/** A file input that opens from a button and reports the chosen file. */
function UploadButton({
  label,
  busy,
  disabled,
  onFile,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-label={`${label} file`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        {busy ? 'Uploading' : label}
      </Button>
    </>
  );
}

function useUpload(upload: (file: File) => Promise<UploadedDeckAsset>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (file: File, apply: (asset: UploadedDeckAsset) => void) => {
    setBusy(true);
    setError(null);
    try {
      apply(await upload(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function SharedPanel({
  element,
  rich,
  readOnly,
  onElementPatch,
  onDelete,
  onDuplicate,
  onReorder,
  isFirst,
  isLast,
}: Pick<
  DeckInspectorProps,
  'element' | 'rich' | 'readOnly' | 'onElementPatch' | 'onDelete' | 'onDuplicate' | 'onReorder'
> & { element: DeckElement; isFirst: boolean; isLast: boolean }) {
  const locked = Boolean(element.locked);
  const geometry = readOnly || locked;
  const line = element.type === 'line';
  return (
    <>
      <InspectorSection title="Position and size">
        <NumberPair
          left={{
            label: 'X',
            value: element.x,
            min: 0,
            max: 100,
            unit: '%',
            disabled: geometry,
            onChange: (value) => onElementPatch({ x: value ?? 0 }),
          }}
          right={{
            label: 'Y',
            value: element.y,
            min: 0,
            max: 100,
            unit: '%',
            disabled: geometry,
            onChange: (value) => onElementPatch({ y: value ?? 0 }),
          }}
        />
        <NumberPair
          left={{
            label: 'Width',
            value: element.width,
            min: line ? 0 : 1,
            max: 100,
            unit: '%',
            disabled: geometry,
            onChange: (value) => onElementPatch({ width: value ?? (line ? 0 : 1) }),
          }}
          right={{
            label: 'Height',
            value: element.height,
            min: line ? 0 : 1,
            max: 100,
            unit: '%',
            disabled: geometry,
            onChange: (value) => onElementPatch({ height: value ?? (line ? 0 : 1) }),
          }}
        />
        {rich ? (
          <NumberPair
            left={{
              label: 'Rotation',
              value: element.rotation ?? 0,
              min: -360,
              max: 360,
              unit: 'deg',
              disabled: geometry,
              onChange: (value) => onElementPatch({ rotation: value ? value : undefined }),
            }}
            right={{
              label: 'Opacity',
              value: Math.round((element.opacity ?? 1) * 100),
              min: 0,
              max: 100,
              unit: '%',
              disabled: readOnly,
              onChange: (value) =>
                onElementPatch({
                  opacity: value === undefined || value >= 100 ? undefined : Math.max(0, value) / 100,
                }),
            }}
          />
        ) : null}
      </InspectorSection>
      <InspectorSection title="Layer">
        <div className="deck-button-row">
          <Button variant="outline" size="sm" disabled={readOnly || isLast} onClick={() => onReorder(1)}>
            Bring forward
          </Button>
          <Button variant="outline" size="sm" disabled={readOnly || isFirst} onClick={() => onReorder(-1)}>
            Send backward
          </Button>
        </div>
        {rich ? (
          <SwitchField
            label="Lock"
            checked={locked}
            disabled={readOnly}
            onChange={(checked) => onElementPatch({ locked: checked ? true : undefined })}
          />
        ) : null}
        <div className="deck-button-row">
          <Button variant="outline" size="sm" disabled={readOnly} onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button variant="outline" size="sm" disabled={readOnly || locked} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </InspectorSection>
    </>
  );
}

function TextPanel({
  element,
  theme,
  rich,
  readOnly,
  onElementPatch,
}: {
  element: Extract<DeckElement, { type: 'text' }>;
  theme: DeckTheme;
  rich: boolean;
  readOnly?: boolean;
  onElementPatch: DeckInspectorProps['onElementPatch'];
}) {
  return (
    <>
      <InspectorSection title="Content">
        <textarea
          aria-label="Object text"
          className="control-field min-h-20 w-full resize-y p-2 text-sm"
          disabled={readOnly}
          value={element.text}
          onChange={(event) => onElementPatch({ text: event.target.value }, `text:${element.id}`)}
        />
      </InspectorSection>
      <InspectorSection title="Type">
        {rich ? (
          <SelectField
            label="Font"
            value={element.font ?? ''}
            options={[
              { value: '', label: 'By role' },
              { value: 'display', label: `Display (${theme.fonts.display.family})` },
              { value: 'body', label: `Body (${theme.fonts.body.family})` },
              { value: 'mono', label: `Mono (${theme.fonts.mono?.family ?? theme.fonts.body.family})` },
            ]}
            disabled={readOnly}
            onChange={(value) => onElementPatch({ font: value || undefined })}
          />
        ) : null}
        {rich ? (
          <NumberPair
            left={{
              label: 'Size',
              value: element.fontSize ?? textSizeFor(element),
              min: 8,
              max: 240,
              unit: 'pt',
              disabled: readOnly,
              onChange: (value) => onElementPatch({ fontSize: value ?? textSizeFor(element) }),
            }}
            right={{
              label: 'Line',
              value: element.lineHeight,
              min: 0.8,
              max: 3,
              step: 0.05,
              placeholder: element.role === 'title' || element.role === 'number' ? '1.05' : '1.3',
              disabled: readOnly,
              onChange: (value) => onElementPatch({ lineHeight: value }),
            }}
          />
        ) : (
          <NumberField
            label="Size"
            value={element.fontSize ?? textSizeFor(element)}
            min={8}
            max={160}
            unit="pt"
            disabled={readOnly}
            onChange={(value) => onElementPatch({ fontSize: value ?? textSizeFor(element) })}
          />
        )}
        {rich ? (
          <>
            <SelectField
              label="Weight"
              value={element.fontWeight !== undefined ? String(element.fontWeight) : ''}
              options={WEIGHTS}
              disabled={readOnly}
              onChange={(value) => onElementPatch({ fontWeight: value ? Number(value) : undefined })}
            />
            <SwitchField
              label="Italic"
              checked={Boolean(element.italic)}
              disabled={readOnly}
              onChange={(checked) => onElementPatch({ italic: checked ? true : undefined })}
            />
            <ChoiceField
              label="Align"
              value={element.align ?? 'left'}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              disabled={readOnly}
              onChange={(value) => onElementPatch({ align: value === 'left' ? undefined : value })}
            />
            <ChoiceField
              label="Vertical"
              value={element.valign ?? 'middle'}
              options={[
                { value: 'top', label: 'Top' },
                { value: 'middle', label: 'Middle' },
                { value: 'bottom', label: 'Bottom' },
              ]}
              disabled={readOnly}
              onChange={(value) => onElementPatch({ valign: value === 'middle' ? undefined : value })}
            />
            <NumberField
              label="Tracking"
              value={element.letterSpacing}
              min={-0.1}
              max={0.5}
              step={0.01}
              unit="em"
              placeholder="0"
              disabled={readOnly}
              onChange={(value) => onElementPatch({ letterSpacing: value })}
            />
          </>
        ) : null}
      </InspectorSection>
      <InspectorSection title="Color">
        <ColorField
          label="Text"
          value={element.color}
          fallback={theme.colors.ink}
          disabled={readOnly}
          clearLabel={rich ? 'Theme' : undefined}
          onChange={(value) => onElementPatch({ color: value })}
        />
        {rich ? (
          <ColorField
            label="Fill"
            value={element.fill}
            fallback={theme.colors.background}
            disabled={readOnly}
            clearLabel="None"
            onChange={(value) => onElementPatch({ fill: value })}
          />
        ) : null}
      </InspectorSection>
    </>
  );
}

function ShapePanel({
  element,
  theme,
  rich,
  readOnly,
  onElementPatch,
}: {
  element: Extract<DeckElement, { type: 'shape' }>;
  theme: DeckTheme;
  rich: boolean;
  readOnly?: boolean;
  onElementPatch: DeckInspectorProps['onElementPatch'];
}) {
  const stroke = element.stroke;
  const patchStroke = (patch: Partial<NonNullable<typeof stroke>>) =>
    onElementPatch({
      stroke: {
        color: stroke?.color ?? theme.colors.muted,
        width: stroke?.width ?? 0.75,
        ...stroke,
        ...patch,
      },
    });
  return (
    <>
      <InspectorSection title="Fill">
        {rich ? (
          <SelectField
            label="Kind"
            value={element.shape ?? 'rect'}
            options={[
              { value: 'rect', label: 'Rectangle' },
              { value: 'roundRect', label: 'Rounded rectangle' },
              { value: 'ellipse', label: 'Ellipse' },
            ]}
            disabled={readOnly}
            onChange={(value) => onElementPatch({ shape: value === 'rect' ? undefined : value })}
          />
        ) : null}
        <ColorField
          label="Fill"
          value={element.fill}
          fallback={theme.colors.surface}
          disabled={readOnly}
          clearLabel={rich ? 'Theme' : undefined}
          onChange={(value) => onElementPatch({ fill: value })}
        />
        {rich && element.shape === 'roundRect' ? (
          <NumberField
            label="Radius"
            value={element.radius ?? 12}
            min={0}
            max={120}
            unit="pt"
            disabled={readOnly}
            onChange={(value) => onElementPatch({ radius: value })}
          />
        ) : null}
      </InspectorSection>
      <InspectorSection title="Stroke">
        <ColorField
          label="Color"
          value={stroke?.color}
          fallback={theme.colors.muted}
          disabled={readOnly}
          clearLabel={rich ? 'None' : undefined}
          onChange={(value) =>
            value ? patchStroke({ color: value }) : onElementPatch({ stroke: undefined })
          }
        />
        {rich ? (
          <>
            <NumberField
              label="Width"
              value={stroke?.width ?? 0}
              min={0}
              max={24}
              step={0.25}
              unit="pt"
              disabled={readOnly}
              onChange={(value) =>
                value && value > 0
                  ? patchStroke({ width: Math.max(0.25, value) })
                  : onElementPatch({ stroke: undefined })
              }
            />
            <SelectField
              label="Dash"
              value={stroke?.dash ?? 'solid'}
              options={[...DASHES]}
              disabled={readOnly || !stroke}
              onChange={(value) => patchStroke({ dash: value === 'solid' ? undefined : value })}
            />
          </>
        ) : null}
      </InspectorSection>
    </>
  );
}

function LinePanel({
  element,
  readOnly,
  onElementPatch,
}: {
  element: Extract<DeckElement, { type: 'line' }>;
  readOnly?: boolean;
  onElementPatch: DeckInspectorProps['onElementPatch'];
}) {
  const patchStroke = (patch: Partial<typeof element.stroke>) =>
    onElementPatch({ stroke: { ...element.stroke, ...patch } });
  return (
    <InspectorSection title="Stroke">
      <ColorField
        label="Color"
        value={element.stroke.color}
        fallback={element.stroke.color}
        disabled={readOnly}
        onChange={(value) => {
          if (value) patchStroke({ color: value });
        }}
      />
      <NumberField
        label="Width"
        value={element.stroke.width}
        min={0.25}
        max={24}
        step={0.25}
        unit="pt"
        disabled={readOnly}
        onChange={(value) => patchStroke({ width: Math.min(24, Math.max(0.25, value ?? 1)) })}
      />
      <SelectField
        label="Dash"
        value={element.stroke.dash ?? 'solid'}
        options={[...DASHES]}
        disabled={readOnly}
        onChange={(value) => patchStroke({ dash: value === 'solid' ? undefined : value })}
      />
      <SwitchField
        label="Rises"
        checked={Boolean(element.flip)}
        disabled={readOnly || element.width === 0 || element.height === 0}
        onChange={(checked) => onElementPatch({ flip: checked ? true : undefined })}
      />
    </InspectorSection>
  );
}

function FocalPicker({
  element,
  disabled,
  onChange,
}: {
  element: DeckImageElement;
  disabled?: boolean;
  onChange: (focal: { x: number; y: number }) => void;
}) {
  const pressed = useRef(false);
  const focal = element.focal ?? { x: 0.5, y: 0.5 };
  const set = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onChange(focalFromPointer(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
  };
  return (
    <button
      type="button"
      className="deck-focal"
      aria-label={`Focal point ${Math.round(focal.x * 100)} percent across, ${Math.round(focal.y * 100)} percent down. Press to move it.`}
      disabled={disabled || !element.src}
      style={{ aspectRatio: element.aspect ? String(element.aspect) : '4 / 3' }}
      onPointerDown={(event) => {
        pressed.current = true;
        set(event);
      }}
      onPointerMove={(event) => {
        if (pressed.current) set(event);
      }}
      onPointerUp={() => {
        pressed.current = false;
      }}
      onPointerLeave={() => {
        pressed.current = false;
      }}
      onKeyDown={(event) => {
        const steps: Record<string, [number, number]> = {
          ArrowLeft: [-0.05, 0],
          ArrowRight: [0.05, 0],
          ArrowUp: [0, -0.05],
          ArrowDown: [0, 0.05],
        };
        const step = steps[event.key];
        if (!step) return;
        event.preventDefault();
        onChange({
          x: Math.round(Math.min(1, Math.max(0, focal.x + step[0])) * 100) / 100,
          y: Math.round(Math.min(1, Math.max(0, focal.y + step[1])) * 100) / 100,
        });
      }}
    >
      {element.src ? (
        // biome-ignore lint/performance/noImgElement: a preview of an owned asset at its own size
        <img src={element.src} alt="" draggable={false} />
      ) : null}
      <span className="deck-focal-dot" style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }} />
    </button>
  );
}

function ImagePanel({
  element,
  readOnly,
  onElementPatch,
  upload,
}: {
  element: DeckImageElement;
  readOnly?: boolean;
  onElementPatch: DeckInspectorProps['onElementPatch'];
  upload: DeckInspectorProps['upload'];
}) {
  const uploader = useUpload(upload);
  return (
    <InspectorSection title="Crop">
      <FocalPicker
        element={element}
        disabled={readOnly}
        onChange={(focal) => onElementPatch({ focal }, `focal:${element.id}`)}
      />
      <p className="deck-inspector-note">Press on the preview to set the focal point.</p>
      <SelectField
        label="Fit"
        value={element.fit ?? 'cover'}
        options={[
          { value: 'cover', label: 'Cover' },
          { value: 'contain', label: 'Contain' },
        ]}
        disabled={readOnly}
        onChange={(value) => onElementPatch({ fit: value })}
      />
      <NumberPair
        left={{
          label: 'Focal X',
          value: Math.round((element.focal?.x ?? 0.5) * 100),
          min: 0,
          max: 100,
          unit: '%',
          disabled: readOnly,
          onChange: (value) =>
            onElementPatch({
              focal: { x: Math.min(1, Math.max(0, (value ?? 50) / 100)), y: element.focal?.y ?? 0.5 },
            }),
        }}
        right={{
          label: 'Focal Y',
          value: Math.round((element.focal?.y ?? 0.5) * 100),
          min: 0,
          max: 100,
          unit: '%',
          disabled: readOnly,
          onChange: (value) =>
            onElementPatch({
              focal: { x: element.focal?.x ?? 0.5, y: Math.min(1, Math.max(0, (value ?? 50) / 100)) },
            }),
        }}
      />
      <NumberField
        label="Radius"
        value={element.radius ?? 0}
        min={0}
        max={120}
        unit="pt"
        disabled={readOnly}
        onChange={(value) => onElementPatch({ radius: value ? value : undefined })}
      />
      <TextField
        label="Alt text"
        value={element.alt}
        disabled={readOnly}
        placeholder="What the image shows"
        onChange={(value) => onElementPatch({ alt: value }, `alt:${element.id}`)}
      />
      <div className="deck-button-row">
        <UploadButton
          label="Replace image"
          busy={uploader.busy}
          disabled={readOnly}
          onFile={(file) =>
            uploader.run(file, (asset) =>
              onElementPatch({
                assetId: asset.assetId,
                src: asset.src,
                ...(asset.aspect ? { aspect: asset.aspect } : {}),
              }),
            )
          }
        />
      </div>
      {uploader.error ? (
        <p role="alert" className="deck-inspector-error">
          {uploader.error}
        </p>
      ) : null}
    </InspectorSection>
  );
}

/** Stable keys for series rows; names may repeat, so repeats get a counter. */
function seriesKeys(series: { name: string }[]) {
  const seen = new Map<string, number>();
  return series.map((item) => {
    const count = seen.get(item.name) ?? 0;
    seen.set(item.name, count + 1);
    return count ? `${item.name}#${count}` : item.name || '#';
  });
}

function ChartPanel({
  element,
  theme,
  readOnly,
  onElementPatch,
}: {
  element: DeckChartElement;
  theme: DeckTheme;
  readOnly?: boolean;
  onElementPatch: DeckInspectorProps['onElementPatch'];
}) {
  const formatted = formatChartRows(element);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(formatted);
    setError(null);
  }, [formatted]);
  const commit = () => {
    const result = parseChartRows(
      draft,
      element.series.map((series) => series.name),
    );
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    onElementPatch({ categories: result.rows.categories, series: result.rows.series });
  };
  const palette = [theme.colors.accent, theme.colors.ink, theme.colors.muted, theme.colors.surface];
  const keys = seriesKeys(element.series);
  return (
    <>
      <InspectorSection title="Display">
        <SelectField
          label="Kind"
          value={element.chart}
          options={[
            { value: 'column', label: 'Column' },
            { value: 'bar', label: 'Bar' },
            { value: 'line', label: 'Line' },
            { value: 'pie', label: 'Pie' },
            { value: 'doughnut', label: 'Doughnut' },
          ]}
          disabled={readOnly}
          onChange={(value) => onElementPatch({ chart: value })}
        />
        <SwitchField
          label="Legend"
          checked={element.legend ?? element.series.length > 1}
          disabled={readOnly}
          onChange={(checked) => onElementPatch({ legend: checked })}
        />
        <SwitchField
          label="Values"
          checked={Boolean(element.values)}
          disabled={readOnly}
          onChange={(checked) => onElementPatch({ values: checked ? true : undefined })}
        />
        <TextField
          label="Unit"
          value={element.unit ?? ''}
          disabled={readOnly}
          placeholder="k, %, h"
          onChange={(value) => onElementPatch({ unit: value || undefined }, `unit:${element.id}`)}
        />
        <TextField
          label="Source"
          value={element.source ?? ''}
          disabled={readOnly}
          placeholder="Where the numbers come from"
          onChange={(value) => onElementPatch({ source: value || undefined }, `source:${element.id}`)}
        />
      </InspectorSection>
      <InspectorSection title="Data">
        {element.series.map((series, index) => (
          <TextField
            key={keys[index]}
            label={`Series ${index + 1}`}
            value={series.name}
            disabled={readOnly}
            onChange={(value) =>
              onElementPatch(
                {
                  series: element.series.map((candidate, at) =>
                    at === index ? { ...candidate, name: value } : candidate,
                  ),
                },
                `series-name:${element.id}:${index}`,
              )
            }
          />
        ))}
        <textarea
          aria-label="Chart data"
          className="control-field min-h-28 w-full resize-y p-2 font-mono text-xs"
          disabled={readOnly}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
        <p className="deck-inspector-note">
          One line per category: label, value. Add a comma and a value for each extra series. Applies when you
          leave the field.
        </p>
        {error ? (
          <p role="alert" className="deck-inspector-error">
            {error}
          </p>
        ) : null}
      </InspectorSection>
      <InspectorSection title="Colors">
        {element.series.map((series, index) => (
          <ColorField
            key={keys[index]}
            label={series.name || `Series ${index + 1}`}
            value={element.colors?.[index]}
            fallback={palette[index % palette.length]}
            disabled={readOnly}
            onChange={(value) => {
              const colors = element.series.map(
                (_, at) => element.colors?.[at] ?? palette[at % palette.length],
              );
              if (value) colors[index] = value;
              else colors[index] = palette[index % palette.length];
              onElementPatch({ colors });
            }}
          />
        ))}
        <div className="deck-button-row">
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || !element.colors?.length}
            onClick={() => onElementPatch({ colors: undefined })}
          >
            Use theme colors
          </Button>
        </div>
      </InspectorSection>
    </>
  );
}

function SlidePanel({
  model,
  slide,
  rich,
  readOnly,
  onSlidePatch,
  onBackgroundImage,
  onTheme,
  upload,
}: Pick<
  DeckInspectorProps,
  'model' | 'slide' | 'rich' | 'readOnly' | 'onSlidePatch' | 'onBackgroundImage' | 'onTheme' | 'upload'
>) {
  const uploader = useUpload(upload);
  const background = slide.backgroundImage;
  return (
    <>
      <InspectorSection title="Slide">
        <TextField
          label="Title"
          value={slide.title}
          disabled={readOnly}
          onChange={(value) => onSlidePatch({ title: value }, `title:${slide.id}`)}
        />
        <ColorField
          label="Background"
          value={slide.background}
          fallback={model.theme.colors.background}
          disabled={readOnly}
          clearLabel={rich ? 'Theme' : undefined}
          onChange={(value) => onSlidePatch({ background: value })}
        />
        {rich ? (
          <>
            <FieldRow label="Image">
              <div className="deck-button-row">
                <UploadButton
                  label={background ? 'Replace' : 'Add image'}
                  busy={uploader.busy}
                  disabled={readOnly}
                  onFile={(file) =>
                    uploader.run(file, (asset) =>
                      onBackgroundImage({ ...background, assetId: asset.assetId, src: asset.src }),
                    )
                  }
                />
                {background ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={readOnly}
                    onClick={() => onBackgroundImage(null)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </FieldRow>
            {background ? (
              <NumberField
                label="Image opacity"
                value={Math.round((background.opacity ?? 1) * 100)}
                min={0}
                max={100}
                unit="%"
                disabled={readOnly}
                onChange={(value) =>
                  onBackgroundImage({
                    ...background,
                    opacity: value === undefined || value >= 100 ? undefined : Math.max(0, value) / 100,
                  })
                }
              />
            ) : null}
            {uploader.error ? (
              <p role="alert" className="deck-inspector-error">
                {uploader.error}
              </p>
            ) : null}
          </>
        ) : null}
      </InspectorSection>
      {rich ? <ThemePanel theme={model.theme} readOnly={readOnly} onApply={onTheme} /> : null}
    </>
  );
}

export function DeckInspector(props: DeckInspectorProps) {
  const { model, slide, element, rich, readOnly } = props;
  if (!element) {
    return (
      <div className="deck-inspector-body">
        <SlidePanel
          model={model}
          slide={slide}
          rich={rich}
          readOnly={readOnly}
          onSlidePatch={props.onSlidePatch}
          onBackgroundImage={props.onBackgroundImage}
          onTheme={props.onTheme}
          upload={props.upload}
        />
        <p className="deck-inspector-note">
          Select an element on the slide to edit it. Arrow keys move it, Shift moves it faster, Delete removes
          it.
        </p>
      </div>
    );
  }
  const index = slide.elements.findIndex((candidate) => candidate.id === element.id);
  return (
    <div className="deck-inspector-body">
      <div className="deck-inspector-title">
        <span>{elementLabel(element)}</span>
        {element.locked ? <span className="deck-inspector-badge">Locked</span> : null}
      </div>
      {element.type === 'text' ? (
        <TextPanel
          element={element}
          theme={model.theme}
          rich={rich}
          readOnly={readOnly}
          onElementPatch={props.onElementPatch}
        />
      ) : element.type === 'shape' ? (
        <ShapePanel
          element={element}
          theme={model.theme}
          rich={rich}
          readOnly={readOnly}
          onElementPatch={props.onElementPatch}
        />
      ) : element.type === 'line' ? (
        <LinePanel element={element} readOnly={readOnly} onElementPatch={props.onElementPatch} />
      ) : element.type === 'image' ? (
        <ImagePanel
          element={element}
          readOnly={readOnly}
          onElementPatch={props.onElementPatch}
          upload={props.upload}
        />
      ) : (
        <ChartPanel
          element={element}
          theme={model.theme}
          readOnly={readOnly}
          onElementPatch={props.onElementPatch}
        />
      )}
      <SharedPanel
        element={element}
        rich={rich}
        readOnly={readOnly}
        onElementPatch={props.onElementPatch}
        onDelete={props.onDelete}
        onDuplicate={props.onDuplicate}
        onReorder={props.onReorder}
        isFirst={index <= 0}
        isLast={index >= slide.elements.length - 1}
      />
    </div>
  );
}
