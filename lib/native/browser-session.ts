import { nativeBrowserDestination } from './browser-destination';

interface NativeSessionInput {
  ticket: string;
  userId: string;
  destination: string;
}
interface SessionActions {
  signIn: (ticket: string) => Promise<{ status: string | null; createdSessionId: string | null }>;
  reportSession: (sessionId: string) => void;
  activate: (sessionId: string) => Promise<string | null | undefined>;
}

/** Credentials stay in memory; navigation happens only after verifying the activated account. */
export async function completeNativeBrowserSignIn(input: NativeSessionInput, actions: SessionActions) {
  const path = nativeBrowserDestination(input.destination);
  if (!path || !input.ticket || !input.userId) throw new Error('Invalid editor destination.');
  const attempt = await actions.signIn(input.ticket);
  if (attempt.status !== 'complete' || !attempt.createdSessionId)
    throw new Error('Editor sign-in was not completed.');
  // The app must be able to revoke even when activation fails.
  actions.reportSession(attempt.createdSessionId);
  const userId = await actions.activate(attempt.createdSessionId);
  if (userId !== input.userId) throw new Error('Editor account mismatch.');
  return path;
}
