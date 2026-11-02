// The one path for a run's log rows and live text. Each write re-runs the live
// queries that read the run, so the writer sends at most one write in
// RUN_LIVE_WRITE_MS. The first write goes at once. Rows wait in order, and a
// tool that ends before its open row went out writes nothing extra.

import { RUN_LIVE_WRITE_MS, type RunLogOp, showableRunText } from './run-live';

export interface RunLivePayload {
  lines?: RunLogOp[];
  /** The model's text so far in this step. Null clears it. */
  liveText?: string | null;
}

export interface RunLiveWriterInput {
  write: (payload: RunLivePayload) => Promise<unknown>;
  /** Redaction of a saved value and a secret shape. */
  clean?: (text: string) => string;
  now?: () => number;
  minIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface RunLiveWriter {
  /** A line. With the key of an open row, the line takes the place of that row. */
  line(text: string, key?: string): void;
  openTool(key: string, text: string): void;
  /** The tool ended. An open row that no line replaced goes away. */
  closeTool(key: string): void;
  textDelta(delta: string): void;
  /** The model step ended with no message: its text goes. */
  clearText(): void;
  /** A message took over on the server: nothing more to send for this text. */
  forgetText(): void;
  /** Send what waits, and wait for the writes that are out. */
  flush(): Promise<void>;
  /** End the timer. A run that ended writes nothing later. */
  stop(): void;
}

export function createRunLiveWriter(input: RunLiveWriterInput): RunLiveWriter {
  const now = input.now ?? Date.now;
  const minIntervalMs = input.minIntervalMs ?? RUN_LIVE_WRITE_MS;
  const setTimer =
    input.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    });
  const clearTimer = input.clearTimer ?? ((timer: unknown) => clearTimeout(timer as never));
  const openKeys = new Set<string>();
  let lines: RunLogOp[] = [];
  let text = '';
  let sentText: string | null = null;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const nextText = (): { liveText?: string | null } => {
    const showable = showableRunText(text, input.clean);
    const next = showable || null;
    return next === sentText ? {} : { liveText: next };
  };

  const send = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const payload: RunLivePayload = { ...(lines.length ? { lines } : {}), ...nextText() };
    lines = [];
    if (!payload.lines && payload.liveText === undefined) return;
    if (payload.liveText !== undefined) sentText = payload.liveText;
    lastWriteAt = now();
    chain = chain.then(() => input.write(payload)).catch(() => undefined);
  };

  const schedule = () => {
    if (stopped || timer !== null) return;
    const wait = minIntervalMs - (now() - lastWriteAt);
    if (wait <= 0) send();
    else
      timer = setTimer(() => {
        timer = null;
        send();
      }, wait);
  };

  return {
    line(value, key) {
      if (!value.trim()) return;
      if (key && openKeys.delete(key)) {
        // Its open row still waits here: the line goes out as a plain line.
        const waiting = lines.findIndex((op) => op.key === key && op.open);
        if (waiting !== -1) lines[waiting] = { text: value };
        else lines.push({ key, text: value });
      } else lines.push({ text: value });
      schedule();
    },
    openTool(key, value) {
      openKeys.add(key);
      lines.push({ key, text: value, open: true });
      schedule();
    },
    closeTool(key) {
      if (!openKeys.delete(key)) return;
      const waiting = lines.findIndex((op) => op.key === key && op.open);
      if (waiting !== -1) {
        lines.splice(waiting, 1);
        return;
      }
      lines.push({ key });
      schedule();
    },
    textDelta(delta) {
      if (!delta) return;
      text += delta;
      schedule();
    },
    clearText() {
      text = '';
      if (sentText !== null) schedule();
    },
    forgetText() {
      text = '';
      sentText = null;
    },
    async flush() {
      send();
      await chain;
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
