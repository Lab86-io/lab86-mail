'use client';

import { useClerk } from '@clerk/nextjs';
import { useEffect, useRef, useState } from 'react';
import { completeNativeBrowserSignIn } from '@/lib/native/browser-session';

type BridgeWindow = Window & {
  lab86OpenEditor?: (input: { ticket: string; userId: string; destination: string }) => Promise<void>;
  webkit?: { messageHandlers?: { albatrossEditor?: { postMessage: (body: unknown) => void } } };
};

export function NativeSessionBootstrap() {
  const clerk = useClerk();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!clerk.loaded || !clerk.client) return;
    const bridge = window as BridgeWindow;
    const report = (body: unknown) => bridge.webkit?.messageHandlers?.albatrossEditor?.postMessage(body);
    bridge.lab86OpenEditor = async ({ ticket, userId, destination }) => {
      if (started.current) return;
      started.current = true;
      try {
        const path = await completeNativeBrowserSignIn(
          { ticket, userId, destination },
          {
            signIn: (ticket) => clerk.client!.signIn.create({ strategy: 'ticket', ticket }),
            reportSession: (sessionId) => report({ type: 'session', sessionId }),
            activate: async (session) => {
              await clerk.setActive({ session });
              return clerk.user?.id;
            },
          },
        );
        window.location.replace(path);
      } catch {
        setFailed(true);
        report({ type: 'error', message: 'The editor could not sign in. Close it and try again.' });
      }
    };
    report({ type: 'ready' });
    return () => {
      delete bridge.lab86OpenEditor;
    };
  }, [clerk]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-6" aria-live="polite">
      <p>{failed ? 'The editor could not sign in. Close it and try again.' : 'Opening your workspace…'}</p>
    </main>
  );
}
