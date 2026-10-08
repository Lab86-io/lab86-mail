// Steer notes and their receipts (docs/albatross-threads.md, T7–T9, lead
// decision 5). A note is a user message the thread keeps with
// `metadata.steer = { runId }` and no chat turn. The run view carries
// `notes[]` with read times; a note that a run did not read carries to the
// next run of the step, so receipts match by the message id across runs.
// Pure: no React here.

import type { UIMessage } from 'ai';
import type { ThreadRunView } from './thread-contract';

export interface SteerMetadata {
  runId: string;
  /** Sent after "Stop and redirect": the run stopped and a new one started with this note. */
  redirect?: boolean;
  /** The send failed; "Send again" repeats it. */
  failed?: boolean;
}

export function steerMetadataOf(message: { metadata?: unknown } | null | undefined): SteerMetadata | null {
  const meta = message?.metadata as { steer?: unknown } | undefined;
  const steer = meta?.steer as { runId?: unknown; redirect?: unknown; failed?: unknown } | undefined;
  if (!steer || typeof steer.runId !== 'string' || !steer.runId) return null;
  return {
    runId: steer.runId,
    ...(steer.redirect === true ? { redirect: true } : {}),
    ...(steer.failed === true ? { failed: true } : {}),
  };
}

export function isSteerMessage(message: { role?: string; metadata?: unknown } | null | undefined) {
  return message?.role === 'user' && steerMetadataOf(message) !== null;
}

/** A fresh note id: the thread message id, which the run keeps as `noteId`. */
export function newNoteId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
      : Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  return `note_${random}`;
}

/** The thread message for a note: a normal user bubble, sorted by `createdAt`, with the steer mark. */
export function steerNoteMessage(
  text: string,
  runId: string,
  options: { id?: string; now?: number; redirect?: boolean } = {},
): UIMessage {
  const steer: SteerMetadata = { runId, ...(options.redirect ? { redirect: true } : {}) };
  return {
    id: options.id ?? newNoteId(),
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { createdAt: options.now ?? Date.now(), steer },
  } as UIMessage;
}

/** The same message with the failed mark set or cleared. */
export function withSteerFailed(message: UIMessage, failed: boolean): UIMessage {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const steer = steerMetadataOf(message);
  if (!steer) return message;
  const next: SteerMetadata = { runId: steer.runId, ...(steer.redirect ? { redirect: true } : {}) };
  if (failed) next.failed = true;
  return { ...message, metadata: { ...meta, steer: next } } as UIMessage;
}

export type NoteReceiptKind = 'sent' | 'read' | 'not_read' | 'redirect' | 'failed';

export interface NoteReceipt {
  kind: NoteReceiptKind;
  line: string;
  /** "Send again" shows for a note that no run read, and for a failed send. */
  sendAgain: boolean;
  /** When the run read the note. */
  readAt: number | null;
}

export const NOTE_RECEIPT_COPY = {
  sent: 'Sent to the run',
  read: 'Read by Albatross',
  notRead: 'Not read: the run ended first',
  redirect: 'Stopped the run. Started a new run with this note.',
  failed: 'Not sent',
  sendAgain: 'Send again',
} as const;

const OPEN_STATES = new Set(['running', 'queued']);

type NoteRun = Pick<ThreadRunView, 'id' | 'stepKey' | 'state' | 'createdAt' | 'notes'>;

/**
 * The receipt under a note. Read wins everywhere. Otherwise the note is on its
 * way while the run that holds it, or a newer run of the same step, is still
 * open (unread notes carry over). When every run that could read it has
 * ended, the note was not read, and "Send again" offers to resend it.
 */
export function noteReceipt(
  message: { id: string; metadata?: unknown },
  runs: readonly NoteRun[],
  format: { time: (at: number) => string },
): NoteReceipt | null {
  const steer = steerMetadataOf(message);
  if (!steer) return null;
  if (steer.failed) return { kind: 'failed', line: NOTE_RECEIPT_COPY.failed, sendAgain: true, readAt: null };
  if (steer.redirect)
    return { kind: 'redirect', line: NOTE_RECEIPT_COPY.redirect, sendAgain: false, readAt: null };
  const holders = runs.filter((run) => run.notes.some((note) => note.id === message.id));
  const read = holders
    .flatMap((run) => run.notes.filter((note) => note.id === message.id && note.readAt))
    .map((note) => note.readAt as number)
    .sort((a, b) => a - b)[0];
  if (read)
    return {
      kind: 'read',
      line: `${NOTE_RECEIPT_COPY.read} · ${format.time(read)}`,
      sendAgain: false,
      readAt: read,
    };
  const sentTo = runs.find((run) => run.id === steer.runId) ?? null;
  const stepKeys = new Set([...holders, ...(sentTo ? [sentTo] : [])].map((run) => run.stepKey));
  const openOnStep = runs.some(
    (run) =>
      OPEN_STATES.has(run.state) &&
      (run.id === steer.runId ||
        holders.some((holder) => holder.id === run.id) ||
        (stepKeys.has(run.stepKey) && run.createdAt >= (sentTo?.createdAt ?? 0))),
  );
  if (openOnStep) return { kind: 'sent', line: NOTE_RECEIPT_COPY.sent, sendAgain: false, readAt: null };
  // The note is still in flight: no run knows it yet, and the one it went to is unknown here.
  if (!sentTo && !holders.length)
    return { kind: 'sent', line: NOTE_RECEIPT_COPY.sent, sendAgain: false, readAt: null };
  return { kind: 'not_read', line: NOTE_RECEIPT_COPY.notRead, sendAgain: true, readAt: null };
}
