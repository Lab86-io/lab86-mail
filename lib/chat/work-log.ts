// The live work log (docs/chat-agentic-pass.md, section 2): pure helpers that
// group an assistant message's parts into work log blocks, read the block
// state for its header, and label the reasoning line. The React block lives in
// components/ai-elements/work-log.tsx.

import type { ToolShape } from '../ai/tool-shapes';
import {
  isHitlToolName,
  type ToolActivityState,
  toolActivityState,
  toolPartName,
} from '../albatross/teach-ui';

export interface WorkLogRow {
  toolCallId: string;
  toolName: string;
  /** The AI SDK tool part (`tool-<name>` or `dynamic-tool`). */
  part: any;
  /** The `data-tool-shape` payload for this call, when the server sent one. */
  shape: ToolShape | null;
  state: ToolActivityState;
}

export type MessageSegment =
  | { kind: 'part'; index: number; part: any }
  | { kind: 'work-log'; key: string; rows: WorkLogRow[] };

function isToolPart(part: any): boolean {
  const type = part?.type;
  return type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'));
}

function isBlankText(part: any): boolean {
  return part?.type === 'text' && !String(part.text || '').trim();
}

/**
 * Group parts into segments. Consecutive non-HITL tool parts form one work
 * log; a `data-tool-shape` part attaches to the row whose toolCallId matches
 * its id. Blank text parts and step markers do not break a run. HITL tools
 * (ask_*) stay standalone parts and render in place, as before.
 */
export function groupMessageParts(parts: any[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let run: WorkLogRow[] | null = null;
  const rowsById = new Map<string, WorkLogRow>();

  const closeRun = () => {
    if (run?.length) segments.push({ kind: 'work-log', key: run[0].toolCallId, rows: run });
    run = null;
  };

  (parts || []).forEach((part, index) => {
    if (!part || typeof part.type !== 'string') return;
    if (part.type === 'data-tool-shape') {
      const row = rowsById.get(String(part.id ?? ''));
      if (row && part.data && typeof part.data === 'object') row.shape = part.data as ToolShape;
      return;
    }
    if (part.type === 'step-start' || isBlankText(part)) return;
    if (isToolPart(part)) {
      const toolName = toolPartName(part);
      if (isHitlToolName(toolName)) {
        closeRun();
        segments.push({ kind: 'part', index, part });
        return;
      }
      const row: WorkLogRow = {
        toolCallId: String(part.toolCallId || `${toolName}-${index}`),
        toolName,
        part,
        shape: null,
        state: toolActivityState(part.state || 'input-available', part.output),
      };
      rowsById.set(row.toolCallId, row);
      if (!run) run = [];
      run.push(row);
      return;
    }
    closeRun();
    segments.push({ kind: 'part', index, part });
  });
  closeRun();
  return segments;
}

export interface WorkLogHeader {
  text: string;
  /** A tool still runs: the header shows the leading indicator. */
  running: boolean;
  failed: number;
}

/** A stopped or disconnected turn cannot leave its unfinished tools spinning. */
export function settleWorkLogRows(rows: WorkLogRow[], finished: boolean): WorkLogRow[] {
  if (!finished) return rows;
  return rows.map((row) =>
    row.state === 'running'
      ? {
          ...row,
          state: 'failed',
          part: {
            ...row.part,
            state: 'output-error',
            errorText: row.part.errorText || 'This step ended before a result was received.',
          },
        }
      : row,
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** The header text for a block, per the state table in the contract. */
export function workLogHeader(rows: WorkLogRow[], finished: boolean, durationMs?: number): WorkLogHeader {
  const failed = rows.filter((row) => row.state === 'failed').length;
  const running = rows.some((row) => row.state === 'running');
  if (failed) return { text: plural(failed, 'step failed', 'steps failed'), running: false, failed };
  if (running) return { text: 'Working', running: true, failed: 0 };
  const did = `Did ${plural(rows.length, 'thing', 'things')}`;
  if (finished && durationMs != null && durationMs > 0) {
    return { text: `${did} · ${formatDuration(durationMs)}`, running: false, failed: 0 };
  }
  return { text: did, running: false, failed: 0 };
}

/** Collapse to the header: turn finished, three or more rows, none failed. */
export function shouldCollapseWorkLog(rows: WorkLogRow[], finished: boolean): boolean {
  if (!finished || rows.length < 3) return false;
  return rows.every((row) => row.state === 'done');
}

/** `Thought` while streaming, `Thought for 3s` once done and timed. */
export function reasoningLabel(live: boolean, durationMs?: number): string {
  if (live) return 'Thought';
  if (durationMs != null && durationMs > 0) return `Thought for ${formatDuration(durationMs)}`;
  return 'Thought';
}

/**
 * A cheap signature of the transcript's tool activity. Text deltas change the
 * messages identity on every chunk; effects that only care about tool calls
 * key on this string instead so typing and streaming text do no extra work.
 */
export function toolPartSignature(messages: Array<{ id?: string; parts?: any[] }>): string {
  const last = messages[messages.length - 1];
  const parts = Array.isArray(last?.parts) ? last.parts : [];
  const states: string[] = [];
  for (const part of parts) {
    if (!isToolPart(part)) continue;
    states.push(`${part.toolCallId || ''}=${part.state || ''}`);
  }
  return `${messages.length}|${last?.id || ''}|${parts.length}|${states.join(',')}`;
}
