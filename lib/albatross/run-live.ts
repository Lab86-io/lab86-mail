// The live part of a run. The runner and Convex share these rules.
//
// A log row shows what a run does now. A tool that starts adds an open row in
// the present tense. When the tool ends, its past-tense line takes the place of
// the open row, or the row goes away if the tool reports nothing. So the record
// of a finished run holds only what the run did.

import { truncateText } from '../shared/text';

/** The live writes of one run: at most one in this time. */
export const RUN_LIVE_WRITE_MS = 2_000;
/** The live text of one model step that the small live row keeps. */
export const RUN_LIVE_TEXT_MAX = 4_000;
/** Less text than this waits. A write shows for 2 s, so one word alone looks like a fault. */
const RUN_LIVE_TEXT_MIN = 8;
const RUN_LOG_LINE_MAX = 200;

export interface RunLogRow {
  at: number;
  text: string;
  /** An open row: the tool call that it belongs to. */
  key?: string;
}

/**
 * One change to the log.
 * - `text` alone adds a line.
 * - `key`, `text`, and `open` add or change an open row.
 * - `key` and `text` close the open row with the line. With no open row, the line is added.
 * - `key` alone removes the open row.
 */
export interface RunLogOp {
  key?: string;
  text?: string;
  open?: boolean;
}

export function applyRunLogOps(
  log: readonly RunLogRow[],
  ops: readonly RunLogOp[],
  ts: number,
  max: number,
): RunLogRow[] {
  const rows = [...log];
  ops.forEach((op, index) => {
    const text = op.text?.trim() ? truncateText(op.text.trim(), RUN_LOG_LINE_MAX) : '';
    const at = rows.findIndex((row) => op.key && row.key === op.key);
    // Rows of one write stay in order, and each has its own time.
    const time = ts + index;
    if (at === -1) {
      if (text) rows.push({ at: time, text, ...(op.key && op.open ? { key: op.key } : {}) });
      return;
    }
    if (!text) {
      rows.splice(at, 1);
      return;
    }
    const { at: started } = rows[at];
    rows[at] = { at: started, text, ...(op.open ? { key: op.key } : {}) };
  });
  return rows.slice(-max);
}

/** The record of a run that stopped: an open row was never finished, so it goes. */
export function closeRunLog(log: readonly RunLogRow[]): RunLogRow[] {
  return log.filter((row) => !row.key);
}

/**
 * The part of the model's text that is safe to show now. A word that is not
 * finished can be the start of a secret shape, and `{{` can be the start of a
 * secure reference. Each one waits until it is complete and redaction can see it.
 */
export function showableRunText(text: string, clean: (text: string) => string = (value) => value): string {
  const open = text.lastIndexOf('{{');
  const closed = open === -1 ? -1 : text.indexOf('}}', open);
  const settled = open !== -1 && closed === -1 ? text.slice(0, open) : text;
  const space = settled.search(/\s\S*$/);
  const showable = truncateText(clean(space === -1 ? '' : settled.slice(0, space)).trim(), RUN_LIVE_TEXT_MAX);
  return showable.length < RUN_LIVE_TEXT_MIN ? '' : showable;
}

/** How long the newest row has worked, once that is worth a look. Null before then. */
export function runRowElapsed(ms: number): string | null {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  // Past an hour the clock is wrong, not the run: the time budgets end long before.
  if (seconds < 5 || seconds >= 3_600) return null;
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
