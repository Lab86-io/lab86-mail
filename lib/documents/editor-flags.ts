import { envFlag, isDevelopmentRuntime } from '@/lib/hosted/controls';

/**
 * Rollout flags for the editor work. Each flag is independent. In development both
 * default on; production requires an explicit opt-in.
 * An explicit `true` or `false` in the environment always wins.
 */
function flag(name: string) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return isDevelopmentRuntime();
  return envFlag(name);
}

/** Themed, compact Collabora chrome with Albatross controls. */
export function isThemedOfficeChromeEnabled() {
  return flag('OFFICE_THEMED_CHROME');
}

const ALL_USERS = new Set(['1', 'true', 'yes', 'all']);
const NO_USERS = new Set(['0', 'false', 'no']);

/**
 * Version 2 slide authoring: rich elements, deck themes, designed generation.
 * `DECK_V2_AUTHORING` takes a boolean, `all`, or a comma list of user ids, so a
 * rollout can start with one user. An empty value follows the runtime default.
 */
export function isDeckV2AuthoringEnabled(userId?: string | null) {
  const raw = process.env.DECK_V2_AUTHORING?.trim();
  if (!raw) return isDevelopmentRuntime();
  const word = raw.toLowerCase();
  if (ALL_USERS.has(word)) return true;
  if (NO_USERS.has(word)) return false;
  return Boolean(userId) && raw.split(',').some((entry) => entry.trim() === userId);
}

/**
 * Client-side view of the authoring flag: the rich tools of the presentation
 * editor. Public variables are inlined per build, so this flag has no user
 * list: an id here would go to each browser. Set `NEXT_PUBLIC_DECK_V2_AUTHORING`
 * explicitly for production builds. Development defaults on.
 */
export function isDeckV2AuthoringEnabledOnClient() {
  const raw = process.env.NEXT_PUBLIC_DECK_V2_AUTHORING;
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'development';
  return ALL_USERS.has(raw.trim().toLowerCase());
}
