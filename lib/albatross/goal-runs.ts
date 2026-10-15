// Goal runs (docs/albatross-goal-runs.md): the pure rules that the start
// module, the runner, the orchestrator, Convex, and the clients share. A goal
// run works on the whole goal of a Work, not on one plan step. It talks in the
// thread, keeps its own checklist, and hands over a package of items.

import { z } from 'zod';
import { redactSecretShapes } from '../secure/redact';
import { truncateText } from '../shared/text';
import { type CloseWhen, type ContractProof, type OutcomeContract, proposeContract } from './contract';
import {
  type ChecklistItem,
  cleanChecklist,
  cleanHandoffItems,
  type HandoffItem,
  type HandoffItemKind,
  isGoalStepKey,
  type RunSource,
} from './goal-run-contract';
import type { RunArtifact } from './step-run-tools';

const oneLine = (value: unknown, max: number) =>
  typeof value === 'string' ? truncateText(value.replace(/\s+/g, ' ').trim(), max) : '';

/** A run row is a goal run: the flag, or the goal step key. */
export function isGoalRun(
  run: { goal?: boolean | null; stepKey?: string | null } | null | undefined,
): boolean {
  return Boolean(run && (run.goal === true || isGoalStepKey(run.stepKey)));
}

// ---------------------------------------------------------------------------
// The first contract (G1 Switch): no model call.
// ---------------------------------------------------------------------------

/** The kind of a first contract, from the words of the goal. */
export function goalContractKind(text: string): 'send' | 'buy' | 'book' | 'general' {
  const words = text.toLowerCase();
  if (/\b(buy|purchase|order|pay for)\b/.test(words)) return 'buy';
  if (/\b(book|reserve|appointment|registration|register)\b/.test(words)) return 'book';
  if (/\b(send|email|e-mail|mail|reply|respond|invoice|submit|write to)\b/.test(words)) return 'send';
  return 'general';
}

/** The outcome text of a goal Work before a run makes it better: the title, else the request. */
export function goalOutcomeText(work: { title?: string | null; rawText?: string | null }): string {
  return oneLine(work.title, 600) || oneLine(work.rawText, 600) || 'The goal is done.';
}

/** The first contract of a goal Work. The run can change it with goal_update. */
export function goalContractFor(work: { title?: string | null; rawText?: string | null }): OutcomeContract {
  const outcome = goalOutcomeText(work);
  return proposeContract(outcome, goalContractKind(`${work.title || ''} ${work.rawText || ''}`));
}

// ---------------------------------------------------------------------------
// The checklist.
// ---------------------------------------------------------------------------

const USER_STEP_MODES = new Set(['you_do_offline', 'you_do_observed']);

/** The first checklist of the first goal run: the open steps of the old plan, in order. */
export function checklistFromSteps(
  steps: ReadonlyArray<{ title?: string | null; done?: boolean; stepMode?: string | null }> | undefined,
): ChecklistItem[] {
  return cleanChecklist(
    (steps || [])
      .filter((step) => !step.done && oneLine(step.title, 120))
      .map((step) => ({
        text: String(step.title),
        state: USER_STEP_MODES.has(String(step.stepMode || '')) ? 'yours' : 'todo',
      })),
  );
}

/** The checklist a new goal run starts with: the newest list of an earlier run, else the open steps. */
export function seedChecklist(input: {
  runs?: ReadonlyArray<{ checklist?: ReadonlyArray<{ text: string; state: string }> | null }> | null;
  steps?: ReadonlyArray<{ title?: string | null; done?: boolean; stepMode?: string | null }>;
}): ChecklistItem[] {
  const runs = [...(input.runs || [])].reverse();
  const newest = runs.find((run) => run.checklist?.length);
  if (newest?.checklist) return cleanChecklist(newest.checklist);
  return checklistFromSteps(input.steps);
}

// ---------------------------------------------------------------------------
// "Done, continue" on a goal handoff.
// ---------------------------------------------------------------------------

/** The start of the note when the user did their part of a goal handoff. */
export const GOAL_USER_DID_PART = 'The user did their part';

/** The note for the run that continues after "Done, continue": the next run checks the goal first. */
export function userDidPartNote(label: string | null | undefined, note?: string | null): string {
  const part = (label || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  const extra = (note || '').replace(/\s+/g, ' ').trim();
  return truncateText(`${GOAL_USER_DID_PART}${part ? `: ${part}` : ''}.${extra ? ` ${extra}` : ''}`, 2_000);
}

export function isUserDidPartNote(note: string | null | undefined): boolean {
  return Boolean(note?.trim().startsWith(GOAL_USER_DID_PART));
}

// ---------------------------------------------------------------------------
// Automatic starts (G1 Start).
// ---------------------------------------------------------------------------

export type GoalAutoVerdict =
  | { start: true; continueFrom: string | null }
  | { start: false; reason: 'active' | 'waiting' | 'ran' };

/**
 * May an automatic trigger start a goal run now? Only for a Work with no run
 * yet, or whose newest run stopped at its time or cost limit. Never while a
 * run works, a handoff waits for the user, or a question is open.
 */
export function goalAutoVerdict(input: {
  /** The runs of the Work, oldest first. */
  runs: ReadonlyArray<{ id: string; state: string; stoppedBy?: string | null }>;
  pendingQuestions: number;
}): GoalAutoVerdict {
  const newest = input.runs.at(-1);
  if (newest && (newest.state === 'queued' || newest.state === 'running'))
    return { start: false, reason: 'active' };
  if (input.pendingQuestions > 0) return { start: false, reason: 'waiting' };
  if (!newest) return { start: true, continueFrom: null };
  if (newest.state === 'handed_off' && newest.stoppedBy) return { start: true, continueFrom: newest.id };
  if (newest.state === 'handed_off') return { start: false, reason: 'waiting' };
  return { start: false, reason: 'ran' };
}

// ---------------------------------------------------------------------------
// goal_update: the run changes the outcome and the proofs of the contract.
// ---------------------------------------------------------------------------

export const GOAL_PROOFS_MAX = 6;

// Model-facing: no .regex (OpenAI Responses rejects patterns).
export const goalUpdateInputSchema = z.object({
  outcome: z
    .string()
    .min(1)
    .max(600)
    .optional()
    .describe('What done means, in one concrete sentence. For example "The client has the July invoice".'),
  proofs: z
    .array(z.string().min(1).max(300))
    .min(1)
    .max(GOAL_PROOFS_MAX)
    .optional()
    .describe('The full list of things that prove it, one short line each. It replaces the old list.'),
});
export type GoalUpdateInput = z.infer<typeof goalUpdateInputSchema>;

/** A goal update with clean text, or null when it changes nothing. */
export function cleanGoalUpdate(
  input: { outcome?: string | null; proofs?: readonly string[] | null } | null | undefined,
): { outcome?: string; proofs?: string[] } | null {
  const outcome = oneLine(input?.outcome, 600);
  const proofs: string[] = [];
  for (const proof of input?.proofs || []) {
    const what = oneLine(proof, 300);
    if (what && !proofs.some((other) => other.toLowerCase() === what.toLowerCase())) proofs.push(what);
    if (proofs.length === GOAL_PROOFS_MAX) break;
  }
  if (!outcome && !proofs.length) return null;
  return { ...(outcome ? { outcome } : {}), ...(proofs.length ? { proofs } : {}) };
}

const proofKey = (what: string) => what.toLowerCase().replace(/\s+/g, ' ').trim();

/** The contract as the Work row stores it. */
export interface StoredGoalContract {
  outcome: string;
  proofs: Array<{ id: string; what: string; satisfiedBy?: string; satisfiedAt?: number }>;
  closeWhen: CloseWhen;
  contradictions?: string[];
  updatedAt: number;
}

function storedProof(proof: ContractProof, id = proof.id, what = proof.what) {
  return {
    id,
    what,
    ...(proof.satisfiedAt
      ? { satisfiedAt: proof.satisfiedAt, ...(proof.satisfiedBy ? { satisfiedBy: proof.satisfiedBy } : {}) }
      : {}),
  };
}

/**
 * The contract after a goal update. A proof with the same words keeps its id
 * and its settled state; the close rule and the contradictions stay.
 */
export function mergeGoalContract(
  previous: OutcomeContract | null | undefined,
  update: { outcome?: string; proofs?: readonly string[] },
  fallback: { title?: string | null; rawText?: string | null },
  ts: number,
): StoredGoalContract {
  const base = previous ?? goalContractFor(fallback);
  let proofs = base.proofs.map((proof) => storedProof(proof));
  if (update.proofs?.length) {
    const prior = new Map(base.proofs.map((proof) => [proofKey(proof.what), proof] as const));
    const used = new Set<string>();
    proofs = update.proofs.map((what, index) => {
      const known = prior.get(proofKey(what));
      let id = known?.id || `goal-${index + 1}`;
      for (let suffix = 2; used.has(id); suffix += 1) id = `goal-${index + 1}-${suffix}`;
      used.add(id);
      return known ? storedProof(known, id, what) : { id, what };
    });
  }
  return {
    outcome: update.outcome || base.outcome,
    proofs,
    closeWhen: base.closeWhen,
    ...(base.contradictions?.length ? { contradictions: base.contradictions } : {}),
    updatedAt: ts,
  };
}

/** What a done claim must prove (G1 Done): the outcome and the proofs still open. */
export function goalRequirement(contract: OutcomeContract | null | undefined, title: string): string {
  const outcome = contract?.outcome?.trim() || `"${title}" is done.`;
  const open = (contract?.proofs || []).filter((proof) => !proof.satisfiedAt).map((proof) => proof.what);
  return open.length ? `${outcome}\nWhat proves it:\n${open.map((what) => `- ${what}`).join('\n')}` : outcome;
}

// ---------------------------------------------------------------------------
// Sources (G2): what the model read, from the tool results.
// ---------------------------------------------------------------------------

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const ATLASSIAN_SEARCH_SOURCES = 3;

/** The things a finished tool call read, as run sources. Unknown tools read nothing. */
export function sourcesFromToolResult(name: string, args: any, result: any): RunSource[] {
  if (!result || result.ok === false) return [];
  switch (name) {
    case 'browserbase_fetch': {
      const url = oneLine(result.url || args?.url, 2_000);
      return url ? [{ kind: 'web', title: oneLine(result.title, 160) || hostOf(url) || url, url }] : [];
    }
    case 'web_research':
      return (Array.isArray(result.sources) ? result.sources : [])
        .filter((source: any) => oneLine(source?.passage, 10) && oneLine(source?.url, 2_000))
        .map((source: any) => ({
          kind: 'web' as const,
          title: oneLine(source.title, 160) || hostOf(source.url),
          url: oneLine(source.url, 2_000),
        }));
    case 'web_file_save':
    case 'pdf_form_fill': {
      const url = oneLine(result.sourceUrl, 2_000);
      return url ? [{ kind: 'web', title: oneLine(result.title, 160) || hostOf(url), url }] : [];
    }
    case 'read_thread':
    case 'get_thread': {
      const threadId = oneLine(result.threadId || args?.threadId, 300);
      if (!threadId) return [];
      const subject = oneLine(result.subject, 140) || '(no subject)';
      const messages: any[] = Array.isArray(result.messages) ? result.messages : [];
      const sender = oneLine(
        typeof messages[0]?.from === 'string' ? messages[0].from : messages[0]?.from?.[0]?.email,
        80,
      );
      const accountId = oneLine(result.account || args?.account, 300);
      return [
        {
          kind: 'mail',
          title: sender ? `${subject} (${sender})` : subject,
          id: threadId,
          ...(accountId ? { accountId } : {}),
        },
      ];
    }
    case 'get_message': {
      const id = oneLine(result.threadId || result.thread_id || args?.id, 300);
      if (!id) return [];
      const subject = oneLine(result.subject, 140) || '(no subject)';
      const from = Array.isArray(result.from) ? result.from[0]?.email : result.from;
      const sender = oneLine(typeof from === 'string' ? from : '', 80);
      const accountId = oneLine(args?.account, 300);
      return [
        {
          kind: 'mail',
          title: sender ? `${subject} (${sender})` : subject,
          id,
          ...(accountId ? { accountId } : {}),
        },
      ];
    }
    case 'jira_read_issue': {
      const issue = result.issue || {};
      const key = oneLine(issue.key, 60);
      const url = oneLine(issue.url, 2_000);
      if (!key && !url) return [];
      return [
        {
          kind: 'jira',
          title: [key, oneLine(issue.title, 140)].filter(Boolean).join(' '),
          ...(url ? { url } : {}),
          ...(key ? { id: key } : {}),
        },
      ];
    }
    case 'atlassian_search':
      // Each hit carries its summary, so the model read the top hits.
      return (Array.isArray(result.items) ? result.items : [])
        .slice(0, ATLASSIAN_SEARCH_SOURCES)
        .map((item: any): RunSource | null => {
          const url = oneLine(item?.url, 2_000);
          const key = oneLine(item?.key, 60);
          if (!url && !key) return null;
          const page = item?.kind === 'page';
          return {
            kind: page ? 'document' : 'jira',
            title: [page ? '' : key, oneLine(item?.title, 140)].filter(Boolean).join(' ') || key || url,
            ...(url ? { url } : {}),
            ...(key && !page ? { id: key } : {}),
          };
        })
        .filter((source: RunSource | null): source is RunSource => Boolean(source));
    case 'document_get': {
      const id = oneLine(result.document?.documentId || args?.documentId, 300);
      if (!id) return [];
      return [
        {
          kind: 'file',
          title: oneLine(result.document?.title, 160) || 'Document',
          id,
          url: `/?view=files&document=${encodeURIComponent(id)}`,
        },
      ];
    }
    case 'word_document_get': {
      const id = oneLine(result.documentId || args?.documentId, 300);
      if (!id) return [];
      const url = oneLine(result.openPath, 2_000);
      return [{ kind: 'file', title: oneLine(result.title, 160) || 'Document', id, ...(url ? { url } : {}) }];
    }
    case 'google_document_get': {
      const id = oneLine(args?.fileId, 300);
      return id ? [{ kind: 'file', title: oneLine(result.title, 160) || 'Google file', id }] : [];
    }
    case 'calendar_event_detail': {
      const event = result.event || {};
      const id = oneLine(event.id || event.eventId || args?.eventId, 300);
      if (!id) return [];
      const accountId = oneLine(args?.account, 300);
      return [
        {
          kind: 'calendar',
          title: oneLine(event.title || event.summary, 160) || 'Calendar event',
          id,
          ...(accountId ? { accountId } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Open paths: every item and every artifact of a goal run carries the app path
// that opens it. Clients never build a path.
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

/** An app path ("/?view=…"), not another site and not a scheme. */
export function isAppPath(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^\/(?![/\\])/.test(url.trim());
}

/** An http or https link. */
function isWebLink(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

/**
 * The app path that opens one thing. A document keeps the path its tool gave
 * (a Word file opens with `office=`). A saved file opens as
 * lib/files/saved-files.ts savedFileOpenPath does.
 */
export function runOpenPath(
  kind: RunArtifact['kind'] | HandoffItemKind,
  thing: { id?: string | null; accountId?: string | null; url?: string | null },
): string | undefined {
  const id = thing.id?.trim();
  const account = thing.accountId?.trim() ? `&account=${enc(thing.accountId.trim())}` : '';
  switch (kind) {
    case 'draft':
      return id ? `/?view=mail${account}&draft=${enc(id)}` : undefined;
    case 'document':
    case 'sheet':
    case 'deck':
      return isAppPath(thing.url) ? thing.url.trim() : id ? `/?view=files&document=${enc(id)}` : undefined;
    case 'file':
      return isAppPath(thing.url) ? thing.url.trim() : id ? `/?view=files&file=${enc(id)}` : undefined;
    case 'approval':
      return id ? `/?view=notifications&approval=${enc(id)}` : '/?view=notifications';
    case 'event':
      return id ? `/?view=calendar${account}&event=${enc(id)}` : undefined;
    case 'card':
      return id ? `/?view=tasks&card=${enc(id)}` : undefined;
    case 'page':
      return isWebLink(thing.url) || isAppPath(thing.url) ? thing.url.trim() : undefined;
    default:
      return undefined;
  }
}

/** The artifact with its open path. */
export function withOpenPath(artifact: RunArtifact): RunArtifact {
  const url = runOpenPath(artifact.kind, artifact);
  if (!url || url === artifact.url) return artifact;
  return { ...artifact, url };
}

// ---------------------------------------------------------------------------
// The package (G3).
// ---------------------------------------------------------------------------

const ITEM_KIND_OF_ARTIFACT: Partial<Record<RunArtifact['kind'], HandoffItemKind>> = {
  draft: 'draft',
  document: 'document',
  deck: 'deck',
  file: 'file',
  approval: 'approval',
  event: 'event',
};

type Target = { kind?: string; id?: string; url?: string; accountId?: string } | null | undefined;

const sameThing = (artifact: RunArtifact, target: Target) =>
  Boolean(
    target && ((target.id && artifact.id === target.id) || (target.url && artifact.url === target.url)),
  );

/**
 * The package when the model listed none: each draft, document, deck, file,
 * approval, and event the run made, with the main target first.
 */
export function handoffItemsFromArtifacts(
  artifacts: readonly RunArtifact[],
  options: { target?: Target; blanks?: readonly string[] } = {},
): HandoffItem[] {
  const ordered = [
    ...artifacts.filter((artifact) => sameThing(artifact, options.target)),
    ...artifacts.filter((artifact) => !sameThing(artifact, options.target)),
  ];
  const items: Array<Partial<HandoffItem>> = [];
  for (const artifact of ordered) {
    const kind = ITEM_KIND_OF_ARTIFACT[artifact.kind];
    if (!kind) continue;
    const isTarget = sameThing(artifact, options.target);
    const blanks = isTarget ? [...(options.blanks || [])] : [];
    const url = runOpenPath(artifact.kind, artifact);
    items.push({
      kind,
      title: artifact.title,
      // A private hold is in place; everything else waits for the user's eyes.
      state: kind === 'event' ? 'ready' : blanks.length ? 'blanks' : 'check',
      ...(artifact.id ? { id: artifact.id } : {}),
      ...(url ? { url } : {}),
      ...(artifact.accountId ? { accountId: artifact.accountId } : {}),
      ...(blanks.length ? { blanks } : {}),
    });
  }
  return cleanHandoffItems(items);
}

const ARTIFACT_KINDS_OF_ITEM: Record<HandoffItemKind, ReadonlyArray<RunArtifact['kind']>> = {
  draft: ['draft'],
  document: ['document'],
  sheet: ['document'],
  deck: ['deck', 'document'],
  file: ['file'],
  approval: ['approval'],
  event: ['event'],
  page: ['page'],
};

/**
 * The package of a goal handoff. The model's items get the link and account of
 * the thing with the same id; with no items, the package comes from what the
 * run made.
 */
export function resolveHandoffItems(
  items: ReadonlyArray<Partial<HandoffItem>> | null | undefined,
  context: {
    artifacts: readonly RunArtifact[];
    /** Things earlier runs of the Work made, for links of items the model names by id. */
    known?: readonly RunArtifact[];
    next?: { target?: Target; blanks?: readonly string[] } | null;
  },
): HandoffItem[] {
  if (!items?.length)
    return handoffItemsFromArtifacts(context.artifacts, {
      target: context.next?.target,
      blanks: context.next?.blanks,
    });
  const known = [...context.artifacts, ...(context.known || [])];
  return cleanHandoffItems(
    items.map((item) => {
      // Models fill optional fields with empty strings; an empty field is no field.
      const clean = Object.fromEntries(
        Object.entries(item).filter(([, value]) => typeof value !== 'string' || value.trim()),
      ) as Partial<HandoffItem>;
      if (!clean.kind) return clean;
      const kinds = ARTIFACT_KINDS_OF_ITEM[clean.kind] || [];
      const made = clean.id
        ? known.find((artifact) => artifact.id === clean.id && kinds.includes(artifact.kind))
        : undefined;
      const accountId = clean.accountId || made?.accountId;
      // The server gives the path. Only a page keeps the link the model named.
      const { url: modelUrl, ...rest } = clean;
      const url = runOpenPath(clean.kind, {
        id: clean.id,
        accountId,
        url: clean.kind === 'page' ? modelUrl : made?.url,
      });
      return { ...rest, ...(url ? { url } : {}), ...(accountId ? { accountId } : {}) };
    }),
  );
}

/** The note of a filled PDF whose ID numbers stay sealed until send or download (G5). */
export const SEALED_FILE_NOTE =
  'Your saved ID number fills in when the mail sends or when you download the file.';

/** The file id of a pdf_form_fill result with sealed fields, else null. */
export function sealedFileId(name: string, result: any): string | null {
  if (name !== 'pdf_form_fill' || !result || result.ok === false || !result.fileId) return null;
  return Array.isArray(result.sealedFields) && result.sealedFields.length ? String(result.fileId) : null;
}

/** A file item with sealed fields waits for the user's check, with the note that says why. */
export function applySealedNotes(items: readonly HandoffItem[], sealed: ReadonlySet<string>): HandoffItem[] {
  if (!sealed.size) return [...items];
  return items.map((item) =>
    item.kind === 'file' && item.id && sealed.has(item.id)
      ? { ...item, state: 'check', note: item.note || SEALED_FILE_NOTE }
      : item,
  );
}

/** The things earlier runs of a Work made, one entry each, the newest version of each. */
export function earlierRunArtifacts(
  runs: ReadonlyArray<{ id?: string; artifacts?: readonly RunArtifact[] | null }>,
  exceptRunId?: string,
  max = 20,
): RunArtifact[] {
  const byKey = new Map<string, RunArtifact>();
  for (const run of runs) {
    if (exceptRunId && run.id === exceptRunId) continue;
    for (const artifact of run.artifacts || []) {
      const key = `${artifact.kind}:${artifact.id || artifact.url || artifact.title}`;
      byKey.delete(key);
      byKey.set(key, artifact);
    }
  }
  return [...byKey.values()].slice(-max);
}

// ---------------------------------------------------------------------------
// Redaction: what the model writes for the user never shows a saved value.
// ---------------------------------------------------------------------------

const SECURE_REFERENCE = /\{\{\s*secure:[^}]*\}\}/gi;

/**
 * Text the run writes for the user (messages, "Not sure" lines, the summary):
 * the values this run used are removed, a secure reference becomes a plain
 * mark, and secret shapes are removed (lib/secure/redact.ts).
 */
export function redactRunText(text: string, secure?: { cleanText(text: string): string } | null): string {
  const scrubbed = secure ? secure.cleanText(String(text || '')) : String(text || '');
  return redactSecretShapes(scrubbed.replace(SECURE_REFERENCE, '[saved value]')).text;
}
