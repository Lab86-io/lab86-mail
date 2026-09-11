'use client';

import { type RefObject, useEffect, useRef } from 'react';
import { type DraftFlushResult, flushDraft, retainDraft } from '@/lib/documents/draft-store';

export interface OutgoingEditsOptions<TModel> {
  /** Identity of the file: the draft store key. */
  draftKey: string;
  dirtyRef: RefObject<boolean>;
  titleRef: RefObject<string>;
  modelRef: RefObject<TModel | null>;
  /** Revision or provider version the current draft was edited against. */
  baseRef: RefObject<string>;
  /** A save that may still be running when the editor unmounts. */
  inflightRef: RefObject<Promise<unknown> | null>;
  save: (draft: { title: string; model: TModel; base: string }) => Promise<DraftFlushResult>;
}

/**
 * When an editor instance goes away with unsaved work (URL change, back
 * button, palette navigation), retain that work under the file's identity and
 * flush it against the revision it was based on. The flush waits for any save
 * still in flight so it never races an older request for the same file.
 */
export function useOutgoingEdits<TModel>(options: OutgoingEditsOptions<TModel>) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const key = options.draftKey;
    return () => {
      const { dirtyRef, titleRef, modelRef, baseRef, inflightRef } = latest.current;
      if (!dirtyRef.current || modelRef.current === null) return;
      retainDraft<TModel>(key, {
        title: titleRef.current,
        model: modelRef.current,
        base: baseRef.current,
      });
      const inflight = inflightRef.current;
      void flushDraft<TModel>(key, async (draft) => {
        if (inflight) await inflight.catch(() => undefined);
        // A save that finished after unmount moved the base forward.
        return latest.current.save({ ...draft, base: latest.current.baseRef.current });
      });
    };
  }, [options.draftKey]);
}
