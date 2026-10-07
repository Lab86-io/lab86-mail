'use client';

// A `step_run` shape outside the Work thread (the global chat): one row that
// says what happened and opens the Albatross. Inside the thread the live run
// block renders in its place (components/shell/AIBar.tsx, StepRunPart).

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { ActionBar, ShapeShell } from './shape-shell';

const ACTION_LINE: Record<'started' | 'resumed' | 'steered', string> = {
  started: 'Albatross started on the step. The run reports in the Albatross.',
  resumed: 'Albatross continued the step with your note.',
  steered: 'Your note went to the run in progress.',
};

export function StepRunCard({ shape }: { shape: Extract<ToolShape, { kind: 'step_run' }> }) {
  return (
    <ShapeShell>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <span className="text-[12.5px] font-medium leading-snug text-[var(--color-accent-3)]">
          {ACTION_LINE[shape.action]}
        </span>
        {shape.summary ? (
          <span className="text-[12px] leading-snug text-[var(--color-text-muted)]">{shape.summary}</span>
        ) : null}
        {shape.actions.length ? (
          <div className="flex justify-end pt-0.5">
            <ActionBar rowKey={shape.runId} actions={shape.actions} />
          </div>
        ) : null}
      </div>
    </ShapeShell>
  );
}
