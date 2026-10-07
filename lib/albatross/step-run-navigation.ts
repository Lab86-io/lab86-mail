// What the app does with one NextBehaviour: open a draft in the composer,
// open a document in Files, open the approval surface, open a page. The
// dependencies come in as arguments so a test runs it without a browser.

import type { Draft } from '../shared/types';
import type { NextBehaviour } from './step-run-client';

/** The slice of the client store this module touches. */
export interface StepRunStoreLike {
  compose: { nonce: number };
  setPrimaryView: (view: 'files' | 'notifications' | 'tasks' | 'albatrosses') => void;
  setPendingOpenCardId: (cardId: string | null) => void;
  setSelectedWorkId: (workId: string | null) => void;
}

export interface StepRunNavigatorDeps {
  getState: () => StepRunStoreLike;
  setState: (patch: Record<string, unknown>) => void;
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  openWindow: (url: string) => void;
  pushPath: (path: string) => void;
  dispatch: (eventName: string) => void;
}

/** The handlers a surface supplies for the behaviours that stay on its own page. */
export interface StepRunSurfaceHandlers {
  showBrowser?: () => void;
  showQuestion?: (questionId: string | null) => void;
  markDone?: () => void;
  showArtifacts?: () => void;
  resume?: () => void;
}

/** A draft opens by id: the composer gets its fields and keeps the same draft id. */
export async function openSavedDraft(
  deps: Pick<StepRunNavigatorDeps, 'getState' | 'setState' | 'callTool'>,
  id: string,
  accountId: string | null,
): Promise<boolean> {
  if (!accountId) return false;
  const result = (await deps.callTool('list_drafts', { account: accountId })) as { drafts?: Draft[] };
  const draft = (result?.drafts ?? []).find((row) => row._id === id);
  if (!draft) return false;
  const state = deps.getState();
  deps.setState({
    compose: {
      mode: 'new',
      anchorThreadId: draft.threadId || null,
      anchorMessageId: draft.inReplyToMessageId || null,
      anchorAccount: draft.account,
      prefill: {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
        draftId: draft._id,
      },
      nonce: state.compose.nonce + 1,
    },
  });
  return true;
}

/** A document opens in Files, the way a tool result does. */
export function openDocumentPath(
  deps: Pick<StepRunNavigatorDeps, 'getState' | 'pushPath' | 'dispatch'>,
  url: string | null,
  id: string | null,
) {
  const path = url?.startsWith('/') ? url : id ? `/files/${encodeURIComponent(id)}` : null;
  if (!path) return false;
  deps.pushPath(path);
  deps.getState().setPrimaryView('files');
  deps.dispatch('lab86-mail:files-navigate');
  return true;
}

/**
 * Runs one behaviour. Returns false when nothing could open, so the caller
 * can say so instead of staying silent.
 */
export async function performNextBehaviour(
  behaviour: NextBehaviour,
  deps: StepRunNavigatorDeps,
  surface: StepRunSurfaceHandlers = {},
): Promise<boolean> {
  switch (behaviour.kind) {
    case 'open_draft':
      return openSavedDraft(deps, behaviour.id, behaviour.accountId);
    case 'open_document':
      return openDocumentPath(deps, behaviour.url, behaviour.id);
    case 'open_approval':
      deps.getState().setPrimaryView('notifications');
      return true;
    case 'open_url':
      deps.openWindow(behaviour.url);
      return true;
    case 'open_card':
      deps.getState().setPendingOpenCardId(behaviour.id);
      deps.getState().setPrimaryView('tasks');
      return true;
    case 'show_browser':
      surface.showBrowser?.();
      return Boolean(surface.showBrowser);
    case 'show_question':
      surface.showQuestion?.(behaviour.id);
      return Boolean(surface.showQuestion);
    case 'mark_done':
      surface.markDone?.();
      return Boolean(surface.markDone);
    case 'show_artifacts':
      surface.showArtifacts?.();
      return Boolean(surface.showArtifacts);
    case 'resume':
      surface.resume?.();
      return Boolean(surface.resume);
    default:
      return false;
  }
}

/** The Brief opens the Work page for a handoff that does not open a file. */
export function openWorkPage(deps: Pick<StepRunNavigatorDeps, 'getState'>, workId: string) {
  const state = deps.getState();
  state.setPrimaryView('albatrosses');
  state.setSelectedWorkId(workId);
}
