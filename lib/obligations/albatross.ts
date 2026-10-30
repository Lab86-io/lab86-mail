// "Start in Albatross" (docs/needs-you-phases-2-5.md, S2 item 2):
//   POST /api/obligations/[id]/albatross
//   POST /api/mobile/v1/needs-you/[id]/albatross
// With a `workId` on the item, the item goes into that Albatross: its Work
// thread shows the item (convex/obligationViews.ts forWork), and a run gets
// the item as its note (the run start rules of lib/albatross/step-run-start.ts
// apply). Without one, or when that Albatross is closed, a new Albatross
// starts from the item through the capture path. The item then carries the
// `workId`. The routes give the dependencies, so the tests run this without a
// network.

import { redactSecretShapes } from '../secure/redact';
import { truncateText } from '../shared/text';
import { OBLIGATION_SOURCE_LABELS, type ObligationAlbatrossResponse, type ObligationView } from './contract';
import { ObligationApiError, type ObligationCaller, type ObligationRecord } from './service';
import { isOpenObligation } from './views';

/** What `api.obligationViews.linkWork` gives. */
export type ObligationLinkResult =
  | { ok: true; obligation: ObligationView; workTitle: string }
  | { ok: false; error: 'not_found' | 'work_missing' | 'work_closed' };

export interface ObligationAlbatrossDependencies {
  /** LAB86_NEEDS_YOU for the caller. */
  flag(userId: string): boolean;
  get(userId: string, id: string): Promise<ObligationRecord | null>;
  link(input: { userId: string; id: string; workId: string }): Promise<ObligationLinkResult>;
  /** The runs of an Albatross, oldest first (`albatrossStepRuns.runsForWorkHistory`). */
  runs(userId: string, workId: string): Promise<Array<{ id: string; state: string }>>;
  /** A note to a run that works now. False when the run is no longer open. */
  steer(input: { userId: string; runId: string; note: string }): Promise<boolean>;
  /** Starts a run with the note, by the user's run start rules. Throws when a rule refuses it. */
  startRun(input: { userId: string; workId: string; note: string }): Promise<{ runId: string | null }>;
  /** A new Albatross from one reviewed item (the capture path, no split). */
  capture(caller: ObligationCaller, item: { title: string; rawText: string }): Promise<{ workIds: string[] }>;
}

/** The longest note a run reads (the steer cap). */
export const OBLIGATION_RUN_NOTE_MAX = 2_000;

function oneLine(value: string | undefined, max: number) {
  return truncateText(
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

/**
 * The text that the Albatross gets: the item, who asked, where, why, and a
 * link. A secret shape in the source text never reaches a run or a capture.
 */
export function obligationAlbatrossText(view: ObligationView): { title: string; note: string } {
  const title = oneLine(view.title, 180) || 'Needs you';
  const place = [OBLIGATION_SOURCE_LABELS[view.source], oneLine(view.sourceLabel, 120)]
    .filter(Boolean)
    .join(', ');
  const lines = [
    `Needs you: ${oneLine(view.title, 300)}`,
    `From ${oneLine(view.asker, 180) || 'an unknown sender'} (${place}).`,
    view.why ? oneLine(view.why, 300) : '',
    view.excerpt ? `Excerpt: "${oneLine(view.excerpt, 600)}"` : '',
    view.accountId && view.threadId
      ? `Mail thread ${view.threadId} in account ${view.accountId}${view.messageId ? `, message ${view.messageId}` : ''}.`
      : '',
    view.eventId ? `Calendar event ${view.eventId}.` : '',
    view.url ? `Link: ${view.url}` : '',
    'Handle this item as part of this Albatross.',
  ].filter(Boolean);
  return {
    title,
    note: truncateText(redactSecretShapes(lines.join('\n')).text, OBLIGATION_RUN_NOTE_MAX),
  };
}

const OPEN_RUN = new Set(['queued', 'running']);

/**
 * The item reaches a run: a note to the run that works now, else a new run
 * with the note. A refused or failed start leaves the item in the thread
 * without a run; the user can still press "Handle it" there.
 */
async function runWithItem(
  userId: string,
  workId: string,
  note: string,
  deps: ObligationAlbatrossDependencies,
): Promise<string | undefined> {
  try {
    const runs = await deps.runs(userId, workId);
    const open = [...runs].reverse().find((run) => OPEN_RUN.has(run.state));
    if (open && (await deps.steer({ userId, runId: open.id, note }))) return open.id;
    const started = await deps.startRun({ userId, workId, note });
    return started.runId || undefined;
  } catch (error) {
    console.warn('[obligations] the run did not start', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return undefined;
  }
}

/**
 * "Start in Albatross". Not in the flag, or another user's id: 404. A code:
 * 400. A closed item: 409.
 */
export async function startObligationInAlbatross(
  caller: ObligationCaller,
  id: string,
  deps: ObligationAlbatrossDependencies,
): Promise<ObligationAlbatrossResponse> {
  if (!deps.flag(caller.userId)) throw new ObligationApiError('Not found.', 404);
  const record = await deps.get(caller.userId, id);
  if (!record) throw new ObligationApiError('Not found.', 404);
  const view = record.obligation;
  if (view.kind === 'code') throw new ObligationApiError('A sign-in code cannot start an Albatross.', 400);
  if (!isOpenObligation(view)) throw new ObligationApiError('This item is already closed.', 409);
  const text = obligationAlbatrossText(view);

  if (view.workId) {
    const linked = await deps.link({ userId: caller.userId, id, workId: view.workId });
    if (linked.ok) {
      const runId = await runWithItem(caller.userId, view.workId, text.note, deps);
      return {
        workId: view.workId,
        created: false,
        obligation: linked.obligation,
        ...(runId ? { runId } : {}),
      };
    }
    if (linked.error === 'not_found') throw new ObligationApiError('Not found.', 404);
    // The Albatross is gone or closed: a new one starts from the item.
  }

  const captured = await deps.capture(caller, { title: text.title, rawText: text.note });
  const workId = captured.workIds[0];
  if (!workId) throw new ObligationApiError('The Albatross did not start. Try again.', 502);
  const linked = await deps.link({ userId: caller.userId, id, workId });
  if (!linked.ok) {
    if (linked.error === 'not_found') throw new ObligationApiError('Not found.', 404);
    throw new ObligationApiError('The Albatross did not start. Try again.', 502);
  }
  return { workId, created: true, obligation: linked.obligation };
}
