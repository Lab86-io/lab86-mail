import { readFileSync } from 'node:fs';
import { api, convexMutation } from '../lib/hosted/convex';

/**
 * Remove synthetic `office-verification-*` owners left by the live Collabora
 * checks. Pass a file with one owner id per line, or rely on the sessions
 * file the prepare script wrote. Refuses any id without the synthetic prefix.
 */
const source = process.argv[2] || '/tmp/chat-doc-collabora-sessions.json';
const ids = source.endsWith('.json')
  ? [String(JSON.parse(readFileSync(source, 'utf8')).userId)]
  : readFileSync(source, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
for (const userId of ids) {
  if (!userId.startsWith('office-verification-'))
    throw new Error(`Refusing to delete non-synthetic owner ${userId}`);
  const counts = await convexMutation<Record<string, number>>(api.accounts.deleteUserCascade, {
    userId,
  });
  console.log(userId, JSON.stringify(counts));
}
