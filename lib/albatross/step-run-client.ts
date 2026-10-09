// The client side of the step runner: what one StepRunView means for a
// screen. Every surface (the Work page, the guided pane, the Brief list, the
// shared browser bar) reads these helpers, so the web, iOS, and macOS copies
// of the same rules stay side by side with the contract in
// docs/albatross-step-runner.md. No React here; the components only render.

import type { StepRunView } from '../../convex/albatrossStepRuns';

export type { StepRunView };
export type StepRunNext = NonNullable<StepRunView['next']>;
export type StepRunNextKind = StepRunNext['kind'];
export type StepRunArtifact = StepRunView['artifacts'][number];
export type StepRunLogLine = StepRunView['log'][number];

/** One row of the Brief's "Ready for you" list, as the server sends it. */
export interface StepRunHandoffItem {
  workId: string;
  workTitle: string;
  run: StepRunView;
}

/** The screen state of one step: nothing, a run at work, a handoff, a check, or a failure. */
export type StepRunPhase = 'none' | 'working' | 'handed_off' | 'done' | 'failed';

export function stepRunPhase(run: StepRunView | null | undefined): StepRunPhase {
  if (!run) return 'none';
  switch (run.state) {
    case 'queued':
    case 'running':
      return 'working';
    case 'handed_off':
      return 'handed_off';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'none';
  }
}

export function isOpenRun(
  run: StepRunView | null | undefined,
): run is StepRunView & { state: 'queued' | 'running' } {
  return run?.state === 'queued' || run?.state === 'running';
}

export function isOpenHandoff(
  run: StepRunView | null | undefined,
): run is StepRunView & { state: 'handed_off' } {
  return run?.state === 'handed_off';
}

/**
 * The user may press "Handle it": the feature is on, the step accepts a run,
 * the step is not done, and nothing on this Work is at work or waits for the
 * user. A failed run offers "Try again" instead, which is the same start.
 */
export function canStartRun(input: {
  enabled: boolean;
  runnable: boolean;
  stepDone: boolean;
  run: StepRunView | null | undefined;
  activeRun: StepRunView | null | undefined;
}): boolean {
  if (!input.enabled || !input.runnable || input.stepDone) return false;
  if (isOpenRun(input.activeRun)) return false;
  if (isOpenRun(input.run) || isOpenHandoff(input.run)) return false;
  return true;
}

/** Another step of the same Work has the only open run slot. */
export function blockedByOtherRun(
  run: StepRunView | null | undefined,
  activeRun: StepRunView | null | undefined,
): boolean {
  return isOpenRun(activeRun) && activeRun.id !== run?.id;
}

/** The newest run of a step: the live subscription first, then the projection. */
export function runForStep(
  liveRuns: readonly StepRunView[] | null | undefined,
  step: { key: string; run?: StepRunView | null },
): StepRunView | null {
  const live = liveRuns?.find((row) => row.stepKey === step.key);
  return live ?? step.run ?? null;
}

/** The open run of a Work: the live subscription first, then the projection. */
export function activeRunOf(
  liveRuns: readonly StepRunView[] | null | undefined,
  fallback: StepRunView | null | undefined,
): StepRunView | null {
  if (liveRuns) return liveRuns.find(isOpenRun) ?? null;
  return isOpenRun(fallback) ? fallback : null;
}

// ---------------------------------------------------------------------------
// The next action.
// ---------------------------------------------------------------------------

/** What a client does when the user presses the primary button. */
export type NextBehaviour =
  | { kind: 'open_draft'; id: string; accountId: string | null }
  | { kind: 'open_document'; url: string | null; id: string | null }
  | { kind: 'open_approval'; id: string | null }
  | { kind: 'show_browser' }
  | { kind: 'show_question'; id: string | null }
  | { kind: 'mark_done' }
  | { kind: 'open_url'; url: string }
  | { kind: 'show_artifacts' }
  | { kind: 'open_card'; id: string }
  | { kind: 'resume' };

export function nextBehaviour(next: StepRunNext | null | undefined): NextBehaviour | null {
  if (!next) return null;
  const target = next.target ?? null;
  switch (next.kind) {
    case 'review_draft':
      return target?.id
        ? { kind: 'open_draft', id: target.id, accountId: target.accountId ?? null }
        : { kind: 'show_artifacts' };
    case 'review_document':
      return target?.url || target?.id
        ? { kind: 'open_document', url: target.url ?? null, id: target.id ?? null }
        : { kind: 'show_artifacts' };
    case 'approve':
      return { kind: 'open_approval', id: target?.id ?? null };
    case 'sign_in':
    case 'finish_on_page':
      return { kind: 'show_browser' };
    case 'answer':
      return { kind: 'show_question', id: target?.id ?? null };
    case 'do_offline':
      return { kind: 'mark_done' };
    case 'review':
      return target?.url ? { kind: 'open_url', url: target.url } : { kind: 'show_artifacts' };
    case 'continue':
      return { kind: 'resume' };
    default:
      return null;
  }
}

/** Which editor opens a run's document: the Albatross editor or the Word editor. */
export interface DocumentTarget {
  provider: 'albatross' | 'office';
  id: string;
}

/**
 * The document a target names. The link wins (`?document=`, `?office=`, or the
 * old `/files/<id>` form); a bare id is an Albatross document.
 */
export function documentTargetOf(
  url: string | null | undefined,
  id: string | null | undefined,
): DocumentTarget | null {
  const raw = url?.trim();
  if (raw) {
    try {
      const parsed = new URL(raw, 'https://app.invalid');
      // Only a link inside the app names a document; another site's link falls back to the id.
      if (parsed.origin !== 'https://app.invalid') throw new Error('not an app link');
      const office = parsed.searchParams.get('office')?.trim();
      if (office) return { provider: 'office', id: office };
      const document = parsed.searchParams.get('document')?.trim();
      if (document) return { provider: 'albatross', id: document };
      const legacy = /^\/files\/([^/?#]+)$/.exec(parsed.pathname)?.[1];
      if (legacy) return { provider: 'albatross', id: decodeURIComponent(legacy) };
    } catch {
      // Not a link: the id decides.
    }
  }
  const bare = id?.trim();
  return bare ? { provider: 'albatross', id: bare } : null;
}

/** The Files link for one document target. */
export function documentTargetPath(target: DocumentTarget): string {
  return `/?view=files&${target.provider === 'office' ? 'office' : 'document'}=${encodeURIComponent(target.id)}`;
}

const LABEL_FALLBACK: Record<StepRunNextKind, string | null> = {
  review_draft: 'Read and send',
  review_document: 'Open the document',
  approve: 'Approve it',
  sign_in: 'Sign in',
  finish_on_page: 'Check and submit',
  answer: null,
  do_offline: 'Mark this step done',
  review: 'Open',
  continue: 'Continue',
  // The run block shows its own three answers (docs/albatross-secure-store.md).
  allow_secure: null,
};

export const LABEL_MAX = 48;

/** The primary button text. The agent writes it; a blank or long label falls back. */
export function primaryLabel(next: StepRunNext | null | undefined): string | null {
  if (!next) return null;
  if (next.kind === 'answer') return null;
  const label = next.label?.trim() ?? '';
  if (label && label.length <= LABEL_MAX) return label;
  return LABEL_FALLBACK[next.kind] ?? null;
}

/** A second "Continue" button: the user did the page part, the run resumes. */
export function showsContinue(next: StepRunNext | null | undefined): boolean {
  return next?.kind === 'sign_in' || next?.kind === 'finish_on_page';
}

// ---------------------------------------------------------------------------
// Copy.
// ---------------------------------------------------------------------------

export const COPY = {
  queued: 'Waiting to start.',
  working: 'Albatross works on this step.',
  readyForYou: 'Ready for you',
  yourTurn: 'Your turn',
  needsAnswer: 'Albatross needs one answer',
  stoppedTime: 'Albatross stopped at its time limit.',
  stoppedCost: 'Albatross stopped at its cost limit.',
  stopped: 'Albatross stopped before the end.',
  handedOff: 'Albatross stopped here.',
  failed: 'This run did not finish.',
  done: 'Albatross did this step.',
  canHandle: 'Albatross can do this step.',
  blocked: 'Albatross works on another step of this Albatross.',
  whatIDid: 'What Albatross did',
  soFar: 'What Albatross did so far',
  agentHasPage: 'Albatross has the page.',
  userHasPage: 'Your turn on the page.',
} as const;

export function stoppedLine(run: Pick<StepRunView, 'stoppedBy'>): string {
  if (run.stoppedBy === 'time') return COPY.stoppedTime;
  if (run.stoppedBy === 'cost') return COPY.stoppedCost;
  return COPY.stopped;
}

/** The first line of a handoff card. */
export function handoffHeadline(run: Pick<StepRunView, 'outcome' | 'stoppedBy'>): string {
  switch (run.outcome) {
    case 'ready_for_you':
      return COPY.readyForYou;
    case 'your_turn':
      return COPY.yourTurn;
    case 'needs_answer':
      return COPY.needsAnswer;
    case 'stopped':
      return stoppedLine(run);
    default:
      return COPY.handedOff;
  }
}

/** The log, oldest first, newest last. The server keeps the order; this guards it. */
export function logLines(run: Pick<StepRunView, 'log'>): StepRunLogLine[] {
  return [...run.log].sort((a, b) => a.at - b.at);
}

export function newestLogLine(run: Pick<StepRunView, 'log'>): string | null {
  const lines = logLines(run);
  return lines.length ? lines[lines.length - 1].text : null;
}

/** The shimmer line above a run at work. */
export function workingLine(run: Pick<StepRunView, 'state' | 'log'>): string {
  if (run.state === 'queued') return COPY.queued;
  return newestLogLine(run) ?? COPY.working;
}

export function runErrorLine(run: Pick<StepRunView, 'error'>): string {
  return run.error?.trim() || COPY.failed;
}

/** One handoff line for a list row: the summary, else the next detail, else the headline. */
export function handoffLine(run: StepRunView): string {
  return run.summary?.trim() || run.next?.detail?.trim() || handoffHeadline(run);
}

export function formatLogTime(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(at),
  );
}

// ---------------------------------------------------------------------------
// Artifacts.
// ---------------------------------------------------------------------------

const ARTIFACT_KIND_LABEL: Record<StepRunArtifact['kind'], string> = {
  document: 'Document',
  draft: 'Draft',
  event: 'Event',
  card: 'Task',
  approval: 'Approval',
  page: 'Page',
};

export function artifactKindLabel(artifact: Pick<StepRunArtifact, 'kind'>): string {
  return ARTIFACT_KIND_LABEL[artifact.kind] ?? 'File';
}

/** What a click on an artifact row does; null means the row is text only. */
export function artifactBehaviour(artifact: StepRunArtifact): NextBehaviour | null {
  switch (artifact.kind) {
    case 'draft':
      return artifact.id
        ? { kind: 'open_draft', id: artifact.id, accountId: artifact.accountId ?? null }
        : null;
    case 'document':
      return artifact.url || artifact.id
        ? { kind: 'open_document', url: artifact.url ?? null, id: artifact.id ?? null }
        : null;
    case 'approval':
      return { kind: 'open_approval', id: artifact.id ?? null };
    case 'page':
      return artifact.url ? { kind: 'open_url', url: artifact.url } : null;
    case 'card':
      return artifact.id ? { kind: 'open_card', id: artifact.id } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The Brief's "Ready for you" list.
// ---------------------------------------------------------------------------

export interface ReadyForYouRow {
  runId: string;
  workId: string;
  workTitle: string;
  stepTitle: string;
  line: string;
  working: boolean;
  /** The one button. Null for a run at work. */
  action: { label: string; behaviour: NextBehaviour | { kind: 'open_work' } } | null;
}

const OPENS_IN_PLACE = new Set<NextBehaviour['kind']>([
  'open_draft',
  'open_document',
  'open_approval',
  'open_url',
  'open_card',
  // Continue starts the next run from the Brief; the row then shows the work.
  'resume',
]);

/**
 * Rows for the list. A handoff that opens a file opens it from the Brief; any
 * other handoff opens the Work page, where the full card and its controls are.
 */
export function readyForYouRows(items: readonly StepRunHandoffItem[]): ReadyForYouRow[] {
  const rows: ReadyForYouRow[] = [];
  for (const item of items) {
    const { run } = item;
    if (isOpenRun(run)) {
      rows.push({
        runId: run.id,
        workId: item.workId,
        workTitle: item.workTitle,
        stepTitle: `In progress: ${run.stepTitle}`,
        line: workingLine(run),
        working: true,
        action: null,
      });
      continue;
    }
    if (!isOpenHandoff(run)) continue;
    const behaviour = nextBehaviour(run.next);
    const label = primaryLabel(run.next) ?? 'Open';
    rows.push({
      runId: run.id,
      workId: item.workId,
      workTitle: item.workTitle,
      stepTitle: run.stepTitle,
      line: handoffLine(run),
      working: false,
      action: {
        label,
        behaviour: behaviour && OPENS_IN_PLACE.has(behaviour.kind) ? behaviour : { kind: 'open_work' },
      },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The Documents page's "Waiting for you" section.
// ---------------------------------------------------------------------------

export interface DocumentWaitingRow {
  runId: string;
  workId: string;
  workTitle: string;
  /** The title of the document the handoff opens, from the run's artifacts. */
  documentTitle: string;
  detail: string;
  blanks: string[];
  /** The same row and button as the Brief's list, so both open the document the same way. */
  row: ReadyForYouRow;
}

/** The open handoffs whose next action opens a document: the documents that wait for the user. */
export function documentsWaitingRows(items: readonly StepRunHandoffItem[]): DocumentWaitingRow[] {
  const rows: DocumentWaitingRow[] = [];
  for (const item of items) {
    const { run } = item;
    const target = run.next?.target;
    if (!isOpenHandoff(run) || !run.next || target?.kind !== 'document') continue;
    const row = readyForYouRows([item])[0];
    if (!row) continue;
    const documents = run.artifacts.filter((artifact) => artifact.kind === 'document');
    const made = documents.find((artifact) => artifact.id === target.id) ?? documents.at(-1);
    rows.push({
      runId: run.id,
      workId: item.workId,
      workTitle: item.workTitle,
      documentTitle: made?.title?.trim() || run.stepTitle,
      detail: run.next.detail,
      blanks: (run.next.blanks || []).filter(Boolean),
      row,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The shared browser bar.
// ---------------------------------------------------------------------------

export interface BrowserPaneState {
  line: string;
  action: 'take_over' | 'continue' | null;
}

/**
 * What the bar above the live view says while a run uses the session. Null
 * means the usual guided-work line applies.
 */
export function browserPaneState(
  session: { status: string; statusDetail?: string | null } | null | undefined,
  run: StepRunView | null | undefined,
): BrowserPaneState | null {
  if (!session) return null;
  if (session.status === 'agent') {
    return {
      line: session.statusDetail?.trim() || COPY.agentHasPage,
      action: isOpenRun(run) ? 'take_over' : null,
    };
  }
  if (session.status === 'user' && isOpenHandoff(run) && showsContinue(run.next)) {
    return {
      line: run.next?.detail?.trim() || session.statusDetail?.trim() || COPY.userHasPage,
      action: 'continue',
    };
  }
  return null;
}

/** The short state under a step title in the guided ledger. */
export function ledgerRunLabel(run: StepRunView | null | undefined): string | null {
  switch (stepRunPhase(run)) {
    case 'working':
      return 'Albatross is on it';
    case 'handed_off':
      return handoffHeadline(run!);
    case 'failed':
      return 'Run did not finish';
    default:
      return null;
  }
}
