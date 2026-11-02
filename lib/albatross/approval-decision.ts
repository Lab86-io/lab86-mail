// One decision on one queued approval, for every web surface that shows it:
// the Needs you page, the Notifications page, the thread, and later Today. The
// live queue drops a decided row at once, so the words of the outcome live
// here, by approval id. The row and its detail read the same record, so one
// press shows in both, and a second press does nothing.

import { create } from 'zustand';
import { callTool } from '../api-client';

export type ApprovalChoice = 'approve' | 'decline';

/** What this client did. The server row overrides it when the two disagree. */
export type LocalApprovalDecision =
  | { state: 'deciding'; choice: ApprovalChoice; at: number }
  | { state: 'approved'; at: number; goesOn: boolean }
  | { state: 'declined'; at: number }
  | { state: 'failed'; message: string; at: number };

/** The approval as a surface knows it. */
export interface ApprovalRef {
  id: string;
  status: string;
  kind?: string;
}

export type ApprovalViewState = 'waiting' | 'deciding' | 'approved' | 'declined' | 'failed' | 'closed';

export type ApprovalTone = 'plain' | 'hot' | 'done';

export interface ApprovalView {
  state: ApprovalViewState;
  /** True only when one press can reach the server: never while a call is in flight. */
  canDecide: boolean;
  /** The short word for a row's end. */
  word: string;
  tone: ApprovalTone;
  /** What happened, in one sentence. Null while the row waits. */
  line: string | null;
}

export const APPROVAL_COPY = {
  approve: 'Approve',
  decline: 'Decline',
  word: { waiting: 'Your turn', deciding: 'In progress', approved: 'Approved', declined: 'Declined' },
  failedWord: 'Did not finish',
  approving: 'Albatross sends it now.',
  declining: 'Albatross closes it now.',
  declined: 'Declined. Nothing went out.',
  goesOn: 'Albatross goes on with the next part.',
  failed: 'The action could not finish. Try again.',
  expired: 'This approval expired. Nothing went out.',
  undone: 'Undone.',
  note: 'It goes out only after you approve it.',
  fallback: 'Check what goes out before you approve it.',
} as const;

/**
 * The queue's sentence in two parts: what goes out and to whom, and where it
 * came from. An older row can have only the second part.
 */
export function approvalDetailParts(detail: string | null | undefined): {
  what: string;
  from: string | null;
} {
  const text = detail?.trim() ?? '';
  const at = text.search(/(^|\s)From the (goal|step) "/);
  if (at < 0) return { what: text, from: null };
  return { what: text.slice(0, at).trim(), from: text.slice(at).trim() };
}

/** The line of a narrow row: the people by name, so every name fits before the addresses do. */
export function approvalRowLine(detail: string | null | undefined): string {
  const { what, from } = approvalDetailParts(detail);
  return what.replace(/\s*<[^<>\s]+@[^<>\s]+>/g, '') || from || '';
}

function wentOutSentence(kind: string | undefined): string {
  switch (kind) {
    case 'calendar_invite':
      return 'Approved. The invite went out.';
    case 'calendar_rsvp':
      return 'Approved. Your answer went out.';
    case 'email_send':
      return 'Approved. The email went out.';
    default:
      return 'Approved. It went out.';
  }
}

function approved(kind: string | undefined, goesOn: boolean): ApprovalView {
  return {
    state: 'approved',
    canDecide: false,
    word: APPROVAL_COPY.word.approved,
    tone: 'done',
    line: goesOn ? `${wentOutSentence(kind)} ${APPROVAL_COPY.goesOn}` : wentOutSentence(kind),
  };
}

const DECLINED: ApprovalView = {
  state: 'declined',
  canDecide: false,
  word: APPROVAL_COPY.word.declined,
  tone: 'plain',
  line: APPROVAL_COPY.declined,
};

function inProgress(line: string): ApprovalView {
  return { state: 'deciding', canDecide: false, word: APPROVAL_COPY.word.deciding, tone: 'plain', line };
}

/** The state of one approval from the server row and this client's record. A final server row wins. */
export function approvalView(approval: ApprovalRef, local?: LocalApprovalDecision | null): ApprovalView {
  const goesOn = local?.state === 'approved' && local.goesOn;
  switch (approval.status) {
    case 'approved':
      return approved(approval.kind, goesOn);
    case 'rejected':
      return DECLINED;
    case 'expired':
      return {
        state: 'closed',
        canDecide: false,
        word: 'Expired',
        tone: 'plain',
        line: APPROVAL_COPY.expired,
      };
    case 'undone':
      return { state: 'closed', canDecide: false, word: 'Undone', tone: 'plain', line: APPROVAL_COPY.undone };
    default:
      break;
  }
  if (local?.state === 'approved') return approved(approval.kind, goesOn);
  if (local?.state === 'declined') return DECLINED;
  if (local?.state === 'deciding') {
    return inProgress(local.choice === 'approve' ? APPROVAL_COPY.approving : APPROVAL_COPY.declining);
  }
  // Another client or tab holds the call: this one offers no second press.
  if (approval.status === 'claiming') return inProgress(APPROVAL_COPY.approving);
  if (local?.state === 'failed') {
    return {
      state: 'failed',
      canDecide: true,
      word: APPROVAL_COPY.failedWord,
      tone: 'hot',
      line: local.message,
    };
  }
  return { state: 'waiting', canDecide: true, word: APPROVAL_COPY.word.waiting, tone: 'plain', line: null };
}

type ApprovalCaller = (name: string, args: Record<string, unknown>) => Promise<any>;

interface ApprovalDecisionState {
  decisions: Readonly<Record<string, LocalApprovalDecision>>;
  /** The tool call. A preview or a test replaces it. */
  call: ApprovalCaller;
}

export const useApprovalDecisions = create<ApprovalDecisionState>(() => ({
  decisions: {},
  call: (name, args) => callTool(name, args),
}));

function record(id: string, decision: LocalApprovalDecision) {
  useApprovalDecisions.setState((state) => ({ decisions: { ...state.decisions, [id]: decision } }));
}

/**
 * Sends one decision through the same tools as iOS. The failure message is the
 * one the tool route wrote, and the row can try again.
 */
export async function decideApproval(approval: ApprovalRef, choice: ApprovalChoice): Promise<void> {
  const { decisions, call } = useApprovalDecisions.getState();
  if (!approvalView(approval, decisions[approval.id]).canDecide) return;
  record(approval.id, { state: 'deciding', choice, at: Date.now() });
  try {
    if (choice === 'approve') {
      const result = await call('albatross_approve_action', { approvalId: approval.id });
      record(approval.id, {
        state: 'approved',
        at: Date.now(),
        goesOn: result?.followUp?.action === 'continued',
      });
    } else {
      await call('albatross_reject_action', { approvalId: approval.id });
      record(approval.id, { state: 'declined', at: Date.now() });
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : APPROVAL_COPY.failed;
    record(approval.id, { state: 'failed', message, at: Date.now() });
  }
}

/** A decided row stays in its list this long, so it can say what happened. */
export const DECIDED_ROW_MS = 5 * 60_000;

/**
 * The list with the rows the user just decided. The live queue drops a row at
 * once, so `seen` holds the rows this list showed.
 */
export function retainDecidedApprovals<T extends { id: string; approval?: { id: string } }>(
  items: readonly T[],
  seen: ReadonlyMap<string, T>,
  decisions: Readonly<Record<string, LocalApprovalDecision>>,
  now: number,
): readonly T[] {
  const present = new Set(items.map((item) => item.id));
  const kept = [...seen.values()].filter((item) => {
    if (present.has(item.id) || !item.approval) return false;
    const decision = decisions[item.approval.id];
    return (
      (decision?.state === 'approved' || decision?.state === 'declined') && now - decision.at < DECIDED_ROW_MS
    );
  });
  return kept.length ? [...items, ...kept] : items;
}
