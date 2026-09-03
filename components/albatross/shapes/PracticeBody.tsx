'use client';

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  formatMetricValue,
  METRIC_SUMMARY_WEEKS,
  type MetricLike,
  metricSummary,
  practiceReviewLine,
} from '@/lib/albatross/practice-review';
import { cn } from '@/lib/utils';

export interface MetricEntry {
  _id: string;
  at: number;
  value: number;
  note?: string | null;
}

export const TREND_WIDTH = 240;
export const TREND_HEIGHT = 56;
export const PRACTICE_EMPTY_VALUE = '—';
export const METRIC_SAVE_ERROR = 'Could not save the log. Try again.';

const WEEK_MS = 7 * 24 * 60 * 60_000;

export interface TrendPoint {
  id: string;
  x: number;
  y: number;
  at: number;
  value: number;
}

export interface Trend {
  points: TrendPoint[];
  /** The `d` of the line through the points. Empty with fewer than two points. */
  path: string;
  /** The y of the target marker. Null without a target. */
  targetY: number | null;
}

/**
 * Points for the trend. The x axis is time: twelve weeks that end now, or
 * more when the first log is older. The y axis spans the values and the
 * target with a small margin. No axes, no grid.
 */
export function trendPoints(
  entries: MetricEntry[],
  target: number | null | undefined,
  nowMs: number,
  width = TREND_WIDTH,
  height = TREND_HEIGHT,
): Trend {
  const rows = [...entries]
    .filter((entry) => Number.isFinite(entry.value) && entry.at <= nowMs)
    .sort((a, b) => a.at - b.at);
  const first = rows[0];
  const start = Math.min(nowMs - METRIC_SUMMARY_WEEKS * WEEK_MS, first ? first.at : nowMs);
  const span = Math.max(1, nowMs - start);
  const values = rows.map((row) => row.value);
  if (typeof target === 'number' && Number.isFinite(target)) values.push(target);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const range = high - low || Math.max(1, Math.abs(high) * 0.1);
  const pad = 6;
  const y = (value: number) => pad + (1 - (value - low) / range) * (height - pad * 2);
  const inset = 4;
  const points = rows.map((row) => ({
    id: row._id,
    x: inset + ((row.at - start) / span) * (width - inset * 2),
    y: y(row.value),
    at: row.at,
    value: row.value,
  }));
  const path =
    points.length >= 2
      ? points
          .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
          .join(' ')
      : '';
  const targetY = typeof target === 'number' && Number.isFinite(target) ? y(target) : null;
  return { points, path, targetY };
}

/** "down to 170 lb", "up to 10 km", or the bare target without a direction. */
export function targetLine(metric: MetricLike | null | undefined): string | null {
  if (!metric || typeof metric.target !== 'number') return null;
  const value = formatMetricValue(metric.target, metric.unit);
  return metric.direction ? `${metric.direction} to ${value}` : value;
}

/** The width of an element, followed with a ResizeObserver. The fallback is the design width. */
function useElementWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * The trend: one line through the logs, one dot per log, and a thin marker
 * at the target. Inline SVG; the width follows the container.
 */
export function TrendLine({
  entries,
  target,
  nowMs,
  freshId,
  className,
}: {
  entries: MetricEntry[];
  target?: number | null;
  nowMs: number;
  /** The log that was just written. Its dot draws in over 300 ms. */
  freshId?: string | null;
  className?: string;
}) {
  const { ref, width } = useElementWidth(TREND_WIDTH);
  const trend = trendPoints(entries, target, nowMs, width);
  const [drawn, setDrawn] = useState<string | null>(null);
  useEffect(() => {
    if (!freshId) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setDrawn(freshId);
      return;
    }
    const frame = window.requestAnimationFrame(() => setDrawn(freshId));
    return () => window.cancelAnimationFrame(frame);
  }, [freshId]);
  return (
    <div ref={ref} className={cn('w-full', className)}>
      <svg
        role="img"
        aria-label={`Trend of ${trend.points.length} logs`}
        viewBox={`0 0 ${width} ${TREND_HEIGHT}`}
        width={width}
        height={TREND_HEIGHT}
        data-trend-points={trend.points.length}
        className="block h-14 overflow-visible"
      >
        {trend.targetY !== null ? (
          <line
            data-trend-target
            x1={0}
            x2={width}
            y1={trend.targetY}
            y2={trend.targetY}
            stroke="var(--color-accent-3)"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {trend.path ? (
          <path
            d={trend.path}
            fill="none"
            stroke="var(--color-text-muted)"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {trend.points.map((point) => {
          const fresh = point.id === freshId && drawn !== freshId;
          return (
            <circle
              key={point.id}
              data-trend-dot={point.id}
              cx={point.x}
              cy={point.y}
              r={fresh ? 0 : 2.5}
              fill="var(--color-accent)"
              className="transition-[r] duration-[var(--duration-moderate)] ease-[var(--ease-enter)] motion-reduce:transition-none"
            />
          );
        })}
      </svg>
    </div>
  );
}

/** The value a log field submits. Null for anything that is not a number. */
export function parseMetricInput(text: string): number | null {
  const clean = text.trim().replace(',', '.');
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/**
 * One field for a log: the number with the unit beside it, and an optional
 * note. Enter saves. Escape cancels.
 */
export function MetricLogField({
  unit,
  onSave,
  onCancel,
  saving = false,
  error = null,
}: {
  unit: string;
  onSave: (value: number, note?: string) => void;
  onCancel: () => void;
  saving?: boolean;
  error?: string | null;
}) {
  const valueId = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    valueRef.current?.focus();
  }, []);
  const parsed = parseMetricInput(value);

  const submit = () => {
    if (parsed === null) return;
    onSave(parsed, note.trim() || undefined);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  const inputClass =
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] leading-5 outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]';

  return (
    <form
      data-metric-log-field
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={valueId} className="sr-only">
        Value
      </label>
      <div className="flex items-center gap-1.5">
        <input
          ref={valueRef}
          id={valueId}
          type="text"
          inputMode="decimal"
          aria-label="Value"
          value={value}
          placeholder="0"
          disabled={saving}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKey}
          className={cn(inputClass, 'w-24 tabular-nums')}
        />
        {unit ? <span className="text-[12.5px] text-[var(--color-text-muted)]">{unit}</span> : null}
      </div>
      <input
        type="text"
        aria-label="Note"
        value={note}
        placeholder="Note, if you want one"
        disabled={saving}
        autoComplete="off"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={onKey}
        className={cn(inputClass, 'min-w-0 flex-1')}
      />
      <button
        type="submit"
        disabled={saving || parsed === null}
        className="text-[12.5px] font-medium text-[var(--color-accent)] disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={onCancel}
        className="text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        Cancel
      </button>
      {error ? <p className="basis-full text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </form>
  );
}

/**
 * The practice body. The current value large, the trend beside it, the
 * on-device review line below, and one button: Log.
 */
export function PracticeBody({
  metric,
  entries,
  nowMs,
  onLog,
  saving = false,
  error = null,
  freshId = null,
  className,
}: {
  metric: MetricLike | null;
  entries: MetricEntry[];
  nowMs: number;
  onLog: (value: number, note?: string) => void;
  saving?: boolean;
  error?: string | null;
  freshId?: string | null;
  className?: string;
}) {
  const [logging, setLogging] = useState(false);
  const summary = metricSummary(entries, nowMs);
  const unit = metric?.unit || '';
  const review = practiceReviewLine(entries, metric, nowMs);
  const target = targetLine(metric);

  useEffect(() => {
    if (freshId) setLogging(false);
  }, [freshId]);

  return (
    <section aria-label="Practice" data-shape-body="practice" className={cn('mt-6', className)}>
      <div className="flex flex-col gap-4 min-[480px]:flex-row min-[480px]:items-end">
        <div className="shrink-0">
          <p className="text-[11.5px] text-[var(--color-text-faint)]">{metric?.name || 'Now'}</p>
          <p className="mt-1 flex items-baseline gap-1.5">
            <span
              data-practice-value
              className="font-serif text-[40px] font-semibold leading-none tabular-nums tracking-tight"
            >
              {summary.latest === null ? PRACTICE_EMPTY_VALUE : formatMetricValue(summary.latest)}
            </span>
            {unit ? <span className="text-[16px] text-[var(--color-text-muted)]">{unit}</span> : null}
          </p>
          {target ? <p className="mt-1 text-[12px] text-[var(--color-accent-3)]">{target}</p> : null}
        </div>
        <div className="min-w-0 flex-1">
          <TrendLine entries={entries} target={metric?.target} nowMs={nowMs} freshId={freshId} />
        </div>
      </div>
      <p data-practice-review className="mt-4 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
        {review}
      </p>
      {logging ? (
        <MetricLogField
          unit={unit}
          saving={saving}
          error={error}
          onSave={(value, note) => onLog(value, note)}
          onCancel={() => setLogging(false)}
        />
      ) : (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setLogging(true)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Log
          </button>
          {error ? <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
        </div>
      )}
    </section>
  );
}
