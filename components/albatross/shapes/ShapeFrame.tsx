'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Fact } from '@/components/albatross/primitives';
import type { ListItem } from '@/components/albatross/shapes/ListRow';
import { type Milestone, railStates } from '@/components/albatross/shapes/MilestoneRail';
import { agoLine } from '@/components/albatross/shapes/ProjectLog';
import { formatMetricValue, type MetricLike, type MetricSummary } from '@/lib/albatross/practice-review';
import { type ShapeDetail, shapeDetail, shapePlans } from '@/lib/albatross/shape-policy';
import type { WorkShape } from '@/lib/albatross/work-shape';
import { cn } from '@/lib/utils';

export const SHAPE_FADE_MS = 200;

/** Shapes with no finish line. The completion card never shows for them. */
export const SHAPES_WITHOUT_FINISH: ReadonlySet<WorkShape> = new Set<WorkShape>([
  'list',
  'practice',
  'monitor',
]);

/** One line for the shapes that keep the guided body but have no plan. */
export const SHAPE_STATUS_LINE: Partial<Record<WorkShape, string>> = {
  decision: 'A decision. It ends when you choose.',
  monitor: 'A watch. Albatross looks for the change and tells you.',
  recurring: 'A routine. It comes back on its schedule.',
};

export interface ShapeFact {
  label: string;
  value: string;
  faint?: boolean;
}

/**
 * The three facts a shape shows in the header. `quick` and the shapes with a
 * guided body keep the default facts, so this returns null for them.
 */
export function shapeFacts(
  shape: WorkShape,
  data: {
    listItems?: ListItem[] | null;
    metric?: MetricLike | null;
    metricSummary?: MetricSummary | null;
    milestones?: Milestone[] | null;
    lastUserTouchAt?: number | null;
  },
  nowMs: number,
): ShapeFact[] | null {
  const detail = shapeDetail(shape);
  if (detail === 'list') {
    const items = data.listItems ?? [];
    const done = items.filter((item) => item.done).length;
    const lastAdded = items.reduce((latest, item) => Math.max(latest, item.addedAt), 0);
    return [
      { label: 'Items', value: String(items.length) },
      { label: 'Done', value: String(done) },
      { label: 'Added', value: lastAdded ? agoLine(lastAdded, nowMs) : 'Nothing yet', faint: !lastAdded },
    ];
  }
  if (detail === 'practice') {
    const unit = data.metric?.unit || '';
    const latest = data.metricSummary?.latest ?? null;
    const target = data.metric?.target;
    return [
      {
        label: 'Now',
        value: latest === null ? '—' : formatMetricValue(latest, unit),
        faint: latest === null,
      },
      {
        label: 'Target',
        value: typeof target === 'number' ? formatMetricValue(target, unit) : 'None set',
        faint: typeof target !== 'number',
      },
      { label: 'Weeks logged', value: `${data.metricSummary?.weeksWithEntry ?? 0} of 12` },
    ];
  }
  if (detail === 'milestones') {
    const rows = railStates(data.milestones ?? []);
    const done = rows.filter((row) => row.state === 'done').length;
    const next = rows.find((row) => row.state === 'current')?.milestone.title;
    const touched = data.lastUserTouchAt;
    return [
      {
        label: 'Milestones',
        value: rows.length ? `${done} of ${rows.length} done` : 'None yet',
        faint: !rows.length,
      },
      {
        label: 'Last touched',
        value: typeof touched === 'number' ? agoLine(touched, nowMs) : 'Not yet',
        faint: typeof touched !== 'number',
      },
      { label: 'Next', value: next ?? (rows.length ? 'All done' : 'Add a milestone'), faint: !next },
    ];
  }
  return null;
}

/** The facts as header nodes. Null keeps the default three. */
export function ShapeFactsRow({ facts }: { facts: ShapeFact[] }) {
  return (
    <>
      {facts.map((fact) => (
        <Fact key={fact.label} label={fact.label}>
          <span
            className={cn(
              'text-[13px]',
              fact.faint ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-text)]',
            )}
          >
            {fact.value}
          </span>
        </Fact>
      ))}
    </>
  );
}

/** True when the shape may show plan, step, and proof affordances. */
export function shapeShowsPlan(shape: WorkShape): boolean {
  return shapePlans(shape) !== 'no';
}

/** True when the shape can be marked complete. */
export function shapeFinishes(shape: WorkShape): boolean {
  return !SHAPES_WITHOUT_FINISH.has(shape);
}

export type ShapeFadePhase = 'in' | 'out';

/**
 * The body for the current shape. When the shape changes the old body fades
 * out over 200 ms, then the new body fades in. With reduced motion the swap
 * is immediate.
 */
export function ShapeBodySwap({
  shape,
  children,
  className,
}: {
  shape: WorkShape;
  children: (shown: WorkShape, detail: ShapeDetail) => ReactNode;
  className?: string;
}) {
  const [shown, setShown] = useState(shape);
  const [phase, setPhase] = useState<ShapeFadePhase>('in');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (shape === shown) return;
    setPhase('out');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(shape);
      setPhase('in');
    }, SHAPE_FADE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [shape, shown]);

  return (
    <div
      data-shape-fade={phase}
      data-shape-shown={shown}
      className={cn(
        'transition-opacity duration-[var(--duration-normal)] motion-reduce:transition-none',
        phase === 'out' ? 'opacity-0 ease-[var(--ease-exit)]' : 'opacity-100 ease-[var(--ease-enter)]',
        className,
      )}
    >
      {children(shown, shapeDetail(shown))}
    </div>
  );
}
