'use client';

import { cn } from '@/lib/utils';

/* Shared "black hole" loading treatment for long AI work (plan generation,
 * daily brief). Contract: fills its parent (absolute inset-0), shows labeled
 * context cards flying from the edges into a growing center singularity.
 * Completion is the parent's job — unmount inside AnimatePresence and let the
 * arriving content spring out. This stub renders a calm placeholder; the full
 * animation lands in the vortex implementation pass. */

export interface VortexSource {
  id: string;
  label: string;
  kind: 'mail' | 'calendar' | 'tasks' | 'areas' | 'web' | 'notes';
}

export const DEFAULT_VORTEX_SOURCES: VortexSource[] = [
  { id: 'mail', label: 'Mail', kind: 'mail' },
  { id: 'calendar', label: 'Calendar', kind: 'calendar' },
  { id: 'tasks', label: 'Tasks', kind: 'tasks' },
  { id: 'areas', label: 'Areas', kind: 'areas' },
  { id: 'web', label: 'Web', kind: 'web' },
];

export function ContextVortex({
  title,
  subtitle,
  sources = DEFAULT_VORTEX_SOURCES,
  className,
}: {
  title?: string;
  subtitle?: string;
  sources?: VortexSource[];
  className?: string;
}) {
  return (
    <div className={cn('absolute inset-0 grid place-items-center overflow-hidden', className)}>
      <div className="text-center">
        <div className="mx-auto size-16 animate-pulse rounded-full bg-[var(--color-accent)]/40" />
        {title ? <p className="mt-4 text-[14px] font-medium">{title}</p> : null}
        {subtitle ? <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">{subtitle}</p> : null}
        <p className="mt-2 text-[11px] text-[var(--color-text-faint)]">
          {sources.map((source) => source.label).join(' · ')}
        </p>
      </div>
    </div>
  );
}
