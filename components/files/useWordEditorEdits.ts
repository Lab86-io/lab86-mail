'use client';
import { useEffect, useRef, useState } from 'react';
import type { OfficeFile } from '@/lib/documents/office-service';
import type { CollaboraSession } from './CollaboraFrame';

/** Save and release the actual editing session before a revision-based AI edit, then reopen it. */
export function useWordEditorEdits(input: {
  request: OfficeFile['aiEdit'];
  session: CollaboraSession | null;
  ready: boolean;
  save: () => Promise<string>;
  pause: () => void;
  resume: () => void;
  onError: (message: string) => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const handled = useRef<string | null>(null);
  const paused = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { request, session, ready } = input;
  useEffect(() => {
    if (
      !request ||
      !session ||
      !ready ||
      handled.current === request.id ||
      request.state !== 'requested' ||
      request.expiresAt <= Date.now() ||
      request.targetSessionId !== session.sessionId
    )
      return;
    handled.current = request.id;
    setBusy(true);
    const notify = async (failed = false) => {
      const response = await fetch(`/api/office/${encodeURIComponent(session.documentId)}/editing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, token: session.accessToken, failed }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('The document edit could not be prepared.');
    };
    void (async () => {
      try {
        // The host overlay takes focus before asking the embedded editor to save.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!mounted.current) return;
        await latest.current.save();
        if (!mounted.current) return;
        if (
          latest.current.request?.id !== request.id ||
          latest.current.request.state !== 'requested' ||
          request.expiresAt <= Date.now()
        ) {
          setBusy(false);
          return;
        }
        paused.current = true;
        latest.current.pause();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!mounted.current) return;
        await notify();
      } catch (error) {
        await notify(true).catch(() => undefined);
        if (!mounted.current) return;
        if (paused.current) {
          paused.current = false;
          latest.current.resume();
        }
        setBusy(false);
        latest.current.onError(
          error instanceof Error ? error.message : 'The document could not be prepared.',
        );
      }
    })();
  }, [request, session, ready]);
  useEffect(() => {
    if (!request || handled.current !== request.id) return;
    const finish = () => {
      if (!paused.current) return;
      paused.current = false;
      setBusy(false);
      latest.current.resume();
    };
    if (request.state === 'complete' || request.state === 'failed') finish();
    const timer = setTimeout(finish, Math.max(0, request.expiresAt - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [request]);
  return busy;
}
