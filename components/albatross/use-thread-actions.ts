'use client';

// What a row's hover actions do from the list or the rail (docs/albatross-threads.md,
// T10, T11; lead decision 7): Stop without a dialog but with a notice that
// offers "Continue"; Try again and Handle it start the step; Steer sends one
// note to the run and keeps it in the thread with the steer mark, so the
// receipt is there when the thread opens (the run route keeps the note in the
// thread itself, under the same id); Mark as unread.

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { workThreadSessionId } from '@/lib/albatross/thread-contract';
import { THREAD_ROW_COPY, type ThreadRowActionKind } from '@/lib/albatross/thread-list-view';
import {
  subscribeThreadMemory,
  threadDraftWorkIds,
  threadMemoryVersion,
} from '@/lib/albatross/thread-memory';
import { steerNoteMessage } from '@/lib/albatross/thread-notes';
import type { ThreadRow } from '@/lib/albatross/threads';
import { postJson } from '@/lib/albatross/work-view';
import { useMarkSeen } from './use-thread-rows';

export const THREAD_ACTION_COPY = {
  stopFailed: 'The run did not stop.',
  startFailed: 'Albatross could not start this step.',
  continueFailed: 'The run did not continue.',
  markedUnread: 'Marked as unread',
} as const;

export interface ThreadActionDeps {
  post: typeof postJson;
  notice: (message: string, options?: { action?: { label: string; onClick: () => void } }) => void;
  error: (message: string) => void;
  markSeen: (workId: string, unread?: boolean) => Promise<unknown>;
  openThread: (workId: string) => void;
}

const runUrl = (workId: string) => `/api/albatross/work/${encodeURIComponent(workId)}/run`;

/** The actions, with their dependencies explicit so a test can drive them. */
export function createThreadActions(deps: ThreadActionDeps) {
  const stop = async (row: ThreadRow) => {
    // A reply in progress stops on the server (T11); there is nothing to continue.
    if (row.status === 'answering') {
      try {
        await deps.post(
          '/api/agent/stop',
          { sessionId: workThreadSessionId(row.workId) },
          THREAD_ACTION_COPY.stopFailed,
        );
      } catch (cause) {
        deps.error(cause instanceof Error ? cause.message : THREAD_ACTION_COPY.stopFailed);
      }
      return;
    }
    const runId = row.workingRunId;
    if (!runId) return;
    try {
      await deps.post(runUrl(row.workId), { action: 'cancel', runId }, THREAD_ACTION_COPY.stopFailed);
    } catch (cause) {
      deps.error(cause instanceof Error ? cause.message : THREAD_ACTION_COPY.stopFailed);
      return;
    }
    deps.notice(THREAD_ROW_COPY.stoppedNotice, {
      action: {
        label: THREAD_ROW_COPY.continueAction,
        onClick: () => {
          void deps
            .post(runUrl(row.workId), { action: 'resume', runId }, THREAD_ACTION_COPY.continueFailed)
            .catch((cause) =>
              deps.error(cause instanceof Error ? cause.message : THREAD_ACTION_COPY.continueFailed),
            );
        },
      },
    });
  };

  const start = async (row: ThreadRow) => {
    try {
      await deps.post(runUrl(row.workId), { action: 'start' }, THREAD_ACTION_COPY.startFailed);
    } catch (cause) {
      deps.error(cause instanceof Error ? cause.message : THREAD_ACTION_COPY.startFailed);
    }
  };

  const steer = async (row: ThreadRow, text: string): Promise<boolean> => {
    const runId = row.workingRunId;
    const note = text.trim();
    if (!runId || !note) return false;
    const message = steerNoteMessage(note, runId);
    try {
      await deps.post(
        runUrl(row.workId),
        { action: 'steer', runId, note, noteId: message.id },
        THREAD_ROW_COPY.steerFailed,
      );
    } catch {
      return false;
    }
    return true;
  };

  const markUnread = async (row: ThreadRow) => {
    await deps.markSeen(row.workId, true);
  };

  const act = (kind: ThreadRowActionKind, row: ThreadRow) => {
    switch (kind) {
      case 'stop':
        void stop(row);
        break;
      case 'try_again':
      case 'handle':
        void start(row);
        break;
      case 'open':
      case 'answer':
        deps.openThread(row.workId);
        break;
      default:
        break;
    }
  };

  return { act, stop, start, steer, markUnread };
}

export function useThreadActions(openThread: (workId: string) => void) {
  const markSeen = useMarkSeen();
  return useMemo(
    () =>
      createThreadActions({
        post: postJson,
        notice: (message, options) => {
          toast(message, options?.action ? { action: options.action } : undefined);
        },
        error: (message) => toast.error(message),
        markSeen,
        openThread,
      }),
    [markSeen, openThread],
  );
}

/** The threads with an unsent draft, live. */
export function useThreadDraftIds(): ReadonlySet<string> {
  const version = useSyncExternalStore(subscribeThreadMemory, threadMemoryVersion, () => 0);
  // The version is the dependency: it moves on every write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the version stands in for the store's content
  return useMemo(() => threadDraftWorkIds(), [version]);
}

/** A stable callback for a row's actions. */
export function useRowAction(actions: ReturnType<typeof createThreadActions>) {
  return useCallback((kind: ThreadRowActionKind, row: ThreadRow) => actions.act(kind, row), [actions]);
}
