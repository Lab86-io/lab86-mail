import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import {
  isSteerMessage,
  NOTE_RECEIPT_COPY,
  noteReceipt,
  steerMetadataOf,
  steerNoteMessage,
  withSteerFailed,
} from '../lib/albatross/thread-notes';

// Receipts under a sent note (docs/albatross-threads.md, T7–T9, lead decision
// 5): sent, read, not read with Send again, the redirect line, and a failed send.

const NOW = Date.UTC(2026, 9, 8, 14, 40, 0);
const time = (at: number) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(at);

type Note = { id: string | null; at: number; text: string; readAt: number | null };

function run(over: {
  id: string;
  state: 'queued' | 'running' | 'handed_off' | 'done' | 'failed' | 'cancelled';
  stepKey?: string;
  createdAt?: number;
  notes?: Note[];
}) {
  return {
    id: over.id,
    stepKey: over.stepKey ?? 'step-2',
    state: over.state,
    createdAt: over.createdAt ?? NOW - 60_000,
    notes: over.notes ?? [],
  };
}

describe('the note message', () => {
  test('is a user bubble with the steer mark and a time, and no chat turn', () => {
    const message = steerNoteMessage('Use the two-year option', 'run_1', { id: 'note_1', now: NOW });
    expect(message.role).toBe('user');
    expect(message.id).toBe('note_1');
    expect(message.parts).toEqual([{ type: 'text', text: 'Use the two-year option' }]);
    expect(message.metadata).toEqual({ createdAt: NOW, steer: { runId: 'run_1' } });
    expect(isSteerMessage(message)).toBe(true);
    expect(isSteerMessage({ role: 'user', metadata: { createdAt: NOW } })).toBe(false);
    expect(steerMetadataOf(steerNoteMessage('x', 'run_1', { redirect: true }))).toEqual({
      runId: 'run_1',
      redirect: true,
    });
    expect(steerNoteMessage('x', 'run_1').id.startsWith('note_')).toBe(true);
  });

  test('the failed mark is set and cleared without a loss of the other metadata', () => {
    const message = steerNoteMessage('x', 'run_1', { id: 'note_1', now: NOW });
    const failed = withSteerFailed(message, true);
    expect(steerMetadataOf(failed)).toEqual({ runId: 'run_1', failed: true });
    expect((failed.metadata as { createdAt: number }).createdAt).toBe(NOW);
    expect(steerMetadataOf(withSteerFailed(failed, false))).toEqual({ runId: 'run_1' });
    expect(withSteerFailed({ id: 'm', role: 'user', parts: [] } as UIMessage, true).metadata).toBeUndefined();
  });
});

describe('the receipt', () => {
  const message = steerNoteMessage('Use the two-year option', 'run_1', { id: 'note_1', now: NOW - 30_000 });
  const note = (readAt: number | null): Note => ({ id: 'note_1', at: NOW - 30_000, text: 'x', readAt });

  test('a plain message has none', () => {
    expect(noteReceipt({ id: 'm', metadata: { createdAt: NOW } }, [], { time })).toBeNull();
  });

  test('"Sent to the run" while the run that holds it, or the one it went to, is open', () => {
    expect(
      noteReceipt(message, [run({ id: 'run_1', state: 'running', notes: [note(null)] })], { time }),
    ).toEqual({
      kind: 'sent',
      line: NOTE_RECEIPT_COPY.sent,
      sendAgain: false,
      readAt: null,
    });
    // In flight: the run does not know the note yet.
    expect(noteReceipt(message, [run({ id: 'run_1', state: 'queued' })], { time })?.kind).toBe('sent');
    expect(noteReceipt(message, [], { time })?.kind).toBe('sent');
  });

  test('"Read by Albatross" with the time once any run read it', () => {
    const receipt = noteReceipt(
      message,
      [run({ id: 'run_1', state: 'running', notes: [note(Date.UTC(2026, 9, 8, 14, 40, 0))] })],
      { time },
    );
    expect(receipt).toEqual({
      kind: 'read',
      line: 'Read by Albatross · 2:40 PM',
      sendAgain: false,
      readAt: Date.UTC(2026, 9, 8, 14, 40, 0),
    });
  });

  test('an unread note carries to the next run of the step: still "Sent to the run"', () => {
    const receipt = noteReceipt(
      message,
      [
        run({ id: 'run_1', state: 'done', createdAt: NOW - 90_000, notes: [note(null)] }),
        run({ id: 'run_2', state: 'running', createdAt: NOW - 10_000 }),
      ],
      { time },
    );
    expect(receipt?.kind).toBe('sent');
    // Read by the next run: matched by id across runs.
    const read = noteReceipt(
      message,
      [
        run({ id: 'run_1', state: 'done', createdAt: NOW - 90_000, notes: [note(null)] }),
        run({ id: 'run_2', state: 'running', createdAt: NOW - 10_000, notes: [note(NOW - 5_000)] }),
      ],
      { time },
    );
    expect(read?.kind).toBe('read');
  });

  test('"Not read: the run ended first" with Send again when no run can read it', () => {
    const receipt = noteReceipt(message, [run({ id: 'run_1', state: 'done', notes: [note(null)] })], {
      time,
    });
    expect(receipt).toEqual({
      kind: 'not_read',
      line: NOTE_RECEIPT_COPY.notRead,
      sendAgain: true,
      readAt: null,
    });
    // A run of another step does not count.
    expect(
      noteReceipt(
        message,
        [
          run({ id: 'run_1', state: 'cancelled', notes: [note(null)] }),
          run({ id: 'run_9', state: 'running', stepKey: 'step-3' }),
        ],
        { time },
      )?.kind,
    ).toBe('not_read');
  });

  test('the redirect line and the failed line', () => {
    const redirect = steerNoteMessage('Choose Saturday', 'run_1', { redirect: true });
    expect(noteReceipt(redirect, [], { time })).toEqual({
      kind: 'redirect',
      line: NOTE_RECEIPT_COPY.redirect,
      sendAgain: false,
      readAt: null,
    });
    const failed = withSteerFailed(message, true);
    expect(noteReceipt(failed, [run({ id: 'run_1', state: 'running' })], { time })).toEqual({
      kind: 'failed',
      line: NOTE_RECEIPT_COPY.failed,
      sendAgain: true,
      readAt: null,
    });
  });
});
