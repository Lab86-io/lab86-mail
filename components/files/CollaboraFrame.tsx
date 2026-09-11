'use client';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
export interface CollaboraSession {
  documentId: string;
  serverUrl: string;
  editorUrl: string;
  accessToken: string;
  accessTokenTtl: number;
}
export interface CollaboraHandle {
  save: () => Promise<string>;
}

/** Credentials travel in a POST body; postMessages are bound to this exact frame. */
export const CollaboraFrame = forwardRef<
  CollaboraHandle,
  {
    session: CollaboraSession;
    onReady: (ready: boolean) => void;
    onModified: (changed: boolean) => void;
    onError: (error: string) => void;
  }
>(function CollaboraFrame({ session, onReady, onModified, onError }, ref) {
  const mounted = useRef(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<{
    resolve: (saveId: string) => void;
    id: string;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const name = `collabora-${session.accessToken.slice(-16)}`;
  const post = useCallback(
    (MessageId: string, Values: Record<string, unknown> = {}) =>
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ MessageId, SendTime: Date.now(), Values }),
        session.serverUrl,
      ),
    [session.serverUrl],
  );
  useImperativeHandle(ref, () => ({
    save: () =>
      new Promise<string>((resolve, reject) => {
        if (pending.current) {
          reject(new Error('A save is already in progress.'));
          return;
        }
        const timer = setTimeout(() => {
          pending.current = null;
          reject(new Error('The editor has not confirmed the save. Keep it open and try again.'));
        }, 60_000);
        const id = crypto.randomUUID();
        pending.current = { resolve, reject, timer, id };
        post('Action_Save', {
          DontTerminateEdit: true,
          DontSaveIfUnmodified: false,
          Notify: true,
          ExtendedData: id,
        });
      }).then(async (saveId) => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (!mounted.current) throw new Error('The editor closed before save confirmation.');
          const response = await fetch(`/api/office/${encodeURIComponent(session.documentId)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error('Could not verify the saved revision. Keep the editor open.');
          const result = await response.json();
          if (result.document?.lastWopiSave?.id === saveId) {
            onModified(false);
            return saveId;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(
          'The editor has not finished uploading your changes. Keep it open and try Save again.',
        );
      }),
  }));
  useEffect(() => {
    mounted.current = true;
    let acceptsHostMessages = false;
    const editorWindow = frame.current?.contentWindow;
    const receive = (event: MessageEvent) => {
      if (event.origin !== session.serverUrl || event.source !== frame.current?.contentWindow) return;
      let message: any;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (message?.MessageId === 'App_LoadingStatus') {
        acceptsHostMessages = true;
        post('Host_PostmessageReady');
        if (message.Values?.Status === 'Document_Loaded') onReady(true);
      }
      if (message?.MessageId === 'Action_Load_Resp') {
        if (message.Values?.success) onReady(true);
        else onError(message.Values?.errorMsg || 'The document could not be opened.');
      }
      if (message?.MessageId === 'Doc_ModifiedStatus') onModified(Boolean(message.Values?.Modified));
      if (message?.MessageId === 'Action_Save_Resp' && pending.current) {
        const waiting = pending.current;
        pending.current = null;
        clearTimeout(waiting.timer);
        if (message.Values?.success || message.Values?.result === 'unmodified') {
          waiting.resolve(waiting.id);
        } else waiting.reject(new Error(message.Values?.errorMsg || 'The editor could not save this copy.'));
      }
    };
    window.addEventListener('message', receive);
    form.current?.submit();
    return () => {
      if (acceptsHostMessages)
        editorWindow?.postMessage(
          JSON.stringify({ MessageId: 'Close_Session', SendTime: Date.now(), Values: {} }),
          session.serverUrl,
        );
      mounted.current = false;
      window.removeEventListener('message', receive);
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.reject(new Error('The editor closed before saving.'));
        pending.current = null;
      }
    };
  }, [session, onReady, onModified, onError, post]);
  return (
    <>
      <form ref={form} action={session.editorUrl} method="post" target={name} className="hidden">
        <input type="hidden" name="access_token" value={session.accessToken} />
        <input type="hidden" name="access_token_ttl" value={session.accessTokenTtl} />
      </form>
      <iframe
        ref={frame}
        name={name}
        title="Document editor"
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; fullscreen"
        onLoad={() => post('Host_PostmessageReady')}
      />
    </>
  );
});
