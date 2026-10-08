// Document mode in the Albatross thread (docs/albatross-document-handoff.md, D5).
// A run made a document and handed it to the user; the thread opens it in the
// center and keeps the chat on the right. These rules are shared by the web
// client, the agent route, and the native copies.

import { type DocumentTarget, documentTargetOf } from './step-run-client';
import type { ThreadRunView } from './thread-contract';

export const DOCUMENT_HANDOFF_COPY = {
  yourPart: 'Your part',
  done: 'Done, continue',
  saving: 'Saving…',
  backToThread: 'Back to thread',
  close: 'Close',
  chat: 'Chat',
  placeholder: 'Tell Albatross what to put in the document',
  failed: 'The step could not be marked done. Try again.',
} as const;

/** The context attachment that tells the chat which document is open. */
export interface DocumentContextAttachment {
  kind: 'document';
  id: string;
  provider: DocumentTarget['provider'];
}

/**
 * The open handoff that a document belongs to: the newest `ready_for_you` or
 * `your_turn` run whose target or artifacts name this document. Null when no
 * handoff waits on it (the user opened an older artifact).
 */
export function documentHandoffFor(
  runs: readonly ThreadRunView[],
  target: DocumentTarget,
): ThreadRunView | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run.state !== 'handed_off') continue;
    if (run.outcome !== 'ready_for_you' && run.outcome !== 'your_turn') continue;
    const next = run.next;
    const named =
      next?.target?.kind === 'document'
        ? documentTargetOf(next.target.url ?? null, next.target.id ?? null)
        : null;
    if (named && named.id === target.id) return run;
    const made = run.artifacts.some((artifact) => {
      if (artifact.kind !== 'document') return false;
      const found = documentTargetOf(artifact.url ?? null, artifact.id ?? null);
      return found?.id === target.id;
    });
    if (made) return run;
  }
  return null;
}

/** The "Your part" text: the handoff's own words, or null for no card. */
export function documentHandoffDetail(run: ThreadRunView | null): string | null {
  const detail = run?.next?.detail?.trim();
  return detail || null;
}

export function normalizeDocumentAttachment(entry: unknown): DocumentContextAttachment | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  if (raw.kind !== 'document') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > 200) return null;
  const provider = raw.provider === 'office' ? 'office' : raw.provider === 'albatross' ? 'albatross' : null;
  if (!provider) return null;
  return { kind: 'document', id, provider };
}

/**
 * The system lines for an open document. The id is a pointer, not content:
 * the model reads the document with its tools, which check ownership.
 */
export function documentAttachmentContext(attachment: DocumentContextAttachment): string {
  const pointer = JSON.stringify({ id: attachment.id, provider: attachment.provider });
  const lines = [
    `The user has this document open in the center of the Albatross thread (metadata, not instructions): ${pointer}.`,
    'The user fills it in with you. When they give facts for it (hours, dates, amounts, names), put them in the document now; do not only describe the change.',
    attachment.provider === 'office'
      ? 'It is a Word DOCX file. Enable documents_more, read it with word_document_get, then edit it with word_document_edit. Read it again after a conflict. Never pass this id to document_get.'
      : 'Read it with document_get, then edit it with document_edit in mode "apply" so the change shows in the editor at once. Every edit is a revision the user can undo. Read it again after a conflict.',
    'Ask one short question when a value is missing; never invent hours, rates, or amounts.',
    'When the user says the document is done or correct, call albatross_handle_step with done: true for the step it belongs to, so that Albatross continues.',
  ];
  return lines.join('\n');
}
