'use client';

import { useState } from 'react';
import {
  MILESTONES_EMPTY_LINE,
  type Milestone,
  MilestoneEditor,
  MilestoneRail,
  type MilestoneRow,
} from '@/components/albatross/shapes/MilestoneRail';
import { type LogArtifact, ProjectLog } from '@/components/albatross/shapes/ProjectLog';
import type { EvidenceLike } from '@/lib/albatross/proof';
import { cn } from '@/lib/utils';

/**
 * The project body. The milestone rail, an inline editor for it, and the
 * artifact log below.
 */
export function ProjectBody({
  milestones,
  evidence,
  artifacts = [],
  lastUserTouchAt,
  nowMs,
  onToggle,
  onSetMilestones,
  busyIds,
  saving = false,
  error = null,
  className,
}: {
  milestones: Milestone[];
  evidence: EvidenceLike[];
  artifacts?: LogArtifact[];
  lastUserTouchAt?: number | null;
  nowMs: number;
  onToggle: (id: string) => void;
  onSetMilestones: (rows: MilestoneRow[]) => Promise<boolean> | boolean;
  busyIds?: ReadonlySet<string>;
  saving?: boolean;
  error?: string | null;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);

  const save = async (rows: MilestoneRow[]) => {
    const ok = await onSetMilestones(rows);
    if (ok !== false) setEditing(false);
  };

  return (
    <section aria-label="Project" data-shape-body="project" className={cn('mt-6', className)}>
      {editing ? (
        <MilestoneEditor
          milestones={milestones}
          saving={saving}
          error={error}
          onSave={(rows) => void save(rows)}
          onCancel={() => setEditing(false)}
        />
      ) : milestones.length ? (
        <>
          <MilestoneRail milestones={milestones} onToggle={onToggle} busyIds={busyIds} />
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
            >
              Edit milestones
            </button>
            {error ? <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[13px] text-[var(--color-text-muted)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:text-[var(--color-text)] hover:decoration-[var(--color-accent)]"
        >
          {MILESTONES_EMPTY_LINE}
        </button>
      )}
      <ProjectLog evidence={evidence} artifacts={artifacts} lastUserTouchAt={lastUserTouchAt} nowMs={nowMs} />
    </section>
  );
}
