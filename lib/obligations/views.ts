// Needs you, phases 3 and 5 (docs/needs-you-phases-2-5.md, S2): pure helpers
// for the readers of the ledger. Convex (convex/obligationViews.ts), the brief
// region (lib/obligations/brief-region.ts), and "Start in Albatross"
// (lib/obligations/albatross.ts) use them.

import { truncateText } from '../shared/text';
import {
  CLOSED_STATES,
  type ObligationClosedNote,
  type ObligationCloseReason,
  type ObligationKind,
  type ObligationState,
  type ObligationView,
} from './contract';

/** Close reasons that come from the source, not from a user action. */
export const CLOSED_BY_ITSELF_REASONS: readonly ObligationCloseReason[] = [
  'evidence',
  'expired',
  'event_passed',
  'aged_out',
];

export function isOpenObligation(view: Pick<ObligationView, 'state'>): boolean {
  return !CLOSED_STATES.includes(view.state);
}

/**
 * True when a row closed without a user action ("Closed by itself"). A code
 * never counts: it closes in minutes and has no place in the brief.
 */
export function closedByItself(row: {
  kind: ObligationKind;
  state: ObligationState;
  closeReason?: ObligationCloseReason | string;
  closedBy?: 'user' | 'source' | string;
}): boolean {
  if (row.kind === 'code' || row.closedBy === 'user' || !CLOSED_STATES.includes(row.state)) return false;
  return CLOSED_BY_ITSELF_REASONS.includes(row.closeReason as ObligationCloseReason);
}

/** The brief's note for one closed item. */
export function closedNoteOf(view: ObligationView): ObligationClosedNote {
  return {
    id: view.id,
    title: view.title,
    asker: view.asker,
    source: view.source,
    closeReason: view.closeReason ?? 'evidence',
    closedAt: view.closedAt ?? view.updatedAt,
  };
}

/** Time order for the Work thread: the oldest first, so the newest is last. */
export function threadTimeOrder(
  a: Pick<ObligationView, 'id' | 'createdAt'>,
  b: Pick<ObligationView, 'id' | 'createdAt'>,
): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** The fields of an Albatross (`albatrossIntents`) that decide if it can take an item. */
export interface WorkLike {
  title?: string;
  rawText?: string;
  status?: string;
  workState?: string;
}

const CLOSED_WORK = new Set(['done', 'archived', 'released']);

/** True when the Albatross is done, put down, or archived. */
export function isClosedWork(work: WorkLike): boolean {
  return CLOSED_WORK.has(String(work.status || '')) || CLOSED_WORK.has(String(work.workState || ''));
}

/** The title of an Albatross for an obligation row: its title, else the start of its text. */
export function workTitleOf(work: WorkLike): string {
  const text = String(work.title || work.rawText || '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateText(text, 180) || 'Albatross';
}
