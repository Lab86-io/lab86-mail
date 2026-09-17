'use client';

import type { ReactNode } from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { Steps, StepsContent, StepsTrigger } from '@/components/odysseyui/steps';
import {
  ThoughtChain,
  ThoughtChainContent,
  ThoughtChainItem,
  ThoughtChainStep,
  ThoughtChainTrigger,
} from '@/components/odysseyui/thought-chain';
import { toolActivityLine } from '@/lib/albatross/teach-ui';
import {
  settleWorkLogRows,
  shouldCollapseWorkLog,
  type WorkLogRow,
  workLogHeader,
} from '@/lib/chat/work-log';
import { ShapeCard } from './shapes/shape-card';
import { TOOL_UI_RENDERED_TOOLS } from './tool-ui-part';

export type RenderRichTool = (toolName: string, output: any) => ReactNode;

export interface WorkLogProps {
  rows: WorkLogRow[];
  /** The assistant turn is over: header shows the duration, block may collapse. */
  finished: boolean;
  /** Renders a successful show_* output with its designed component. */
  renderRich?: RenderRichTool;
  now?: () => number;
}

function WorkLogComponent({ rows: inputRows, finished, renderRich, now = Date.now }: WorkLogProps) {
  const rows = settleWorkLogRows(inputRows, finished);
  // Timing: a block that mounts mid-turn measures itself; a block restored
  // from history has no start and shows no duration.
  const [startedAt] = useState<number | null>(() => (finished ? null : now()));
  const [durationMs, setDurationMs] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (finished && startedAt != null && durationMs == null) setDurationMs(Math.max(1, now() - startedAt));
  }, [finished, startedAt, durationMs, now]);

  const header = workLogHeader(rows, finished, durationMs);
  const collapsible = shouldCollapseWorkLog(rows, finished);
  const [open, setOpen] = useState(!collapsible);
  const touchedRef = useRef(false);
  const wasCollapsibleRef = useRef(collapsible);
  useEffect(() => {
    if (collapsible && !wasCollapsibleRef.current && !touchedRef.current) setOpen(false);
    wasCollapsibleRef.current = collapsible;
  }, [collapsible]);

  return (
    <Steps
      data-slot="work-log"
      className="min-w-0 py-1"
      data-work-state={header.running ? 'working' : header.failed ? 'failed' : finished ? 'finished' : 'done'}
      open={open}
      onOpenChange={(next) => {
        touchedRef.current = true;
        setOpen(next);
      }}
    >
      <StepsTrigger
        active={header.running}
        className={header.failed ? 'text-[var(--color-danger)]' : undefined}
      >
        {header.text}
      </StepsTrigger>
      <StepsContent forceMount className="data-[state=closed]:hidden" bar={<span />}>
        <ThoughtChain>
          {rows.map((row) => (
            <WorkLogRowView key={row.toolCallId} row={row} renderRich={renderRich} />
          ))}
        </ThoughtChain>
      </StepsContent>
    </Steps>
  );
}

export const WorkLog = memo(WorkLogComponent);
WorkLog.displayName = 'WorkLog';

function WorkLogRowView({
  row,
  renderRich,
  _isLast,
}: {
  row: WorkLogRow;
  renderRich?: RenderRichTool;
  _isLast?: boolean;
}) {
  const part = row.part;
  const state = part.state || 'input-available';
  const activity = toolActivityLine(row.toolName, part.input, state, part.output, part.errorText);
  const rich =
    row.state === 'done' && TOOL_UI_RENDERED_TOOLS.has(row.toolName) && part.output?.ok && renderRich
      ? renderRich(row.toolName, part.output)
      : null;
  const content = rich ?? (row.shape ? <ShapeCard shape={row.shape} /> : null);
  return (
    <ThoughtChainStep
      _isLast={_isLast}
      data-tool={row.toolName}
      data-tone={row.state}
      status={row.state === 'running' ? 'active' : row.state === 'failed' ? 'failed' : 'done'}
    >
      <ThoughtChainTrigger expandable={content != null || Boolean(part.errorText)}>
        {row.shape?.activity?.[row.state] ?? activity.text}
      </ThoughtChainTrigger>
      <ThoughtChainContent>
        {row.state === 'failed' && part.errorText ? (
          <ThoughtChainItem>
            <span className="text-[var(--color-danger)]">{part.errorText}</span>
          </ThoughtChainItem>
        ) : null}
        {content != null ? <div className="assistant-tool-result pt-1.5">{content}</div> : null}
      </ThoughtChainContent>
    </ThoughtChainStep>
  );
}
