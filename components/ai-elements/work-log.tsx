'use client';

// The live work log (docs/chat-agentic-pass.md, section 2), built on
// @ai-elements/chain-of-thought for the block (header, rule, steps) and
// @ai-elements/tool for each call's row and its collapsible content. One row
// per tool call; the row text is the activity sentence; a running row shows
// the loader glyph, a done row a check, a failed row a cross and danger text.
// The shape card or the designed show_* component renders under its row,
// inside the rule. The header reads the group state; after the turn a block
// of three or more rows with no failure collapses to the header.

import type { ReactNode } from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { toolActivityLine } from '@/lib/albatross/teach-ui';
import {
  settleWorkLogRows,
  shouldCollapseWorkLog,
  type WorkLogRow,
  workLogHeader,
} from '@/lib/chat/work-log';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from './chain-of-thought';
import { RevealDot } from './reveal-dot';
import { ShapeCard } from './shapes/shape-card';
import { Shimmer } from './shimmer';
import { Tool, ToolContent, ToolHeader, toolGlyph } from './tool';
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
    <ChainOfThought
      data-slot="work-log"
      data-state={header.running ? 'working' : header.failed ? 'failed' : finished ? 'finished' : 'done'}
      open={open}
      onOpenChange={(next) => {
        touchedRef.current = true;
        setOpen(next);
      }}
    >
      <ChainOfThoughtHeader disclosure={finished}>
        {header.running ? (
          <>
            <Shimmer as="span" className="text-[12px]">
              Working
            </Shimmer>
            <RevealDot />
          </>
        ) : (
          <span className={header.failed ? 'text-[var(--color-danger)]' : undefined}>{header.text}</span>
        )}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent forceMount className="data-[state=closed]:hidden">
        {rows.map((row) => (
          <WorkLogRowView key={row.toolCallId} row={row} renderRich={renderRich} />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export const WorkLog = memo(WorkLogComponent);
WorkLog.displayName = 'WorkLog';

function WorkLogRowView({ row, renderRich }: { row: WorkLogRow; renderRich?: RenderRichTool }) {
  const part = row.part;
  const state = part.state || 'input-available';
  const activity = toolActivityLine(row.toolName, part.input, state, part.output, part.errorText);
  const rich =
    row.state === 'done' && TOOL_UI_RENDERED_TOOLS.has(row.toolName) && part.output?.ok && renderRich
      ? renderRich(row.toolName, part.output)
      : null;
  const content = rich ?? (row.shape ? <ShapeCard shape={row.shape} /> : null);
  return (
    <ChainOfThoughtStep
      data-tool={row.toolName}
      data-tone={row.state}
      icon={toolGlyph(row.state)}
      status={row.state === 'running' ? 'active' : 'complete'}
      label={
        <Tool defaultOpen>
          <ToolHeader
            title={row.shape?.activity?.[row.state] ?? activity.text}
            type={part.type}
            state={state}
            output={part.output}
            expandable={content != null}
          />
          {row.state === 'failed' && part.errorText ? (
            <p className="break-words text-[11.5px] text-[var(--color-danger)]">{part.errorText}</p>
          ) : null}
          {content != null ? (
            <ToolContent forceMount className="data-[state=closed]:hidden">
              <div className="pt-1.5">{content}</div>
            </ToolContent>
          ) : null}
        </Tool>
      }
    />
  );
}
